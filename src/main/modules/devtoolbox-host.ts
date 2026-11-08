import { BrowserView, BrowserWindow, type WebContents } from 'electron';
import path from 'path';
import log from 'electron-log';
import { DEVTOOLS_PARTITION } from './devtoolbox-frontend-server';
import { resolveDebugPort } from './devtoolbox-targets';
import { getDevToolsTargetUrl } from './devtoolbox-target-resolve';
import { devToolsBridge } from './devtoolbox-bridge';
import { getMainWindow } from './window';

/**
 * 独立窗口模式（dockSide = 'undocked'）：把前端整页放进一个独立 BrowserWindow。
 *
 * 与内嵌模式的差别：这里没有父页 frame 树，前端拿不到外壳的 window；窗口被用户关掉时
 * 通知外壳把停靠位置退回上一次的内嵌位置（关窗 = 回到内嵌，而非收起抽屉）。
 */
const DEVTOOLS_WINDOW_CLOSED = 'devtoolbox:devtools-window-closed';
let devToolsWindow: BrowserWindow | null = null;
let devToolsWindowClosingByCode = false;
let mainWindowCloseHooked = false;

export async function openDevToolsWindow(target: 'page' | 'shell' = 'page', tabId?: string | null): Promise<{ ok: boolean; error?: string }> {
  if (devToolsWindow && !devToolsWindow.isDestroyed()) {
    if (devToolsWindow.isMinimized()) devToolsWindow.restore();
    devToolsWindow.focus();
    return { ok: true };
  }

  const resolved = await getDevToolsTargetUrl(target, tabId);
  if (!resolved.url) return { ok: false, error: resolved.reason };

  // 新的前端实例接管：旧实例的在途请求必须静默作废（理由见 beginFrontendSession）。
  devToolsBridge.beginFrontendSession();

  // 与内嵌视图同一套时序：桥没挂上就不要把前端放出来（理由见 attachDevToolsView）。
  const bridge = resolved.mode === 'bridge';
  if (bridge) {
    const port = resolveDebugPort();
    if (!port || !resolved.targetId) return { ok: false, error: 'no-port' };
    try {
      await devToolsBridge.attach(resolved.targetId, port);
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
      ...(bridge ? { preload: path.join(__dirname, 'devtools-preload.js') } : {}),
    },
  });
  devToolsWindow = win;
  win.on('closed', () => {
    devToolsWindow = null;
    if (devToolsWindowClosingByCode) {
      devToolsWindowClosingByCode = false;
      return;
    }
    const main = getMainWindow();
    if (main && !main.isDestroyed()) main.webContents.send(DEVTOOLS_WINDOW_CLOSED);
  });

  const main = getMainWindow();
  if (main && !mainWindowCloseHooked) {
    mainWindowCloseHooked = true;
    // 主窗口关掉时不能让独立窗口把应用吊住
    main.once('closed', () => closeDevToolsWindow());
  }

  await win.loadURL(resolved.url).catch((error: unknown) => {
    log.warn('[DevToolbox] 独立窗口加载失败:', error instanceof Error ? error.message : String(error));
  });
  return { ok: true };
}

