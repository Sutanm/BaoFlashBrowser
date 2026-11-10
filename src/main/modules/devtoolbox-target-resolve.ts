import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import log from 'electron-log';
import type { DevToolsTargetResult } from '@shared/types/devtoolbox';
import { resolveDebugPort } from './devtoolbox-targets';
import { acquireCdpLease } from './cdp-lease';
import { withTimeout } from '../utils/with-timeout';
import { getFocusedRegisteredWindow, getWindowById } from './window';
import { redactUrlForLog } from '@shared/utils/url-privacy';
import { ensureFrontendServer, getDevToolsFrontendDir, useBridge, useLegacyHttp } from './devtoolbox-frontend-server';
import { tabManager, getTabManagerForWindow } from './tabs';

function managerFor(winId?: number | null) {
  return winId == null ? tabManager : getTabManagerForWindow(winId);
}

const targetIds = new WeakMap<Electron.WebContents, string>();
const pendingTargetIds = new WeakMap<Electron.WebContents, Promise<string | null>>();

async function inspectTargetId(wc: Electron.WebContents): Promise<string | null> {
  let lease: ReturnType<typeof acquireCdpLease> | undefined;
  try {
    // An existing capture/automation client can answer this read-only command.
    // Only detach if we acquired the debugger for this query.
    if (!wc.debugger.isAttached()) lease = acquireCdpLease(wc, 'devtools-target');
    const result = await withTimeout(wc.debugger.sendCommand('Target.getTargetInfo'), 1000, 'devtools target lookup');
    const id = result?.targetInfo?.targetId;
    if (wc.isDestroyed() || typeof id !== 'string' || !id) return null;
    targetIds.set(wc, id);
    return id;
  } catch {
    return null;
  } finally {
    lease?.release();
  }
}

function targetIdFor(wc: Electron.WebContents | null | undefined): Promise<string | null> {
  if (!wc || wc.isDestroyed()) return Promise.resolve(null);
  const cached = targetIds.get(wc);
  if (cached) return Promise.resolve(cached);
  const pending = pendingTargetIds.get(wc);
  if (pending) return pending;
  const lookup = inspectTargetId(wc).finally(() => pendingTargetIds.delete(wc));
  pendingTargetIds.set(wc, lookup);
  return lookup;
}

export async function pickTargetForTab(tabId: string, winId?: number | null): Promise<string | null> {
  const manager = managerFor(winId);
  const wc = manager?.getWebContents(tabId);
  const id = await targetIdFor(wc);
  return wc && managerFor(winId)?.getWebContents(tabId) === wc ? id : null;
}

/**
 * 解析失败原因。`bridge-attach` 会把它原样回给渲染层，渲染层据此决定还要不要
 * 重试（见 `useDevToolsBridgeAttach`）。
 *
 * - `no-port`：调试端口/前端还没就绪，等一会儿就有了；
 * - `no-target`：标签是真页面，但 page target 还没注册（刚导航），值得重试；
 * - `no-view`：这个标签根本没有 BrowserView（about:newtab / 内置页），
 *   不可能有 page target，重试纯属空转。
 */
export type PageTargetFailure = 'no-port' | 'no-target' | 'no-view';

export interface PageTargetResolution {
  targetId: string | null;
  reason: 'ok' | PageTargetFailure;
}

/**
 * 上一次解析结论（每标签一条）。
 *
 * 桥的热切换在目标没准备好时会退避重试十来次，每次都写一行"resolve … target=null"
 * 会把主日志刷满（用户实测：切到无视图的标签后 20s 内十几行）。解析结论没变就
 * 不再重复记，只在 状态/target/URL 真正变化时记一行。
 */
const lastResolveSignature = new Map<string, string>();

function logResolve(wanted: string, url: string, targetId: string | null, reason: 'ok' | PageTargetFailure): void {
  const signature = `${reason}|${targetId ?? 'null'}|${url}`;
  if (lastResolveSignature.get(wanted) === signature) return;
  // 标签会一直新建，给这张表一个上限，避免长会话里无界增长。
  if (lastResolveSignature.size > 256) lastResolveSignature.clear();
  lastResolveSignature.set(wanted, signature);
  // electron-log v4 **不支持 printf 占位符**：`log.info('…%s', x)` 只会把 x 追加到
  // 末尾（日志里出现字面量 `%s`）。这里一律用模板字符串。
  log.info(`[DevToolsBridge] resolve tab=${wanted.slice(-6)} url=${url ? redactUrlForLog(url) : '-'} → target=${targetId ? targetId.slice(0, 6) : 'null'} (${reason})`);
}

