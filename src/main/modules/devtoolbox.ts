import { app, webContents as allWebContents, type WebContents } from 'electron';
import fs from 'fs';
import http from 'http';
import path from 'path';
import log from 'electron-log';
import type {
  DevToolEntry,
  DevToolFlashInfo,
  DevToolIssue,
  DevToolLevel,
  DevToolPageProbe,
  DevToolSnapshot,
  DevToolTargetInfo,
} from '@shared/types/devtoolbox';
import { getCdpLeaseOwner } from './cdp-lease';
import { loadConfig } from './config';
import {
  classifyMainLog,
  clip,
  EntryBuffer,
  mapConsoleLevel,
} from './devtoolbox-buffer';
import { resolveFlashPlugin } from './flash';
import { getMainWindow } from './window';
import { tabManager } from './tabs';

/**
 * 内置开发者工具箱的主进程采集管道。
 *
 * 刻意**不 attach CDP**：Electron 的 WebContents 只允许一个 debugger 客户端，
 * 而密码捕获（长期持有）与自动化（短租约）已经在用。工具箱一旦抢租约，
 * 捕获链路就会拿到 "already attached by an unmanaged client"。
 *
 * 能拿到的能力：
 *  - 页面 + 外壳的控制台：`webContents.on('console-message')`（无 DevTools 也触发）
 *  - 主进程日志：electron-log 的 hooks（含 [PasswordCapture] / [Flash] / [Keyring]）
 *  - 求值与页面探测：`executeJavaScript`
 * 拿不到的：网络响应体、DOM/CSS 树、断点调试 → 仍由原生 DevTools 兜底。
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

export function getDevToolSnapshot(): DevToolSnapshot {
  const activeTabId = tabManager.getActiveId();
  const activeWc = activeTabId ? tabManager.getWebContents(activeTabId) : null;
  return {
    entries: buffer.snapshot(),
    targets: collectTargets(),
    flash: buildFlashInfo(),
    cdpOwner: activeWc ? getCdpLeaseOwner(activeWc.id) : null,
    activeTabId,
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

/** Chromium 把实际端口写进 userData 下的 DevToolsActivePort（第一行端口）。 */
function resolveDebugPort(): number | null {
  const fromSwitch = app.commandLine.getSwitchValue('remote-debugging-port');
  const parsed = Number.parseInt(fromSwitch, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  try {
    const file = path.join(app.getPath('userData'), 'DevToolsActivePort');
    const first = fs.readFileSync(file, 'utf-8').split('\n')[0];
    const fromFile = Number.parseInt(first, 10);
    if (Number.isFinite(fromFile) && fromFile > 0) return fromFile;
  } catch {
    // 没有调试端口：返回 null，UI 显示"未开启调试端口"
  }
  return null;
}

interface DebugTarget {
  id: string;
  type: string;
  url: string;
  title: string;
}

function fetchTargets(port: number): Promise<DebugTarget[]> {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: 2000 }, (response) => {
      let body = '';
      response.setEncoding('utf-8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve(Array.isArray(parsed) ? parsed as DebugTarget[] : []);
        } catch {
          resolve([]);
        }
      });
    });
    request.on('error', () => resolve([]));
    request.on('timeout', () => { request.destroy(); resolve([]); });
  });
}

/**
 * 给前端一个可以直接连的 page target 的 ws 地址。
 *
 * 匹配策略：外壳按 `file://…/dist/renderer/` 前缀；页面按当前标签 URL 精确匹配，
 * 匹配不到时退回第一个非外壳的 page（换标签时 URL 可能刚好在跳转中）。
 *
 * 入口与参数（2026-11-06）：
 * - 用 `devtools_app.html` 而不是 `inspector.html`。后者额外注册了
 *   `ScreencastAppProvider`（order 1 兜底壳），在 iframe 里只能跑出"左侧实时画面 +
 *   右侧面板"的 undocked 布局；前者只挂 `AdvancedApp`，停靠语义完整。
 * - `can_dock=true` 是 `AdvancedApp` 的启用条件（`Runtime.ConditionName.CAN_DOCK`
 *   就是查这个 query 参数）。不带它时 `getRegisteredAppProviders()` 会把
 *   AdvancedApp 过滤掉，退回 screencast 壳。
 * - 但 can_dock=true 的 `DockController` 默认 dockSide 是 `right`，`updateForDocked()`
 *   末尾会 `showBoth()` 显示主区占位（真 DevTools 里那块由宿主窗口绘制页面）。
 *   我们这里是 iframe，占位只会变成一块空白，故构建期把该行改成 `hideMain()`
 *   （见 `scripts/build-devtools-frontend.cjs` 的 SOURCE_PATCHES）。
 */
