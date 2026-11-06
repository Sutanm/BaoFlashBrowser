import { app, BrowserView, BrowserWindow, session, webContents as allWebContents, type WebContents } from 'electron';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import log from 'electron-log';
import type {
  DevToolEntry,
  DevToolFlashInfo,
  DevToolIssue,
  DevToolLevel,
  DevToolPageProbe,
  DevToolSnapshot,
  DevToolTargetInfo,
  DevToolsTargetResult,
} from '@shared/types/devtoolbox';
import { getCdpLeaseOwner } from './cdp-lease';
import { loadConfig } from './config';
import {
  classifyMainLog,
  clip,
  EntryBuffer,
  mapConsoleLevel,
} from './devtoolbox-buffer';
import { devToolsBridge } from './devtoolbox-bridge';
import { probeFramesDeep, type DeepProbe } from './devtoolbox-probe';
import {
  fetchTargets,
  resolveDebugPort,
  type DebugTarget,
} from './devtoolbox-targets';
import { resolveFlashPlugin } from './flash';
import { getMainWindow } from './window';
import { tabManager } from './tabs';

// 端点查询已抽到 devtoolbox-targets（打断与 devtoolbox-bridge 的循环依赖），
// 这里保留同名导出，外部引用（ipc / 探针风格调用）不用跟着改。
export { listDebugTargets, resolveDebugPort } from './devtoolbox-targets';

/**
 * 内置开发者工具箱的主进程采集管道。
 *
 * 刻意**不 attach CDP**：互斥只发生在 embedded client 之间——Electron 的
 * `webContents.debugger` 一个 WebContents 只能挂一个，密码捕获长期持有、
 * 自动化按短租约排队、password-fill 会几十毫秒裸 attach，工具箱再挤进去
 * 就会撞出 "already attached by an unmanaged client"（2026-09-22 事故）。
 * 注意：**远程 ws 客户端（抽屉 DevTools 前端的 page-ws）与 embedded 实测
 * 共存**（tools/devtools-spike/cdp-coexist-check.cjs + cdp-embedded-coexist.cjs，
 * 2026-11-06），面板开着不影响密码捕获/填充。
 *
 * 能拿到的能力：
 *  - 页面 + 外壳的控制台：`webContents.on('console-message')`（无 DevTools 也触发）
 *  - 主进程日志：electron-log 的 hooks（含 [PasswordCapture] / [Flash] / [Keyring]）
 *  - 求值与页面探测：`executeJavaScript`
 * 拿不到的：网络响应体、DOM/CSS 树、断点调试 → 由抽屉里的真 DevTools 前端兜底。
 */

const MAX_ENTRIES = 2000;
const FLUSH_INTERVAL_MS = 80;
const MAX_PER_FLUSH = 400;

let sequence = 0;
const buffer = new EntryBuffer(MAX_ENTRIES);
let flushTimer: NodeJS.Timeout | null = null;
let started = false;
let inLogHook = false;
const boundContents = new Set<number>();

function stringifyArg(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function mapWarnLevel(level: string): DevToolLevel {
  if (level === 'error') return 'error';
  if (level === 'warn') return 'warning';
  if (level === 'info') return 'info';
  return 'verbose';
}

function sendToRenderer(channel: string, payload: unknown): void {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (!wc || wc.isDestroyed()) return;
  try {
    wc.send(channel, payload);
  } catch {
    // 渲染层正在销毁时静默丢弃：绝不能在管道里再次写日志（会递归回 hook）
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (buffer.pending === 0) return;
    const batch = buffer.takePending(MAX_PER_FLUSH);
    sendToRenderer('devtoolbox:entries', batch);
    if (buffer.pending > 0) scheduleFlush();
  }, FLUSH_INTERVAL_MS);
}

interface EmitInput {
  source: DevToolEntry['source'];
  level: DevToolLevel;
  text: string;
  origin?: string;
  tabId?: string;
  issue?: DevToolIssue;
}

function emit(input: EmitInput): void {
  const entry: DevToolEntry = {
    id: ++sequence,
    ts: Date.now(),
    source: input.source,
    level: input.level,
    text: clip(input.text),
    origin: input.origin,
    tabId: input.tabId,
    issue: input.issue,
  };
  buffer.push(entry);
  scheduleFlush();
}

