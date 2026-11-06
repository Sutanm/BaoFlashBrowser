/**
 * 威胁模型实测 runner：file:// 同源 vs http://127.0.0.1 跨源。
 *
 * 场景：外壳页（file://）里放两个 iframe——一个 file://、一个 http://127.0.0.1。
 * 外壳页通过 preload 的 contextBridge 暴露一个"特权 API"，并在 localStorage 里
 * 放一份"秘密"。然后从两个 iframe 内部各试一遍越界访问，看差在哪里。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DIR = path.join(os.tmpdir(), 'bfb-threat');
try { fs.rmdirSync(DIR, { recursive: true }); } catch { /* 不存在 */ }
fs.mkdirSync(DIR, { recursive: true });
app.setPath('userData', path.join(DIR, 'ud'));
app.commandLine.appendSwitch('remote-debugging-port', '0');

// 外壳侧的"特权 API"（模拟 window.electronAPI）
fs.writeFileSync(path.join(DIR, 'preload.cjs'), [
  "const { contextBridge } = require('electron');",
  "contextBridge.exposeInMainWorld('electronAPI', { marker: 'SHELL-PRIVILEGE', ping: () => 'pong' });",
].join('\n'));

const PROBE_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head>'
  + '<body>probe-frame</body></html>';
fs.writeFileSync(path.join(DIR, 'probe.html'), PROBE_HTML);

// 一个位于外壳目录之外的本地文件：iframe 若继承 file:// origin，可能读得到它
const OUTSIDE = path.join(os.tmpdir(), 'bfb-threat-outside.txt');
fs.writeFileSync(OUTSIDE, 'OUTSIDE-SECRET');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PROBE_HTML);
});

app.whenReady().then(() => {
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    const shellPath = path.join(DIR, 'shell.html');
    fs.writeFileSync(shellPath, `<!doctype html>
<html><head><meta charset="utf-8"><title>SHELL-APP</title></head>
<body>
<script>
  localStorage.setItem('shell-token', 'SHELL-STORAGE-SECRET');
</script>
<iframe id="f-file" src="./probe.html" width="200" height="80"></iframe>
<iframe id="f-http" src="http://127.0.0.1:${port}/probe.html" width="200" height="80"></iframe>
</body></html>`);

    const win = new BrowserWindow({
      width: 700,
      height: 500,
      show: false,
      webPreferences: {
        preload: path.join(DIR, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.loadFile(shellPath);
    win.webContents.on('did-finish-load', () => console.log('[threat] shell loaded | http port', port));
    console.log('[threat] userData', path.join(DIR, 'ud'));
  });
});
