import { BrowserView, BrowserWindow, type WebContents } from 'electron';
import path from 'path';
import log from 'electron-log';
import { DEVTOOLS_PARTITION } from './devtoolbox-frontend-server';
import { resolveDebugPort } from './devtoolbox-targets';
import { getDevToolsTargetUrl } from './devtoolbox-target-resolve';
import { getDevToolsBridge } from './devtoolbox-bridge';
import { getWindowById } from './window';

/**
 * 开发者工具箱的窗口容器（P4b）。
 *
 * 每个浏览器窗口拥有独立的内嵌前端 BrowserView / 独立窗口，互不覆盖：
 * 旧实现是模块级单例，第二个窗口 attach 会把第一个窗口的前端拆掉。
 */
const DEVTOOLS_WINDOW_CLOSED = 'devtoolbox:devtools-window-closed';

const devToolsWindows = new Map<number, BrowserWindow>();
const closingByCode = new Set<number>();

export async function openDevToolsWindow(winId: number, target: 'page' | 'shell' = 'page', tabId?: string | null): Promise<{ ok: boolean; error?: string }> {
  const existing = devToolsWindows.get(winId);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return { ok: true };
  }

  const host = getWindowById(winId);
  if (!host || host.isDestroyed()) return { ok: false, error: 'no-window' };

  const resolved = await getDevToolsTargetUrl(target, tabId, winId);
  if (!resolved.url) return { ok: false, error: resolved.reason };

  const bridge = getDevToolsBridge(winId);
  // 新的前端实例接管：旧实例的在途请求必须静默作废（理由见 beginFrontendSession）。
  bridge.beginFrontendSession();

  // 与内嵌视图同一套时序：桥没挂上就不要把前端放出来（理由见 attachDevToolsView）。
  const bridgeMode = resolved.mode === 'bridge';
  if (bridgeMode) {
    const port = resolveDebugPort();
    if (!port || !resolved.targetId) return { ok: false, error: 'no-port' };
    try {
      await bridge.attach(resolved.targetId, port);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('[DevToolbox] 独立窗口桥 attach 失败:', message);
      return { ok: false, error: 'bridge-attach-failed' };
    }
  }

  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 480,
    minHeight: 360,
    title: 'DevTools',
    backgroundColor: '#202124',
    autoHideMenuBar: true,
    webPreferences: {
      // 与内嵌视图同一个分区：白名单才管得到它（默认 session 不挂任何拦截器）
      partition: DEVTOOLS_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      ...(bridgeMode ? { preload: path.join(__dirname, 'devtools-preload.js') } : {}),
    },
  });
  devToolsWindows.set(winId, win);
  win.on('closed', () => {
    if (devToolsWindows.get(winId) === win) devToolsWindows.delete(winId);
    if (closingByCode.delete(winId)) return;
    const main = getWindowById(winId);
    if (main && !main.isDestroyed()) main.webContents.send(DEVTOOLS_WINDOW_CLOSED);
  });

  // 宿主窗口关掉时不能让独立窗口把应用吊住
  host.once('closed', () => closeDevToolsWindow(winId));

  await win.loadURL(resolved.url).catch((error: unknown) => {
    log.warn('[DevToolbox] 独立窗口加载失败:', error instanceof Error ? error.message : String(error));
  });
  return { ok: true };
}

export function closeDevToolsWindow(winId: number): void {
  const win = devToolsWindows.get(winId);
  if (!win || win.isDestroyed()) {
    devToolsWindows.delete(winId);
    return;
  }
  closingByCode.add(winId);
  devToolsWindows.delete(winId);
  win.close();
}

/**
 * 内嵌前端视图（去端口改造 B1：容器换代）。
 *
 * 用 BrowserView 承载前端而不是 iframe：前端因此成为**独立 WebContents**，
 * 不落在外壳的 frame 树里 —— 这是下一步切 file:// 时"无 parent + 独立分区 +
 * 分区级白名单"成立的前提（同源子帧能绕过 contextIsolation，规格铁律 B2）。
 *
 * bounds 由渲染层逐帧上报（与 tab 的 setBounds 同一形状），实测拖拽零延迟。
 */
interface EmbeddedDevToolsHost {
  view: BrowserView;
  contents: WebContents;
  boundsLog: number;
  boundsMissLog: number;
}

const embeddedHosts = new Map<number, EmbeddedDevToolsHost>();
const boundsMissLogged = new Set<number>();