function describeContents(wc: WebContents): { source: DevToolEntry['source']; tabId?: string } {
  const shell = getMainWindow()?.webContents;
  if (shell && !shell.isDestroyed() && shell.id === wc.id) return { source: 'shell' };
  const tabId = tabManager.getTabIdForWebContents(wc.id);
  return tabId ? { source: 'page', tabId } : { source: 'page' };
}

function isDevToolsContents(wc: WebContents): boolean {
  try {
    const url = wc.getURL();
    return url.startsWith('devtools://') || url.startsWith('chrome-devtools://');
  } catch {
    return false;
  }
}

function bindWebContents(wc: WebContents): void {
  if (boundContents.has(wc.id) || wc.isDestroyed()) return;
  boundContents.add(wc.id);
  const type = wc.getType();
  if (type !== 'browserView' && type !== 'window') return;

  wc.on('console-message', (_event, level, message, line, sourceId) => {
    if (isDevToolsContents(wc)) return;
    const { source, tabId } = describeContents(wc);
    const origin = sourceId ? `${sourceId}:${line}` : undefined;
    emit({ source, level: mapConsoleLevel(level), text: message, origin, tabId, issue: 'console' });
  });
  wc.once('destroyed', () => boundContents.delete(wc.id));
}

/** 主进程日志 → 工具箱。过滤掉自己的写入，避免递归。 */
function bindMainLog(): void {
  log.hooks.push((message, transport) => {
    if (inLogHook || transport !== log.transports.console) return message;
    const text = (message.data as unknown[]).map(stringifyArg).join(' ');
    if (!text) return message;
    inLogHook = true;
    try {
      emit({
        source: 'main',
        level: mapWarnLevel(message.level),
        text,
        origin: message.scope?.label,
        issue: classifyMainLog(text),
      });
    } finally {
      inLogHook = false;
    }
    return message;
  });
}

export function initDevToolbox(): void {
  if (started) return;
  started = true;
  bindMainLog();
  app.on('web-contents-created', (_event, wc) => bindWebContents(wc));
  for (const wc of allWebContents.getAllWebContents()) bindWebContents(wc);
  // 前端分区的 file:// 白名单要在任何视图/窗口加载之前装好
  if (!useLegacyHttp()) installDevToolsFileGuard();
  log.info('[DevToolbox] console + log pipeline ready (no CDP lease taken)');
}

export function clearDevToolEntries(): void {
  buffer.clear();
  sendToRenderer('devtoolbox:cleared', { ts: Date.now() });
}

function readMmsCfg(pluginPath: string | null): string {
  if (!pluginPath) return '';
  const target = path.join(path.dirname(pluginPath), 'mms.cfg');
  try {
    return fs.readFileSync(target, 'utf-8').trim();
  } catch {
    return '';
  }
}

function buildFlashInfo(): DevToolFlashInfo {
  const config = loadConfig();
  const resolution = resolveFlashPlugin(app, config.flashPluginChannel, config.flashVersion);
  return {
    pluginPath: resolution.pluginPath,
    version: resolution.version,
    channel: `${resolution.requestedChannel} → ${resolution.effectiveChannel}`,
    source: resolution.source,
    fallbackReason: resolution.fallbackReason ?? null,
    mmsCfg: readMmsCfg(resolution.pluginPath),
    ua: (() => {
      try {
        return getMainWindow()?.webContents.getUserAgent() ?? '';
      } catch {
        return '';
      }
    })(),
  };
}

function collectTargets(): DevToolTargetInfo[] {
  const targets: DevToolTargetInfo[] = [];
  for (const wc of allWebContents.getAllWebContents()) {
    if (wc.isDestroyed() || isDevToolsContents(wc)) continue;
    const type = wc.getType();
    if (type !== 'browserView' && type !== 'window') continue;
    const { source, tabId } = describeContents(wc);
    targets.push({
      id: wc.id,
      kind: source === 'shell' ? 'shell' : 'page',
      tabId,
      url: (() => { try { return wc.getURL(); } catch { return ''; } })(),
      title: (() => { try { return wc.getTitle(); } catch { return ''; } })(),
    });
  }
  return targets;
}

