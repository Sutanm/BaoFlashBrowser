// 用应用同款 Electron 11 (Chromium 87) 直接打开 DevTools 前端，判断是否兼容。
// 用法： node_modules/electron/dist/electron.exe tools/devtools-spike/electron-frontend-check.cjs
const { app, BrowserWindow } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.BFB_FE_DIR || path.resolve(__dirname, '..', '..', 'assets', 'devtools-frontend-chrome87');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.avif': 'image/avif',
  '.webp': 'image/webp', '.wasm': 'application/wasm', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.map': 'application/json',
};

const missing = [];

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'inspector.html';
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
    missing.push(rel);
    res.writeHead(404).end('nf');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const messages = [];

app.whenReady().then(() => {
  server.listen(18081, '127.0.0.1', async () => {
    const win = new BrowserWindow({ width: 1280, height: 800, show: false, webPreferences: { contextIsolation: true } });
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      messages.push(`[console ${level}] ${String(message).slice(0, 200)} @${String(sourceId).slice(-60)}:${line}`);
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => messages.push(`[fail-load] ${code} ${desc} ${url}`));
    win.webContents.on('render-process-gone', (_e, details) => messages.push(`[renderer-gone] ${JSON.stringify(details)}`));

    await win.loadURL('http://127.0.0.1:18081/inspector.html');
    await new Promise((r) => setTimeout(r, 7000));

    const state = await win.webContents.executeJavaScript(`(() => {
      const res = performance.getEntriesByType('resource');
      return JSON.stringify({
        htmlLen: document.documentElement.outerHTML.length,
        bodyLen: document.body ? document.body.innerHTML.length : -1,
        text: document.body ? document.body.innerText.slice(0, 120) : '',
        resources: res.length,
        hasShadow: Boolean(document.querySelector('devtools-app')),
      });
    })()`).catch((error) => 'eval-failed: ' + error.message);

    const image = await win.capturePage();
    const out = path.resolve(__dirname, '..', '..', 'artifacts', 'devtools-electron87.png');
    fs.writeFileSync(out, image.toPNG());

    console.log('STATE:', state);
    console.log('MISSING:', JSON.stringify([...new Set(missing)].slice(0, 12)));
    console.log('MESSAGES:', JSON.stringify(messages.slice(0, 12), null, 1));
    console.log('SHOT:', out);
    app.exit(0);
  });
});
