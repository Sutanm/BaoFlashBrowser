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
import { resolveFlashPlugin } from './flash';
import { getMainWindow } from './window';
import { tabManager } from './tabs';

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
export function resolveDebugPort(): number | null {
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

/**
 * 给桥用的 target 枚举（`/json/list`）。
 *
 * 桥需要它来伪造 `Target.targetCreated`：S14 基线证明 page-ws 下前端自己
 * `setDiscoverTargets(true)` 后会收到**全部 target** 的创建事件（iframe/外壳/页面，
 * 都是 `attached: true`），前端据此建立 TargetManager 记录。桥走 browser 端点时
 * 这条事件不会自动补，必须由桥扮演 host。
 */
export function listDebugTargets(): Promise<Array<{ id: string; type: string; url: string; title: string }>> {
  const port = resolveDebugPort();
  if (!port) return Promise.resolve([]);
  return fetchTargets(port).then((items) => items.map((item) => ({
    id: item.id, type: item.type, url: item.url, title: item.title,
  })));
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

/** DevTools 前端自身在 CDP 里也是 page target，绑定/选择时必须排除。 */
function isFrontendTarget(item: DebugTarget): boolean {
  return /\/(devtools_app|inspector|chii_app)\.html\?ws=/.test(item.url);
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
    // about:blank / newtab 等中间态匹配不到时，退而取第一个无人占用的
    ?? targets.find((item) => !taken.has(item.id));
  if (!candidate) return null;
  tabTargetBindings.set(tabId, candidate.id);
  return candidate.id;
}

/**
 * 解析结果带原因，供渲染层区分三种状态：
 * - `ok`：拿到可加载的前端 URL（含 ws + can_dock 参数）
 * - `no-port`：调试端口或前端静态服务不可用（可重试，短暂等待后仍失败才提示）
 * - `no-target`：通道正常，但当前标签没有可调试的 page target——about:newtab /
 *   about:userscripts 等页面不创建 BrowserView（见 tabs.ts 的 needsBrowserView），
 *   CDP 侧根本没有对应 target。这是正常语义，不该重试到超时、也不该提示"端口故障"。
 */

/**
 * 活动标签当前可调试的 page target id（桥的 attach 入口）。
 * 与 getDevToolsTargetUrl 共用同一套绑定表逻辑，避免两套解析漂移。
 */
export async function resolveActivePageTargetId(): Promise<string | null> {
  const port = resolveDebugPort();
  if (!port) return null;
  const tabId = tabManager.getActiveId();
  if (!tabId) return null;
  return pickTargetForTab(tabId, port);
}

/**
 * 给前端一个可以直接连的 target 的 ws 地址。
 *
 * 页面目标走 tabId → targetId 绑定表（见 pickTargetForTab），不再按 URL
 * 实时匹配——URL 匹配在 about:blank 中间态会静默撞回旧标签的 target，
 * 且同标签内导航永远触发不了重连。外壳目标按 URL 匹配（外壳 target 唯一，
 * 无歧义；匹配不到就返回 no-target）。
 */
export async function getDevToolsTargetUrl(target: 'page' | 'shell'): Promise<DevToolsTargetResult> {
  const port = resolveDebugPort();
  if (!port) return { url: null, reason: 'no-port' };
  const frontend = await ensureFrontendServer();
  if (!frontend) return { url: null, reason: 'no-port' };
  const targets = await fetchTargets(port);
  // 端口在但列表为空：多半是刚启动还没注册 target，按可重试处理。
  if (targets.length === 0) return { url: null, reason: 'no-port' };

  let pickedId: string | null = null;
  if (target === 'shell') {
    // 外壳 target 按 URL 匹配（唯一），匹配不到就明示失败，不静默撞别的 target。
    pickedId = targets.find(isShell)?.id ?? null;
  } else {
    const tabId = tabManager.getActiveId();
    pickedId = tabId ? await pickTargetForTab(tabId, port) : null;
  }
  if (!pickedId) return { url: null, reason: 'no-target' };
  // 桥模式（enabled via BAO_DEVTOOLS_BRIDGE=1）：URL 不带 ws，前端会走
  // BfbBridgeConnection（postMessage → 外壳中继 → IPC → 主进程桥 → flatten）。
  // bfb_target 只作为 iframe key 的重载触发参数（切标签时仍重载一次，
  // "不重载"是 B4 的目标）。
  if (process.env.BAO_DEVTOOLS_BRIDGE === '1') {
    return {
      url: `http://127.0.0.1:${frontend}/devtools_app.html?can_dock=true&bfb_target=${pickedId}`,
      reason: 'ok',
    };
  }
  // 默认（page-ws 直连）。入口用 devtools_app.html（只挂 AdvancedApp 停靠壳），
  // can_dock=true 是它的启用条件；showBoth → hideMain 的占位修正见
  // scripts/build-devtools-frontend.cjs 的 SOURCE_PATCHES 与文档 §8.1。
  return {
    url: `http://127.0.0.1:${frontend}/devtools_app.html?ws=127.0.0.1:${port}/devtools/page/${pickedId}&can_dock=true`,
    reason: 'ok',
  };
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