/** `tabId` 由渲染层给（理由同 `probeActivePage`）：主进程的活动标签比渲染层晚一拍。 */
export function getDevToolSnapshot(tabId?: string | null): DevToolSnapshot {
  const resolvedId = tabId ?? tabManager.getActiveId();
  const activeWc = resolvedId ? tabManager.getWebContents(resolvedId) : null;
  return {
    entries: buffer.snapshot(),
    targets: collectTargets(),
    flash: buildFlashInfo(),
    cdpOwner: activeWc ? getCdpLeaseOwner(activeWc.id) : null,
    activeTabId: resolvedId,
  };
}

export function openNativeDevTools(target: 'page' | 'shell'): boolean {
  try {
    if (target === 'shell') {
      const win = getMainWindow();
      if (!win || win.isDestroyed()) return false;
      win.webContents.openDevTools({ mode: 'detach' });
      return true;
    }
    const tabId = tabManager.getActiveId();
    if (!tabId) return false;
    tabManager.openDevTools(tabId);
    return true;
  } catch (error) {
    log.warn('[DevToolbox] openNativeDevTools failed:', error instanceof Error ? error.message : String(error));
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * 真 DevTools 前端托管
 *
 * 前端资源随应用分发（`assets/devtools-frontend`，取自 chii 的构建产物，
 * 面板版本约 M97）。
 *
 * 为什么用本地 HTTP 而不是自定义协议：外壳渲染层本身是 `file://`，
 * Chromium 11 会拒绝 file 源加载私有 scheme 的子帧（实测 iframe 直接变成
 * `chrome-error://chromewebdata/`，fetch 报 Failed to fetch）。本地 HTTP 是
 * 唯一走得通的路。服务只监听 127.0.0.1，端口由系统分配。
 * ------------------------------------------------------------------ */

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function getDevToolsFrontendDir(): string {
  // 打包版走 resources/；开发版读构建产物（scripts/build-devtools-frontend.cjs 生成）。
  return app.isPackaged
    ? path.join(process.resourcesPath, 'devtools-frontend')
    : path.join(app.getAppPath(), 'dist', 'devtools-frontend');
}

/** 前端独占的存储分区：与外壳隔离，且 `persist:` 前缀保证跨启动保留。 */
export const DEVTOOLS_PARTITION = 'persist:devtools';

/** 回退开关：走旧的 http 静态服务 + iframe 路径（见规格 §8）。 */
function useLegacyHttp(): boolean {
  // B3 之后容器统一为 BrowserView，http 静态服务只在排障时用。
  // 注意：这条路径没有 devtools-preload，所以必然落到 page-ws（见 useBridge）。
  return process.env.BAO_DEVTOOLS_LEGACY_HTTP === '1';
}

/**
 * 传输模式：默认走 CDP 桥（B3）。
 *
 * 桥的价值只有一个，但足够：**URL 恒定**。切标签只换桥的 flatten session，
 * 前端不重载，Elements 选中、Console 历史、Network 记录都留在原地；page-ws
 * 的 URL 必须带 target id，切标签就等于整页刷新。
 *
 * 回退：`BAO_DEVTOOLS_PAGE_WS=1` 回到前端直连 CDP 端口（URL 带 ws）。
 * 旧 http 容器没有 preload，无法提供 `bfbBridge`，故一律 page-ws。
 */
function useBridge(): boolean {
  return process.env.BAO_DEVTOOLS_PAGE_WS !== '1' && !useLegacyHttp();
}

/**
 * 把 file:// 请求限制在"前端自己的目录"里。
 *
 * 为什么必须挂在这个分区上而不是默认 session：默认 session 里跑着外壳与标签页，
 * 一挂就会连用户打开的本地 html / swf 一起拦掉（实测 ERR_ACCESS_DENIED）。
 * 而前端是同源页面，能 `fetch('file:///C:/…')` 读整个磁盘、还能爬到 parent 的
 * electronAPI —— 分区隔离 + 路径白名单是把它关回笼子的手段。
 *
 * 比较前对两端都做 realpath + 小写归一化（防 `..` 与 Windows junction 绕过）。
 */
let fileGuardInstalled = false;

function normalizeForCompare(target: string): string {
  try {
    return fs.realpathSync.native(target).toLowerCase();
  } catch {
    return path.resolve(target).toLowerCase();
  }
}

export function installDevToolsFileGuard(): void {
  if (fileGuardInstalled) return;
  fileGuardInstalled = true;

  const root = normalizeForCompare(getDevToolsFrontendDir());
  const frontendSession = session.fromPartition(DEVTOOLS_PARTITION);
  const registered = frontendSession.protocol.interceptFileProtocol('file', (request, callback) => {
    let local = '';
    try {
      local = normalizeForCompare(decodeURIComponent(fileURLToPath(request.url)));
    } catch {
      local = '';
    }
    if (local && (local === root || local.startsWith(root + path.sep))) {
      callback({ path: fileURLToPath(request.url) });
      return;
    }
    log.warn('[DevToolbox] 前端分区拒绝越界 file 请求:', request.url.slice(0, 120));
    callback({ error: -10 }); // net::ERR_ACCESS_DENIED
  });
  log.info('[DevToolbox] file guard on %s registered=%s root=%s', DEVTOOLS_PARTITION, registered, root);
}

let frontendPort: number | null = null;
let frontendServer: http.Server | null = null;

function ensureFrontendServer(): Promise<number | null> {
  if (frontendPort) return Promise.resolve(frontendPort);
  const root = path.resolve(getDevToolsFrontendDir());
  if (!fs.existsSync(path.join(root, 'inspector.html'))) {
    log.warn('[DevToolbox] devtools frontend assets missing at', root);
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      try {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'inspector.html';
        const target = path.resolve(root, relative);
        if (!target.startsWith(root) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
          response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
          return;
        }
        response.writeHead(200, {
          'content-type': MIME_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
          'cache-control': 'no-store',
        });
        fs.createReadStream(target).pipe(response);
      } catch {
        response.writeHead(500).end('error');
      }
    });
    server.once('error', (error) => {
      log.warn('[DevToolbox] devtools frontend server failed:', error instanceof Error ? error.message : String(error));
      resolve(null);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { resolve(null); return; }
      frontendServer = server;
      frontendPort = address.port;
      log.info('[DevToolbox] devtools frontend served on 127.0.0.1:' + frontendPort);
      resolve(frontendPort);
    });
  });
}