export function closeDevToolsWindow(): void {
  const win = devToolsWindow;
  if (!win || win.isDestroyed()) {
    devToolsWindow = null;
    return;
  }
  devToolsWindowClosingByCode = true;
  devToolsWindow = null;
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
let devToolsView: BrowserView | null = null;
/** 前端 WebContents 的旁路引用：IPC 层要做 sender 校验与事件投递，销毁后必须置空。 */
let devToolsViewContents: WebContents | null = null;
let devToolsViewCloseHooked = false;
let devToolsBoundsLog = 0;
let devToolsBoundsMissLog = 0;

export async function attachDevToolsView(target: 'page' | 'shell' = 'page', tabId?: string | null): Promise<{ ok: boolean; error?: string }> {
  const main = getMainWindow();
  if (!main || main.isDestroyed()) return { ok: false, error: 'no-window' };

  const resolved = await getDevToolsTargetUrl(target, tabId);
  if (!resolved.url) return { ok: false, error: resolved.reason };
  log.info('[DevToolbox] attach embedded view target=%s url=%s', target, resolved.url.slice(0, 60));
  devToolsBoundsLog = 0;
  devToolsBoundsMissLog = 0;

  // 新容器 = 新前端实例：先把旧实例的在途请求静默作废，再挂桥、建视图。
  // 顺序不能反：旧请求的 id 空间作废之后，它们才不会在新实例里"认领"别人的请求。
  devToolsBridge.beginFrontendSession();

  // 桥模式必须**先挂桥再放前端出来**：preload 里的 onOpen 是立即回调的
  // （见 src/preload/devtools.ts），前端一起来就会连发十几条 enable/getDocument。
  // 若此时桥还没 session，这些命令全部落空，Elements 会空白且不会自愈。
  const bridge = resolved.mode === 'bridge';
  if (bridge) {
    const port = resolveDebugPort();
    if (!port || !resolved.targetId) return { ok: false, error: 'no-port' };
    try {
      await devToolsBridge.attach(resolved.targetId, port);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('[DevToolbox] 桥 attach 失败，前端不启动:', message);
      return { ok: false, error: 'bridge-attach-failed' };
    }
  }

  destroyDevToolsView();
  const view = new BrowserView({
    webPreferences: {
      partition: DEVTOOLS_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // 只有桥模式需要这个 preload（它只暴露 bfbBridge，不含 electronAPI）。
      ...(bridge ? { preload: path.join(__dirname, 'devtools-preload.js') } : {}),
    },
  });
  devToolsView = view;
  devToolsViewContents = view.webContents;
  main.addBrowserView(view);
  // 先给 1×1：等渲染层第一次上报矩形再对齐，避免首帧闪一下满屏
  view.setBounds({ x: 0, y: 0, width: 1, height: 1 });
  if (!devToolsViewCloseHooked) {
    devToolsViewCloseHooked = true;
    main.once('closed', () => destroyDevToolsView());
  }
  await view.webContents.loadURL(resolved.url).catch((error: unknown) => {
    log.warn('[DevToolbox] 内嵌前端视图加载失败:', error instanceof Error ? error.message : String(error));
  });
  return { ok: true };
}

export function setDevToolsViewBounds(rect: { x: number; y: number; width: number; height: number }): void {
  const view = devToolsView;
  if (!view) {
    if (devToolsBoundsMissLog++ < 3) log.info('[DevToolbox] bounds 上报但视图不存在');
    return;
  }
  if (devToolsBoundsLog++ < (process.env.BAO_DEVTOOLS_BOUNDS_LOG === '1' ? 400 : 3)) {
    log.info('[DevToolbox] bounds → x=%s y=%s w=%s h=%s', Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height));
  }
  view.setBounds({
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  });
}

/**
 * 前端容器的 WebContents（内嵌视图优先，其次独立窗口）。
 *
 * 桥的 IPC 需要它做两件事：校验消息来源（只认前端自己），以及把 CDP 事件
 * 投递到正确的窗口（B3 之前是发给外壳 renderer，再由 postMessage 转进 iframe；
 * 现在前端自己就是终点）。
 */
export function getDevToolsFrontendContents(): WebContents | null {
  if (devToolsViewContents && !devToolsViewContents.isDestroyed()) return devToolsViewContents;
  if (devToolsWindow && !devToolsWindow.isDestroyed()) {
    const contents = devToolsWindow.webContents;
    if (contents && !contents.isDestroyed()) return contents;
  }
  return null;
}

export function destroyDevToolsView(): void {
  const view = devToolsView;
  devToolsView = null;
  devToolsViewContents = null;
  if (!view) return;
  const main = getMainWindow();
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
