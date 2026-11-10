// CDP password capture — keep debugger attached (aligned with working demos)
import crypto from 'crypto';
import type { WebContents } from 'electron';
import log from 'electron-log';
import { broadcastToRegisteredWindows, getWindowForWebContents } from './window';
import { getMetaForHost, getDecryptedPassword, isAutoCaptureEnabled, isCaptureExcluded } from './password-store';
import { redactUrlForLog } from '@shared/utils/url-privacy';
import { acquireCdpLease, type CdpLease } from './cdp-lease';
import { CAPTURE_SCRIPT } from './password-capture-script';

interface CaptureMessageParams {
  context?: { id?: unknown; origin?: unknown; auxData?: { isDefault?: boolean } };
  executionContextId?: unknown;
  name?: unknown;
  payload?: unknown;
}

interface CaptureState {
  wc: WebContents;
  destroyed: boolean;
  injectTimer: ReturnType<typeof setTimeout> | null;
  contexts: Map<number, URL | null>;
  injectedContexts: Set<number>;
  retryContexts: Set<number>;
  messageListener: (_event: Electron.Event, method: string, params: CaptureMessageParams) => void;
  /** 注入汇总行的定时器（一次性诊断），teardown 时必须清掉。 */
  readyTimer: ReturnType<typeof setTimeout> | null;
  capturedSet: Set<string>;
  cdpLease: CdpLease;
}

let resolveCaptureWindow = getWindowForWebContents;

export function setPasswordCaptureWindowResolver(resolver: typeof getWindowForWebContents): void {
  resolveCaptureWindow = resolver;
}

function httpUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export function addBoundedCaptureKey(keys: Set<string>, key: string, maxSize = 200): void {  if (maxSize <= 0) return;
  if (!keys.has(key) && keys.size >= maxSize) {
    const oldest = keys.values().next().value;
    if (oldest) keys.delete(oldest);
  }
  keys.add(key);
}

const captures = new Map<number, CaptureState>();

/**
 * 附着失败重试（2026-09-22）。
 *
 * `password-fill` 需要跨 execution context 求值，它会**直接** `wc.debugger.attach('1.3')`
 * （不经 cdp-lease），几十毫秒后自行 detach；捕获若恰好撞进这个窗口，`acquireCdpLease`
 * 会抛 `CDP is already attached by an unmanaged client`。此前捕获只打一行 warn 就返回，
 * **没有任何重试** —— 那个标签页此后完全无捕获（实测 wc=4 即如此）。
 *
 * 这里按递增间隔有限次重试：成功即清表（下次独立失败重新计数），失败到上限后放弃并留日志，
 * 不做无限自旋。定时器 unref，不阻止进程退出。
 */
const ATTACH_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 3000];
const attachRetries = new Map<number, { timer: ReturnType<typeof setTimeout>; attempts: number }>();

function clearAttachRetry(wcId: number): void {
  const pending = attachRetries.get(wcId);
  if (!pending) return;
  clearTimeout(pending.timer);
  attachRetries.delete(wcId);
}