export function shutdownDevToolsFrontendServer(): void {
  frontendServer?.close();
  frontendServer = null;
  frontendPort = null;
}

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

/**
 * tabId → CDP page targetId 绑定表。
 *
 * Chromium 的 page target id 在同一 WebContents 生命周期内**恒定**（跨导航不变），
 * 所以绑一次就能一直用：切标签换 targetId（iframe 重连）、同标签内导航 targetId
 * 不变（iframe 不重载，前端经 CDP 事件自动跟随新页面，面板状态保留——与真
 * Chrome DevTools 行为一致）。
 *
 * 绑定只能在 tab 创建/首次需要时按 URL 匹配建立（Electron 11 没有暴露
 * webContents ↔ targetId 的映射 API，`webContents.debugger.attach` 又会抢
 * password-fill 的 CDP 租约）。读绑定时校验 targetId 仍在 /json/list 里，
 * 失效（tab 关闭、webContents 崩溃重建）就重新绑定——绑定表完全自愈。
 */
const tabTargetBindings = new Map<string, string>();

/** 外壳 renderer 在 CDP 里也是 page target（file://…/dist/renderer/index.html）。 */
function isShell(item: DebugTarget): boolean {
  return /\/dist\/renderer\/index\.html$/.test(item.url);
}

/**
 * DevTools 前端自身在 CDP 里也是 page target，绑定/选择时必须排除。
 *
 * 桥模式的 URL 是 `file://…/devtools_app.html?can_dock=true`，**没有 ws 参数**。
 * 早先只认 `?ws=`，于是前端自己被当成可绑定目标：切标签时新标签还是
 * about:blank，绑定走 fallback 就把前端容器掳了过来，热切换随后因 targetId
 * 相同早退，面板永远停在错误文档上。
 */