export async function getDevToolsTargetUrl(target: 'page' | 'shell'): Promise<string | null> {
  const port = resolveDebugPort();
  if (!port) return null;
  const frontend = await ensureFrontendServer();
  if (!frontend) return null;
  const targets = (await fetchTargets(port)).filter((item) => item.type === 'page');
  if (targets.length === 0) return null;

  const isShell = (item: DebugTarget): boolean => /\/dist\/renderer\/index\.html$/.test(item.url);
  let picked: DebugTarget | undefined;
  if (target === 'shell') {
    picked = targets.find(isShell);
  } else {
    const tabId = tabManager.getActiveId();
    const wc = tabId ? tabManager.getWebContents(tabId) : null;
    const currentUrl = wc ? wc.getURL() : '';
    picked = currentUrl ? targets.find((item) => item.url === currentUrl && !isShell(item)) : undefined;
    if (!picked) picked = targets.find((item) => !isShell(item)) ?? targets[0];
  }
  if (!picked) return null;
  return `http://127.0.0.1:${frontend}/devtools_app.html?ws=127.0.0.1:${port}/devtools/page/${picked.id}&can_dock=true`;
}

const PROBE_SCRIPT = `(function () {
  function abs(value) {
    try { return new URL(value, location.href).href; } catch (e) { return String(value || ''); }
  }
  function isSwf(url) {
    var text = String(url || '').toLowerCase();
    var at = text.indexOf('.swf');
    if (at < 0) return false;
    var next = text.charAt(at + 4);
    return next === '' || next === '?' || next === '#';
  }
  var found = [];
  var seen = Object.create(null);
  function push(url, kind, width, height) {
    var full = abs(url);
    if (!full || !isSwf(full)) return;
    var key = kind + '|' + full;
    if (seen[key]) return;
    seen[key] = true;
    found.push({ url: full, kind: kind, width: width, height: height });
  }
  var nodes = document.querySelectorAll('embed, object, param');
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    var tag = node.tagName.toLowerCase();
    if (tag === 'param') {
      if ((node.getAttribute('name') || '').toLowerCase() === 'movie') push(node.value || node.getAttribute('value'), 'param');
      continue;
    }
    push(node.getAttribute('src'), tag, node.clientWidth || node.width, node.clientHeight || node.height);
    push(node.getAttribute('data'), tag, node.clientWidth || node.width, node.clientHeight || node.height);
  }
  try {
    var list = performance.getEntriesByType('resource');
    for (var j = 0; j < list.length; j++) if (isSwf(list[j].name)) push(list[j].name, 'resource');
  } catch (e) { /* performance unavailable */ }
  // 主文档探测不到跨域 iframe 内部：7k7k 这类站的游戏页面本身就在 iframe 里，
  // 这里至少把 iframe 的地址与是否同源暴露出来，避免"未检测到 SWF"被误读成没有 Flash。
  var frameList = [];
  var frameNodes = document.querySelectorAll('iframe, frame');
  for (var k = 0; k < frameNodes.length; k++) {
    var frameNode = frameNodes[k];
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
    ua: navigator.userAgent,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    frameCount: frames
  };
})()`;

export async function probeActivePage(): Promise<DevToolPageProbe | null> {
  const tabId = tabManager.getActiveId();
  const wc = tabId ? tabManager.getWebContents(tabId) : null;
  if (!wc || wc.isDestroyed()) return null;
  try {
    const raw = await wc.executeJavaScript(PROBE_SCRIPT, false);
    if (!raw || typeof raw !== 'object') return null;
    return raw as DevToolPageProbe;
  } catch (error) {
    log.debug('[DevToolbox] page probe failed:', error instanceof Error ? error.message : String(error));
    return null;
  }
}
