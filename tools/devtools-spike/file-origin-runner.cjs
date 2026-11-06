/**
 * 判定 file:// 能否承载 DevTools 前端（决定"去端口"是否物理上可能）。
 *
 * 检查三个能力：
 *   C1 classic <script> 能否执行      —— DevTools 若 bundle 成单文件，就只需要这个
 *   C2 ES module 能否加载              —— 现状做法，预期被 CORS 拦
 *   C3 localStorage 能否读写           —— 持久化前提
 *   C4 fetch 同目录 JSON 能否成功       —— DevTools 的 locales 是 fetch 来的
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DIR = path.join(os.tmpdir(), 'bfb-file-probe');
fs.mkdirSync(DIR, { recursive: true });
app.setPath('userData', path.join(DIR, 'user-data'));

fs.writeFileSync(path.join(DIR, 'classic.js'), `window.__classic = 'ok';`);
fs.writeFileSync(path.join(DIR, 'mod.js'), `window.__module = 'ok'; export const x = 1;`);
fs.writeFileSync(path.join(DIR, 'data.json'), `{"hello":"world"}`);
fs.writeFileSync(path.join(DIR, 'page.html'), `<!doctype html>
<html><head><meta charset="utf-8"><title>file probe</title>
<script src="./classic.js"></script>
<script type="module" src="./mod.js"></script>
</head><body>probe</body></html>`);

// BFB_FILE_IFRAME=1：用 file:// 父页 + file:// iframe 加载真实 DevTools 前端，
// 验证"如果前端也从 file:// 加载，是否等价可用"（等价则端口可以彻底去掉）。
const FRONTEND = path.join(__dirname, '..', '..', 'dist', 'devtools-frontend');
fs.writeFileSync(path.join(DIR, 'iframe.html'), `<!doctype html>
<html><body style="margin:0;background:#222">
<iframe id="f" src="file:///${FRONTEND.replace(/\\/g, '/')}/devtools_app.html?can_dock=true"
        style="width:900px;height:700px;border:0"></iframe>
</body></html>`);

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1000, height: 800, show: process.env.BFB_FILE_IFRAME === '1' });
  const page = process.env.BFB_FILE_IFRAME === '1' ? 'iframe.html' : 'page.html';
  win.loadFile(path.join(DIR, page));
  win.webContents.on('console-message', (_e, level, message) => {
    console.log(`[file] console(${level}): ${String(message).slice(0, 160)}`);
  });
});