function isFrontendTarget(item: DebugTarget): boolean {
  return /\/devtools-frontend\//.test(item.url)
    || /\/(devtools_app|inspector|chii_app)\.html(\?|$)/.test(item.url);
}

function isBindableTarget(item: DebugTarget): boolean {
  return item.type === 'page' && !isShell(item) && !isFrontendTarget(item);
}

async function pickTargetForTab(tabId: string, port: number): Promise<string | null> {
  const wc = tabManager.getWebContents(tabId);
  const bound = tabTargetBindings.get(tabId);
  const targets = (await fetchTargets(port)).filter(isBindableTarget);

  // 1) 已绑定且还活着 → 直接用
  if (bound && targets.some((item) => item.id === bound)) return bound;
  if (bound) tabTargetBindings.delete(tabId);

  // 2) 现场绑定：URL 精确匹配 + 不占用别的 tab 已绑定的 target
  const currentUrl = wc ? wc.getURL() : '';
  const taken = new Set(tabTargetBindings.values());
  const candidate =
    (currentUrl ? targets.find((item) => item.url === currentUrl && !taken.has(item.id)) : undefined)
    // 新标签还没导航（getURL() 为空）时，只接受 about: 的无人占用 target。
    // 早先这里退回"任意未占用"，实测会把别的页面甚至前端容器掳过来；一旦绑错，
    // 热切换看到 targetId 相同就早退，面板永远停在那份文档上。宁可返回 null
    // 让调用方等下一次（导航完成后 URL 就能精确匹配），也不要猜。
    ?? targets.find((item) => !taken.has(item.id) && /^about:/.test(item.url));
  if (!candidate) return null;
  tabTargetBindings.set(tabId, candidate.id);
  return candidate.id;
}

/**
 * 解析指定目标的 CDP target id。
 *
 * 桥的热切换要用它：切 page 时跟随活动标签（走绑定表），切 shell 时按 URL
 * 唯一匹配。放在这里而不是让 IPC 层自己拼，是为了和 `getDevToolsTargetUrl`
 * 共用同一套解析（两套逻辑漂移过一次，about:blank 中间态会静默撞旧 target）。
 */
export async function resolveTargetId(target: 'page' | 'shell', tabId?: string | null): Promise<string | null> {
  if (target === 'shell') {
    const port = resolveDebugPort();
    if (!port) return null;
    return (await fetchTargets(port)).find(isShell)?.id ?? null;
  }
  return resolveActivePageTargetId(tabId);
}

/**
 * 活动标签当前可调试的 page target id（桥的 page 分支入口）。
 *
 * 绑定表逻辑与 `getDevToolsTargetUrl` 共用（`pickTargetForTab`），避免两套
 * 解析漂移。
 */
export async function resolveActivePageTargetId(tabId?: string | null): Promise<string | null> {
  const port = resolveDebugPort();
  if (!port) return null;
  const wanted = tabId ?? tabManager.getActiveId();
  if (!wanted) return null;
  const resolved = await pickTargetForTab(wanted, port);
  const wc = tabManager.getWebContents(wanted);
  log.info('[DevToolsBridge] resolve tab=%s url=%s → target=%s',
    wanted.slice(-6), (wc ? wc.getURL() : '-'), (resolved ? resolved.slice(0, 6) : 'null'));
  return resolved;
}

/**
 * 给前端一个可以直接连的 target 的 ws 地址。
 *
 * 页面目标走 tabId → targetId 绑定表（见 pickTargetForTab），不再按 URL
 * 实时匹配——URL 匹配在 about:blank 中间态会静默撞回旧标签的 target，
 * 且同标签内导航永远触发不了重连。外壳目标按 URL 匹配（外壳 target 唯一，
 * 无歧义；匹配不到就返回 no-target）。
 */