/** 按 WebContents 身份解析，两个窗口加载同一 URL 时也不会串台。 */
export async function resolveTargetId(target: 'page' | 'shell', tabId?: string | null, winId?: number | null): Promise<string | null> {
  if (target === 'shell') {
    if (!resolveDebugPort()) return null;
    const win = winId == null ? getFocusedRegisteredWindow() : getWindowById(winId);
    return targetIdFor(win?.webContents);
  }
  return resolveActivePageTargetId(tabId, winId);
}

/**
 * 解析标签的 page target，并把"为什么没解出来"一起带出来。
 *
 * 绑定表逻辑与 `getDevToolsTargetUrl` 共用（`pickTargetForTab`），避免两套
 * 解析漂移。
 */
export async function resolvePageTarget(tabId?: string | null, winId?: number | null): Promise<PageTargetResolution> {
  const port = resolveDebugPort();
  if (!port) return { targetId: null, reason: 'no-port' };
  const manager = managerFor(winId);
  const wanted = tabId ?? manager?.getActiveId();
  if (!wanted) return { targetId: null, reason: 'no-target' };
  const wc = manager?.getWebContents(wanted);
  if (!wc) {
    // 没有 BrowserView 的标签（about:newtab、用户脚本页…）不会有 page target。
    // 之前这里和"正在加载"混为一谈，渲染层于是按 no-target 退避重试到底。
    logResolve(wanted, '', null, 'no-view');
    return { targetId: null, reason: 'no-view' };
  }
  const url = wc.getURL();
  const targetId = await pickTargetForTab(wanted, winId);
  logResolve(wanted, url, targetId, targetId ? 'ok' : 'no-target');
  return { targetId, reason: targetId ? 'ok' : 'no-target' };
}

/** 只要 target id 时的薄封装（探针/快照等内部调用点）。 */
export async function resolveActivePageTargetId(tabId?: string | null, winId?: number | null): Promise<string | null> {
  return (await resolvePageTarget(tabId, winId)).targetId;
}

/** 为已解析的 WebContents 创建 DevTools 前端地址。 */
export async function getDevToolsTargetUrl(target: 'page' | 'shell', tabId?: string | null, winId?: number | null): Promise<DevToolsTargetResult> {
  const port = resolveDebugPort();
  if (!port) return { url: null, reason: 'no-port' };

  // 前端入口：默认走 file://（无静态服务端口，origin 恒定 → DevTools 设置能持久）；
  // 回退开关打开时走旧的 http 静态服务。
  const entry = path.join(getDevToolsFrontendDir(), 'devtools_app.html');
  let entryUrl: string | null = null;
  if (useLegacyHttp()) {
    const frontend = await ensureFrontendServer();
    if (frontend) entryUrl = `http://127.0.0.1:${frontend}/devtools_app.html`;
  } else if (fs.existsSync(entry)) {
    entryUrl = pathToFileURL(entry).toString();
  }
  if (!entryUrl) return { url: null, reason: 'no-port' };

  const pickedId = await resolveTargetId(target, tabId, winId);
  if (!pickedId) {
    return { url: null, reason: 'no-target' };
  }
  // 桥模式（B3 起为默认）：URL 不带 ws，前端用 preload 暴露的 `bfbBridge`
  //   → IPC → 主进程桥 → browser ws + flatten session。
  // **URL 里刻意不带 target id**：切标签时容器不重载，面板状态（Elements 选中、
  // Console 历史）得以保留；跟随新标签由渲染层重新调 bridge.attach() 完成
  // （桥重放域状态 + 发 DOM.documentUpdated）。
  if (useBridge()) {
    return {
      url: `${entryUrl}?can_dock=true`,
      reason: 'ok',
      mode: 'bridge',
      // 主进程要在 loadURL 之前拿它挂桥，见 attachDevToolsView。
      targetId: pickedId,
    };
  }
  // 默认（page-ws 直连）。入口用 devtools_app.html（只挂 AdvancedApp 停靠壳），
  // can_dock=true 是它的启用条件；showBoth → hideMain 的占位修正见
  // scripts/build-devtools-frontend.cjs 的 SOURCE_PATCHES 与文档 §8.1。
  return {
    url: `${entryUrl}?ws=127.0.0.1:${port}/devtools/page/${pickedId}&can_dock=true`,
    reason: 'ok',
    mode: 'ws',
  };
}
