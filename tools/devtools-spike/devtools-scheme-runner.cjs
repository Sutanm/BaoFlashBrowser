/**
 * P0 方案 A 可行性 runner：用自定义 scheme `bfbdevtools://` 托管 DevTools 前端。
 *
 * 目的：静态服务 `listen(0)` 的随机端口让 origin 每次启动都变，localStorage 被隔离，
 * DevTools 的一切设置（语言/面板宽度/dockSide/实验开关）永远存不住。自定义 scheme
 * 的 origin 是恒定的 `bfbdevtools://devtools`，从根上解决，且还能省掉一个监听端口。
 *
 * 本文件只做可行性验证，不改产品代码；由 scheme-feasibility.cjs 驱动。
 */
'use strict';

const { app, BrowserWindow, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const FRONTEND_ROOT = path.join(APP_ROOT, 'dist', 'devtools-frontend');
const USER_DATA = path.join(os.tmpdir(), 'bfb-scheme-probe');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
};

app.setPath('userData', USER_DATA);
fs.mkdirSync(USER_DATA, { recursive: true });

// 必须在 ready 之前：standard 让相对 URL 可解析、secure 让它进安全上下文、
// supportFetchAPI/corsEnabled 让 fetch 与模块加载正常。
protocol.registerSchemesAsPrivileged([{
  scheme: 'bfbdevtools',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
  },
}]);

const shellPath = path.join(USER_DATA, 'probe-shell.html');
fs.writeFileSync(shellPath, `<!doctype html><html><body style="margin:0;background:#222">
<iframe id="f" src="bfbdevtools://devtools/devtools_app.html?can_dock=true"
        style="width:900px;height:700px;border:0"></iframe>
</body></html>`);

app.whenReady().then(() => {
  const root = path.resolve(FRONTEND_ROOT);
  const failures = [];

  const registered = protocol.registerHttpProtocol('bfbdevtools', (request, callback) => {
    console.log('[runner] req', request.url.slice(0, 90));
    try {
      const url = new URL(request.url);
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'devtools_app.html';
      const target = path.resolve(root, relative);
      if (!target.startsWith(root) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
        failures.push(relative);
        callback({ error: -6, statusCode: 404 });
        return;
      }
      callback({
        statusCode: 200,
        mimeType: MIME_TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
        data: fs.readFileSync(target),
      });
    } catch (error) {
      callback({ error: -2 });
    }
  });

  protocol.registerHttpProtocol('bfbprobe', (request, callback) => {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/failures') {
        callback({ statusCode: 200, mimeType: 'application/json', data: Buffer.from(JSON.stringify(failures)) });
        return;
      }
      callback({ statusCode: 200, mimeType: 'text/html; charset=utf-8', data: Buffer.from('<!doctype html><title>probe</title><p>ok</p>') });
    } catch {
      callback({ error: -2 });
    }
  });

  console.log('[runner] registerHttpProtocol:', registered, '| handled:', protocol.isProtocolHandled('bfbdevtools'));

  const win = new BrowserWindow({
    width: 1000,
    height: 800,
    show: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  // BFB_SCHEME_TOP=1：把 scheme 页当顶层文档加载，用来区分
  // 「自定义 scheme 本身没有 DOM storage」与「iframe 里的第三方限制」
  const topLevel = process.env.BFB_SCHEME_TOP === '1';
  if (topLevel) {
    win.loadURL('bfbdevtools://devtools/devtools_app.html?can_dock=true');
  } else {
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.log('[runner] did-fail-load', code, desc, String(url).slice(0, 90));
  });
  win.webContents.on('did-finish-load', () => console.log('[runner] did-finish-load', win.webContents.getURL().slice(0, 90)));
  }
  win.webContents.on('console-message', (_e, level, message) => {
    console.log(`[runner] console(${level}): ${String(message).slice(0, 200)}`);
  });
});