export async function getDevToolsTargetUrl(target: 'page' | 'shell', tabId?: string | null): Promise<DevToolsTargetResult> {
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

  const targets = await fetchTargets(port);
  // 端口在但列表为空：多半是刚启动还没注册 target，按可重试处理。
  if (targets.length === 0) return { url: null, reason: 'no-port' };

  let pickedId: string | null = null;
  if (target === 'shell') {
    // 外壳 target 按 URL 匹配（唯一），匹配不到就明示失败，不静默撞别的 target。
    pickedId = targets.find(isShell)?.id ?? null;
  } else {
    // tabId 由渲染层传入：它就是"用户现在看到的是哪个标签"的权威。
    // 不传时退回主进程的活动标签（容器首次挂载等场景）。
    const wanted = tabId ?? tabManager.getActiveId();
    pickedId = wanted ? await pickTargetForTab(wanted, port) : null;
  }
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

const PROBE_SCRIPT = `(function () {
  function abs(value, base) {
    try { return new URL(value, base || location.href).href; } catch (e) { return String(value || ''); }
  }
  function isSwf(url) {
    var text = String(url || '').toLowerCase();
    var at = text.indexOf('.swf');
    if (at < 0) return false;
    var next = text.charAt(at + 4);
    return next === '' || next === '?' || next === '#';
  }
  function isFlashType(node) {
    var t = String(node.getAttribute('type') || '').toLowerCase();
    return t.indexOf('shockwave-flash') !== -1 || t.indexOf('shockwave') !== -1;
  }
  var found = [];
  var seen = Object.create(null);
  var flashPlugins = 0;
  var sameOriginFrames = 0;
  // 尺寸归一：0×0 的加载器插件不该在 UI 里显示成 NaN×NaN
  function dim(value) {
    var n = Number(value);
    return isFinite(n) && n > 0 ? Math.round(n) : undefined;
  }
  function push(url, kind, base, width, height) {
    var full = abs(url, base);
    if (!full || !isSwf(full)) return;
    var key = kind + '|' + full;
    if (seen[key]) return;
    seen[key] = true;
    found.push({ url: full, kind: kind, width: width, height: height });
  }
  // 递归扫同源 frame：很多站把游戏塞在同源 iframe 里，只扫顶层会漏。
  // 跨域 frame 的 document 访问会抛异常，只能跳过（Electron 11 没有 mainFrame API）。
  function scan(doc, depth) {
    if (!doc) return;
    var base = doc.baseURI || location.href;
    var nodes;
    try { nodes = doc.querySelectorAll('embed, object, param'); } catch (e) { return; }
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var tag = node.tagName.toLowerCase();
      if (tag === 'param') {
        if ((node.getAttribute('name') || '').toLowerCase() === 'movie') {
          push(node.value || node.getAttribute('value'), 'param', base);
        }
        continue;
      }
      if (isFlashType(node)) flashPlugins += 1;
      var box = [dim(node.clientWidth) || dim(node.width), dim(node.clientHeight) || dim(node.height)];
      push(node.getAttribute('src'), tag, base, box[0], box[1]);
      push(node.getAttribute('data'), tag, base, box[0], box[1]);
    }
    try {
      var win = doc.defaultView;
      var list = win && win.performance ? win.performance.getEntriesByType('resource') : [];
      for (var j = 0; j < list.length; j++) push(list[j].name, 'resource', base);
    } catch (e) { /* performance unavailable */ }
    if (depth <= 0) return;
    var frames;
    try { frames = doc.querySelectorAll('iframe, frame'); } catch (e) { return; }
    for (var k = 0; k < frames.length; k++) {
      try {
        var sub = frames[k].contentDocument;
        if (sub) { sameOriginFrames += 1; scan(sub, depth - 1); }
      } catch (e) { /* 跨域，跳过 */ }
    }
  }
  scan(document, 2);
  // 主文档探测不到跨域 iframe 内部：把 iframe 的地址与是否同源暴露出来，
  // 避免"未检测到 SWF"被误读成"这页没有 Flash"。
  var frameList = [];
  var frameNodes = document.querySelectorAll('iframe, frame');
  for (var k2 = 0; k2 < frameNodes.length; k2++) {
    var frameNode = frameNodes[k2];
    var frameUrl = frameNode.getAttribute('src') || '';
    var sameOrigin = false;
    try { sameOrigin = !!frameNode.contentWindow && !!frameNode.contentDocument; } catch (e) { sameOrigin = false; }
    frameList.push({ url: abs(frameUrl), sameOrigin: sameOrigin });
  }
  var frames = 1;
  try { frames = window.frames.length + 1; } catch (e) { frames = 1; }
  return {
    swf: found,
    frames: frameList,
    flashPlugins: flashPlugins,
    sameOriginFrames: sameOriginFrames,
    ua: navigator.userAgent,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    frameCount: frames
  };
})()`;

/**
 * 浅探（主文档 + 同源 iframe）与 CDP 深探（跨域 / OOPIF / 无 JS 上下文）合并。
 * 深探为 null 时原样返回浅探——深探只是增强，不能让探测退化成"必须能连 CDP"。
 */
function mergeProbe(base: DevToolPageProbe | null, deep: DeepProbe | null, ua: string): DevToolPageProbe | null {
  if (!deep) return base;
  const swf = [...(base?.swf ?? [])];
  const seen = new Set(swf.map((item) => `${item.kind}|${item.url}`));
  for (const item of deep.swf) {
    const key = `${item.kind}|${item.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    swf.push({ url: item.url, kind: item.kind, width: item.width, height: item.height });
  }
  // frame 列表以深探为准：它给的是真实 frame 树，带 depth 与「有没有真跑过探测」。
  // 深探没结果时退回浅探（同源 iframe 的 src 列表）。
  const frames = deep.frames.length
    ? deep.frames
    : (base?.frames ?? []).map((frame) => ({
      url: frame.url,
      sameOrigin: frame.sameOrigin,
      depth: 1,
      readable: frame.sameOrigin,
    }));
  return {
    swf,
    frames,
    flashPlugins: Math.max(base?.flashPlugins ?? 0, deep.plugins),
    sameOriginFrames: frames.filter((frame) => frame.sameOrigin).length,
    deep: true,
    ua: base?.ua || ua,
    viewport: base?.viewport ?? { width: 0, height: 0 },
    frameCount: frames.length || base?.frameCount || 1,
  };
}

/**
 * 探测某个标签页的 Flash 情况。
 *
 * **必须由渲染层传 tabId**：切标签是渲染层先变、主进程后跟上的，这里读
 * `tabManager.getActiveId()` 会在这段窗口里探到上一个标签——表现是切到新标签后
 * 工具箱 Flash 页显示的还是上一页的数据，得重新按一次 F12 才更正。这与
 * `devtoolsUrl` / `bridge.attach` 是同一类错误（见 §9.4）。
 */
export async function probeActivePage(tabId?: string | null): Promise<DevToolPageProbe | null> {
  const resolvedId = tabId ?? tabManager.getActiveId();
  const wc = resolvedId ? tabManager.getWebContents(resolvedId) : null;
  if (!wc || wc.isDestroyed()) return null;

  let base: DevToolPageProbe | null = null;
  try {
    const raw = await wc.executeJavaScript(PROBE_SCRIPT, false);
    if (raw && typeof raw === 'object') base = raw as DevToolPageProbe;
  } catch (error) {
    log.debug('[DevToolbox] page probe failed:', error instanceof Error ? error.message : String(error));
  }

  // 什么时候值得上 CDP 深探：主文档没扫到 SWF，或者存在读不到的跨域 frame。
  // 两个条件都不成立时走快路径（4399 这种顶层 object 的页面完全不需要连 CDP）。
  const needsDeep = !base || (base.swf?.length ?? 0) === 0 || (base.frames ?? []).some((frame) => !frame.sameOrigin);
  let deep: DeepProbe | null = null;
  if (needsDeep && resolvedId) {
    const port = resolveDebugPort();
    if (port) {
      const targetId = await pickTargetForTab(resolvedId, port).catch(() => null);
      if (targetId) {
        deep = await probeFramesDeep(`ws://127.0.0.1:${port}/devtools/page/${targetId}`).catch(() => null);
      }
    }
  }

  const probe = mergeProbe(base, deep, (() => { try { return wc.getUserAgent(); } catch { return ''; } })());
  if (!probe) return null;
  log.debug('[DevToolbox] probe tab=%s url=%s swf=%d frames=%d deep=%s%s',
    resolvedId?.slice(-6), clip(wc.getURL(), 40), probe.swf?.length ?? 0, probe.frameCount ?? 0,
    probe.deep ? 'yes' : 'no',
    deep ? ` via=${JSON.stringify(deep.via)} ${deep.elapsedMs}ms` : '');
  return probe;
}