export async function attachDevToolsView(winId: number, target: 'page' | 'shell' = 'page', tabId?: string | null): Promise<{ ok: boolean; error?: string }> {
  const main = getWindowById(winId);
  if (!main || main.isDestroyed()) return { ok: false, error: 'no-window' };

  const resolved = await getDevToolsTargetUrl(target, tabId, winId);
  if (!resolved.url) return { ok: false, error: resolved.reason };
  log.info(`[DevToolbox] attach embedded view window=${winId} target=${target} url=${resolved.url.slice(0, 60)}`);

  // 新容器 = 新前端实例：先把旧实例的在途请求静默作废，再挂桥、建视图。
  // 顺序不能反：旧请求的 id 空间作废之后，它们才不会在新实例里"认领"别人的请求。
  const bridge = getDevToolsBridge(winId);
  bridge.beginFrontendSession();

  // 桥模式必须**先挂桥再放前端出来**：preload 里的 onOpen 是立即回调的
  // （见 src/preload/devtools.ts），前端一起来就会连发十几条 enable/getDocument。
  // 若此时桥还没 session，这些命令全部落空，Elements 会空白且不会自愈。
  const bridgeMode = resolved.mode === 'bridge';
  if (bridgeMode) {
    const port = resolveDebugPort();
    if (!port || !resolved.targetId) return { ok: false, error: 'no-port' };
    try {
      await bridge.attach(resolved.targetId, port);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('[DevToolbox] 桥 attach 失败，前端不启动:', message);
      return { ok: false, error: 'bridge-attach-failed' };
    }
  }

  destroyDevToolsView(winId);
  const view = new BrowserView({
    webPreferences: {
      partition: DEVTOOLS_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // 只有桥模式需要这个 preload（它只暴露 bfbBridge，不含 electronAPI）。
      ...(bridgeMode ? { preload: path.join(__dirname, 'devtools-preload.js') } : {}),
    },
  });
  embeddedHosts.set(winId, { view, contents: view.webContents, boundsLog: 0, boundsMissLog: 0 });
  boundsMissLogged.delete(winId);
  main.addBrowserView(view);
  // 先给 1×1：等渲染层第一次上报矩形再对齐，避免首帧闪一下满屏
  view.setBounds({ x: 0, y: 0, width: 1, height: 1 });
  main.once('closed', () => destroyDevToolsView(winId));
  await view.webContents.loadURL(resolved.url).catch((error: unknown) => {
    log.warn('[DevToolbox] 内嵌前端视图加载失败:', error instanceof Error ? error.message : String(error));
  });
  return { ok: true };
}

export function setDevToolsViewBounds(winId: number, rect: { x: number; y: number; width: number; height: number }): void {
  const host = embeddedHosts.get(winId);
  if (!host) {
    // 每个窗口只记一次，避免频繁拖拽刷日志。
    if (!boundsMissLogged.has(winId)) {
      boundsMissLogged.add(winId);
      log.info(`[DevToolbox] bounds 上报但视图不存在 window=${winId}`);
    }
    return;
  }
  host.boundsMissLog += 1;
  if (host.boundsLog++ < (process.env.BAO_DEVTOOLS_BOUNDS_LOG === '1' ? 400 : 3)) {
    log.info(`[DevToolbox] bounds → window=${winId} x=${Math.round(rect.x)} y=${Math.round(rect.y)} w=${Math.round(rect.width)} h=${Math.round(rect.height)}`);
  }
  host.view.setBounds({
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  });
}

/**
 * 指定窗口的前端容器 WebContents（内嵌视图优先，其次独立窗口）。
 *
 * 桥的 IPC 需要它做两件事：校验消息来源（只认该窗口自己的前端），以及把
 * CDP 事件投递到正确的窗口。
 */
export function getDevToolsFrontendContents(winId: number): WebContents | null {
  const host = embeddedHosts.get(winId);
  if (host && !host.contents.isDestroyed()) return host.contents;
  const win = devToolsWindows.get(winId);
  if (win && !win.isDestroyed()) {
    const contents = win.webContents;
    if (contents && !contents.isDestroyed()) return contents;
  }
  return null;
}

export function destroyDevToolsView(winId: number): void {
  const host = embeddedHosts.get(winId);
  embeddedHosts.delete(winId);
  if (!host) return;
  const { view } = host;
  const main = getWindowById(winId);
  try {
    main?.removeBrowserView(view);
  } catch {
    // 窗口可能已经销毁
  }
  try {
    // Electron 11 的 d.ts 没有声明 destroy，但运行时存在（isDestroyed/destroy 都在），
    // 实测 typeof wc.destroy === 'function'。不用它的话 BrowserView 的 WebContents 会滞留。
    const disposable = view.webContents as unknown as { destroy?: () => void; isDestroyed?: () => boolean };
    if (!disposable.isDestroyed?.()) disposable.destroy?.();
  } catch {
    // 已销毁
  }
}

/** 仅测试用：清空所有窗口容器。 */
export function resetDevToolsHostsForTest(): void {
  for (const winId of [...embeddedHosts.keys()]) destroyDevToolsView(winId);
  for (const [winId] of [...devToolsWindows]) closeDevToolsWindow(winId);
}
