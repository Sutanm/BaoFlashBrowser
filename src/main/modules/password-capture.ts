// CDP password capture — keep debugger attached (aligned with working demos)
import type { WebContents } from 'electron';
import log from 'electron-log';
import { getMainWindow } from './window';
import { getMetaForHost, getDecryptedPassword, isAutoCaptureEnabled, isCaptureExcluded } from './password-store';
import { credentialOrigin, redactUrlForLog } from '@shared/utils/url-privacy';
import { acquireCdpLease, type CdpLease } from './cdp-lease';
import { CAPTURE_SCRIPT } from './password-capture-script';

interface CaptureMessageParams {
  context?: { id?: unknown };
  executionContextId?: unknown;
  name?: unknown;
  payload?: unknown;
}

interface CaptureState {
  wc: WebContents;
  destroyed: boolean;
  injectTimer: ReturnType<typeof setTimeout> | null;
  contexts: Set<number>;
  injectedContexts: Set<number>;
  retryContexts: Set<number>;
  messageListener: (_event: Electron.Event, method: string, params: CaptureMessageParams) => void;
  capturedSet: Set<string>;
  cdpLease: CdpLease;
}

export function addBoundedCaptureKey(keys: Set<string>, key: string, maxSize = 200): void {
  if (maxSize <= 0) return;
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
  return [...state.contexts];
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

function sendToRenderer(channel: string, payload: Record<string, unknown>): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

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
    teardownCapture(wc);
    return;
  }
  if (!isAutoCaptureEnabled()) {
    teardownCapture(wc);
    return;
  }
  if (isCaptureExcluded(wc.getURL())) {
    log.info('[PasswordCapture] excluded site, wc.id=' + wc.id + ' url=' + redactUrlForLog(wc.getURL()));
    teardownCapture(wc);
    return;
  }

  log.info('[PasswordCapture] setupCapture wc=' + wc.id + ' url=' + redactUrlForLog(wc.getURL()));

  // 强制清理旧 state（对齐 bv demo 的 detach+reattach 模式）
  const existing = captures.get(wc.id);
  if (existing) {
    if (!existing.destroyed && !existing.cdpLease.released && wc.debugger.isAttached()) return;
    teardownCapture(wc);
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
    contexts: new Set(),
    injectedContexts: new Set(),
    retryContexts: new Set(),
    messageListener: () => {},
    capturedSet: new Set(),
    cdpLease,
  };
  log.info('[PasswordCapture] attached, wc.id=' + wc.id);

  state.messageListener = (_event, method, params) => {
    if (state.destroyed) return;
    if (method === 'Runtime.executionContextCreated' && typeof params?.context?.id === 'number') {
      const ctxId = params.context.id;
      state.contexts.add(ctxId);
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
    if (method !== 'Runtime.bindingCalled' || params?.name !== '__baopReport' || typeof params.payload !== 'string') return;
    for (const text of [params.payload]) {
      if (!text.startsWith('{"_type":"baop_')) continue;
      try {
        const data = JSON.parse(text);
        if (data._type === 'baop_diag') {
          log.info('[PasswordCapture] DIAG: ' + data.msg);
          continue;
        }
        if (data._type !== 'baop_capture') continue;
        // 用户名允许为空（对齐 Chrome）：部分登录页先填密码、用户名由站点 JS 后补，或压根没有
        // 用户名框（卡号/手机号/邮箱即账号）。此前 `!data.user` 会让这类登录静默不弹提示。
        if (!data.pass || String(data.pass).length < 2) continue;
        const username = typeof data.user === 'string' ? data.user : '';
        if (isCaptureExcluded(String(data.origin || data.host || ''))) continue;
        const key = `${data.host}/${username}`;
        if (state.capturedSet.has(key)) continue;

        let skipToast = shownToastKeys.has(key);
        if (skipToast) {
          log.info('[PasswordCapture] skip already-shown-toast host=' + data.host);
        }

        if (!skipToast) addBoundedCaptureKey(state.capturedSet, key);
        const captureId = 'cap_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        if (!skipToast) {
          globalPendingCredentials.set(captureId, {
            host: data.host,
            username,
            password: data.pass,
            origin: credentialOrigin(String(data.origin || ''), String(data.host || '')),
            title: data.title || '',
            timestamp: Date.now(),
          });
        }

        // 已保存账号查重（2026-09-22 起对齐 Chrome 的"变了才提示"）：
        //   同账号 + 同密码 → 静默跳过（重复登录不必再问一次）
        //   同账号 + 密码已变 → 照常提示（save-confirm 会覆盖旧条目，即"更新密码"）
        //   解不出明文（密钥不可用）→ 沿用旧的静默行为，不误报成"新密码"
        // 此前一律静默，用户无法区分"没捕获"和"已保存过"，是多次误判成功能坏了的直接来源。
        if (!skipToast) {
          try {
            const saved = getMetaForHost(data.host).find((e) => e.username === username);
            if (saved) {
              const known = getDecryptedPassword(saved.id);
              if (known === null) {
                log.info('[PasswordCapture] skip already-saved host=' + data.host + ' (key unavailable)');
                skipToast = true;
              } else if (known === String(data.pass)) {
                log.info('[PasswordCapture] skip already-saved host=' + data.host + ' (same password)');
                skipToast = true;
              } else {
                log.info('[PasswordCapture] password changed host=' + data.host + ' — prompting update');
              }
            }
          } catch { /* password-store 未初始化时忽略 */ }
        }

        // Workaround for 7k7k JSONP stuck: debugger attached may block <script> onload callback execution.
        // ⚠️ detach 必须在 toast 决策之后、continue 之前执行，无论是否显示 toast 都要 detach
        const needsDetach = ['script-src', 'script-mo', 'img-src', 'beacon', 'fetch', 'xhr', 'form.submit', 'click-login'].includes(String(data.source || ''));
        if (needsDetach) {
          log.info('[PasswordCapture] detach after capture source=' + data.source + ' (unblock JSONP callback)');
          detachQuietly(state);
        }

        if (skipToast) {
          globalPendingCredentials.delete(captureId);
          continue;
        }

        shownToastKeys.set(key, { captureId, timestamp: Date.now() });
        sendToRenderer('password:captured', { captureId, host: data.host, username });
        log.info('[PasswordCapture] captured host=' + data.host + ' source=' + data.source);
        // LRU：超过 50 条删最早的（removePendingCredential 里也会兜底）
        if (globalPendingCredentials.size > 50) { const fk = globalPendingCredentials.keys().next().value; if (fk) globalPendingCredentials.delete(fk); }
      } catch { /* ignore detach errors */ }
    }
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

export function teardownCapture(wc: WebContents): void {
  if (!wc) return;
  // 即使当前没有捕获状态，也要清掉挂起中的附着重试（自动化占位/标签页关闭都走这里）。
  clearAttachRetry(wc.id);
  const state = captures.get(wc.id); if (!state) return;
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
  sendToRenderer('password:changed', { ts: Date.now() });
}
