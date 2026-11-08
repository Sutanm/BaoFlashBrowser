import { app, session } from 'electron';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import log from 'electron-log';

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
export function useLegacyHttp(): boolean {
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
export function useBridge(): boolean {
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

export function ensureFrontendServer(): Promise<number | null> {
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
        // 必须带 path.sep：只写 startsWith(root) 时，devtools-frontend-x 这类
        // 兄弟目录也会被判定为在 root 内（与 installDevToolsFileGuard 的写法保持一致）。
        if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
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