function scheduleAttachRetry(wc: WebContents): void {
  const wcId = wc.id;
  const attempts = attachRetries.get(wcId)?.attempts ?? 0;
  if (attempts >= ATTACH_RETRY_DELAYS_MS.length) {
    clearAttachRetry(wcId);
    log.warn('[PasswordCapture] attach retries exhausted, wc.id=' + wcId);
    return;
  }
  if (attachRetries.has(wcId)) clearTimeout(attachRetries.get(wcId)!.timer);
  const delay = ATTACH_RETRY_DELAYS_MS[attempts];
  const timer = setTimeout(() => {
    // 保留计数（不要在这里删表），否则连续失败会退化成无限重试。
    if (wc.isDestroyed()) { clearAttachRetry(wcId); return; }
    log.info('[PasswordCapture] attach retry ' + (attempts + 1) + '/' + ATTACH_RETRY_DELAYS_MS.length + ' wc.id=' + wcId);
    setupCapture(wc);
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
  attachRetries.set(wcId, { timer, attempts: attempts + 1 });
}

/** Snapshot of frame execution contexts already discovered by the capture CDP session. */
export function getCaptureContextIds(wc: WebContents): number[] {
  const state = captures.get(wc.id);
  if (!state || state.destroyed) return [];
  return [...state.contexts.keys()];
}

// 待保存凭据 —— 模块级全局，不受 state 重建影响（JSONP 捕获后 detach → teardown → setupCapture，旧 state 的 pendingCreds 不丢）
const globalPendingCredentials = new Map<string, { host: string; username: string; password: string; origin: string; title: string; timestamp: number }>();

// 已弹出 toast 的 host+username 去重 —— 模块级全局，跨 detach→re-attach 会话
// 防止同一登录在 capture session 重建后被重复捕获并再次弹出 toast
const shownToastKeys = new Map<string, { captureId: string; timestamp: number }>();

// 密码 5 分钟 TTL 自动过期清理，防止内存泄漏
setInterval(() => {
  const now = Date.now();
  for (const [id, cred] of globalPendingCredentials.entries()) {
    if (now - cred.timestamp > 5 * 60 * 1000) {
      globalPendingCredentials.delete(id);
    }
  }
  for (const [key, val] of shownToastKeys.entries()) {
    if (now - val.timestamp > 5 * 60 * 1000) {
      shownToastKeys.delete(key);
    }
  }
}, 60 * 1000);

function detachQuietly(state: CaptureState): void {
  try { state.cdpLease.release(); } catch { /* ignore duplicate detach */ }
}

async function injectContext(state: CaptureState, contextId: number): Promise<void> {
  if (state.destroyed || state.wc.isDestroyed() || !state.contexts.has(contextId) || state.injectedContexts.has(contextId)) return;
  try {
    await state.wc.debugger.sendCommand('Runtime.evaluate', {
      expression: CAPTURE_SCRIPT,
      awaitPromise: false,
      contextId,
    });
    if (!state.destroyed && state.contexts.has(contextId)) {
      state.injectedContexts.add(contextId);
      state.retryContexts.delete(contextId);
    }
  } catch (error) {
    log.debug('[PasswordCapture] context injection failed; retry scheduled', {
      contextId,
      error: error instanceof Error ? error.message : String(error),
    });
    if (!state.destroyed && state.contexts.has(contextId) && state.wc.debugger.isAttached()) {
      state.retryContexts.add(contextId);
      scheduleFailedInjectionRetry(state, 4000);
    }
  }
}

function scheduleFailedInjectionRetry(state: CaptureState, delay: number): void {
  if (state.destroyed || state.wc.isDestroyed() || state.injectTimer || state.retryContexts.size === 0) return;
  state.injectTimer = setTimeout(async () => {
    state.injectTimer = null;
    if (state.destroyed || state.wc.isDestroyed()) return;
    if (!state.wc.debugger.isAttached()) {
      state.retryContexts.clear();
      return;
    }
    const failed = [...state.retryContexts];
    await Promise.all(failed.map((contextId) => injectContext(state, contextId)));
    if (state.retryContexts.size > 0) scheduleFailedInjectionRetry(state, 4000);
  }, delay);
}

export function setupCapture(wc: WebContents): void {
  if (!wc || wc.isDestroyed()) return;
  if (process.env.BAO_NO_CDP === '1') {
    teardownCapture(wc, 'cdp-disabled');
    return;
  }
  if (!isAutoCaptureEnabled()) {
    teardownCapture(wc, 'auto-capture-off');
    return;
  }
  if (isCaptureExcluded(wc.getURL())) {
    log.info('[PasswordCapture] excluded site, wc.id=' + wc.id + ' url=' + redactUrlForLog(wc.getURL()));
    teardownCapture(wc, 'excluded-site');
    return;
  }

  log.info('[PasswordCapture] setupCapture wc=' + wc.id + ' url=' + redactUrlForLog(wc.getURL()));

  // 强制清理旧 state（对齐 bv demo 的 detach+reattach 模式）
  const existing = captures.get(wc.id);
  if (existing) {
    if (!existing.destroyed && !existing.cdpLease.released && wc.debugger.isAttached()) return;
    teardownCapture(wc, 'restart');
  }

  let cdpLease: CdpLease;
  try { cdpLease = acquireCdpLease(wc, 'password-capture'); } catch (e) {
    log.warn('[PasswordCapture] attach failed:', (e instanceof Error ? e.message : 'Unknown error'));
    // 多为与 password-fill 的短命 debugger 客户端争抢，几十毫秒后即可拿到；见 scheduleAttachRetry。
    scheduleAttachRetry(wc);
    return;
  }
  clearAttachRetry(wc.id);

  const state: CaptureState = {
    wc,
    destroyed: false,
    injectTimer: null,
    contexts: new Map(),
    injectedContexts: new Set(),
    retryContexts: new Set(),
    messageListener: () => {},
    readyTimer: null,
    capturedSet: new Set(),
    cdpLease,
  };
  log.info('[PasswordCapture] attached, wc.id=' + wc.id);
  // 注入结论汇总（一次性）：contexts 里有多少个真正执行了捕获脚本。
  // 排查"某帧明明注入了却没反应"时，先看这行与 frame info 是否能对应上。
  state.readyTimer = setTimeout(() => {
    if (state.destroyed) return;
    log.info('[PasswordCapture] ready wc=' + wc.id + ' contexts=' + state.contexts.size + ' injected=' + state.injectedContexts.size
      + (state.retryContexts.size ? ' retrying=' + state.retryContexts.size : ''));
  }, 2000);
  if (typeof state.readyTimer.unref === 'function') state.readyTimer.unref();

  state.messageListener = (_event, method, params) => {
    if (state.destroyed) return;
    if (method === 'Runtime.executionContextCreated' && typeof params?.context?.id === 'number') {
      const ctxId = params.context.id;
      if (params.context.auxData?.isDefault === false) return;
      state.contexts.set(ctxId, httpUrl(params.context.origin));
      // Per-context diagnostics: CDP emits this for every frame and isolated
      // world, which flooded the log (~1.5k lines in a single session). Kept at
      // debug so it stays available without burying real events.
      log.debug('[PasswordCapture] context created: ' + ctxId + ' (total=' + state.contexts.size + ')');
      void injectContext(state, ctxId);
    }
    if (method === 'Runtime.executionContextDestroyed' && typeof params?.executionContextId === 'number') {
      state.contexts.delete(params.executionContextId);
      state.injectedContexts.delete(params.executionContextId);
      state.retryContexts.delete(params.executionContextId);
    }
    if (method === 'Runtime.executionContextsCleared') {
      state.contexts.clear();
      state.injectedContexts.clear();
      state.retryContexts.clear();
    }
    if (method !== 'Runtime.bindingCalled' || params?.name !== '__baopReport'
      || typeof params.payload !== 'string' || params.payload.length > 64 * 1024
      || typeof params.executionContextId !== 'number') return;
    const frameOrigin = state.contexts.get(params.executionContextId);
    if (!frameOrigin) return;
    try {
      const data = JSON.parse(params.payload);
      if (data?._type !== 'baop_capture' || typeof data.pass !== 'string' || data.pass.length < 2) return;
      const reportedUrl = httpUrl(data.origin);
      // Only CDP's execution context can establish which site owns the credential.
      if (!reportedUrl || reportedUrl.origin !== frameOrigin.origin || data.host !== frameOrigin.hostname) return;
      const host = frameOrigin.hostname;
      const username = typeof data.user === 'string' ? data.user : '';
      if (isCaptureExcluded(frameOrigin.origin)) return;
      const sourceWindow = resolveCaptureWindow(wc);
      if (!sourceWindow || sourceWindow.isDestroyed()) return;

      const key = host + '/' + username;
      if (state.capturedSet.has(key)) return;
      let skipToast = shownToastKeys.has(key);
      if (skipToast) {
        log.info('[PasswordCapture] skip already-shown-toast host=' + host);
      } else {
        addBoundedCaptureKey(state.capturedSet, key);
        try {
          const saved = getMetaForHost(host).find((entry) => entry.username === username);
          const known = saved ? getDecryptedPassword(saved.id) : null;
          const verdict = !saved ? 'no-entry'
            : known === null ? 'key-unavailable'
              : known === data.pass ? 'same-password' : 'password-changed';
          log.info('[PasswordCapture] dedupe host=' + host + ' verdict=' + verdict);
          if (verdict === 'key-unavailable') {
            log.info('[PasswordCapture] skip already-saved host=' + host + ' (key unavailable)');
            skipToast = true;
          } else if (verdict === 'same-password') {
            log.info('[PasswordCapture] skip already-saved host=' + host + ' (same password)');
            skipToast = true;
          } else if (verdict === 'password-changed') {
            log.info('[PasswordCapture] password changed host=' + host + ' — prompting update');
          }
        } catch { /* vault may not be initialized */ }
      }

      // Detach even when the prompt is suppressed, so 7k7k's JSONP can finish.
      if (['script-src', 'script-mo', 'img-src', 'beacon', 'fetch', 'xhr', 'form.submit', 'click-login'].includes(data.source)) {
        detachQuietly(state);
      }
      if (skipToast) return;

      const captureId = 'cap_' + crypto.randomBytes(16).toString('hex');
      globalPendingCredentials.set(captureId, {
        host,
        username,
        password: data.pass,
        origin: frameOrigin.origin,
        title: typeof data.title === 'string' ? data.title.slice(0, 200) : '',
        timestamp: Date.now(),
      });
      try {
        sourceWindow.webContents.send('password:captured', { captureId, host, username });
      } catch {
        globalPendingCredentials.delete(captureId);
        return;
      }
      shownToastKeys.set(key, { captureId, timestamp: Date.now() });
      log.info('[PasswordCapture] captured host=' + host);
      if (globalPendingCredentials.size > 50) {
        const oldest = globalPendingCredentials.keys().next().value;
        if (oldest) removePendingCredential(oldest);
      }
    } catch { /* malformed page payload or renderer gone */ }
  };
  wc.debugger.on('message', state.messageListener);
  captures.set(wc.id, state);

  wc.debugger.sendCommand('Runtime.addBinding', { name: '__baopReport' }).then(() =>
    wc.debugger.sendCommand('Runtime.enable')).then(() => {
    log.info('[PasswordCapture] Runtime.enable OK, injecting main frame');
    wc.debugger.sendCommand('Runtime.evaluate', { expression: CAPTURE_SCRIPT, awaitPromise: false }).catch((error) => {
      log.debug('[PasswordCapture] main-frame injection failed', error instanceof Error ? error.message : String(error));
    });
  }).catch((e: unknown) => {
    log.warn('[PasswordCapture] Runtime.enable failed:', (e instanceof Error ? e.message : 'Unknown error'));
    // 已经拿到 lease 却把失败 state 留在 captures 里，后续 setupCapture 会认为
    // “已 attach 且未释放”而永久跳过本标签页。这里主动释放并按 attach 失败的
    // 节奏重试；重试计数由 scheduleAttachRetry 保留，避免确定性失败无限循环。
    if (captures.get(wc.id) !== state) return;
    disposeCaptureState(state);
    scheduleAttachRetry(wc);
  });
}

export function teardownCapture(wc: WebContents, reason = 'explicit'): void {
  if (!wc) return;
  // 即使当前没有捕获状态，也要清掉挂起中的附着重试（自动化占位/标签页关闭都走这里）。
  clearAttachRetry(wc.id);
  const state = captures.get(wc.id); if (!state) return;
  // teardown 过去完全静默，于是"捕获什么时候没的"只能靠日志缺口倒推。
  // 这里记下原因，配合 `ready` 汇总行就能还原一次会话的完整生命周期。
  log.info('[PasswordCapture] teardown wc=' + wc.id + ' reason=' + reason);
  disposeCaptureState(state);
}

/** 只回收单个 capture 状态，不动 attach 重试表（重试路径需要保留计数）。 */
function disposeCaptureState(state: CaptureState): void {
  captures.delete(state.wc.id);
  state.destroyed = true;
  if (state.injectTimer) {
    clearTimeout(state.injectTimer);
    state.injectTimer = null;
  }
  if (state.readyTimer) {
    clearTimeout(state.readyTimer);
    state.readyTimer = null;
  }
  state.contexts.clear();
  state.injectedContexts.clear();
  state.retryContexts.clear();
  try { state.wc.debugger.removeListener('message', state.messageListener); } catch { /* local cleanup best effort */ }
  if (!state.wc.isDestroyed()) detachQuietly(state);
}

export function getPendingCredential(captureId: string): { host: string; username: string; password: string; origin: string; title: string; timestamp: number } | null {
  return globalPendingCredentials.get(captureId) || null;
}

export function removePendingCredential(captureId: string): void {
  globalPendingCredentials.delete(captureId);
  // 同步清理 shownToastKeys，下次相同 host+user 允许再次弹出的逻辑由 password-store 查重保证
  for (const [k, v] of shownToastKeys.entries()) {
    if (v.captureId === captureId) {
      shownToastKeys.delete(k);
      break;
    }
  }
  // LRU：超过 50 条删最早的
  if (globalPendingCredentials.size > 50) {
    const firstKey = globalPendingCredentials.keys().next().value;
    if (firstKey) globalPendingCredentials.delete(firstKey);
  }
}

// 通知 renderer 密码本数据变化（保存/删除/修改/重置后广播，面板自动刷新）
export function notifyPasswordChanged(): void {
  broadcastToRegisteredWindows('password:changed', { ts: Date.now() });
}


