/**
 * 闸门 B1.1：file:// 页面能否建立 ws://127.0.0.1:<port> 连接？
 *
 * 这决定「去端口」之后前端还能不能自己连 CDP（文件协议是"安全上下文"，
 * ws:// 明文连接可能被 mixed-content 规则拦下）。
 * 同时验证：它是不是 secure context、控制台有没有被拦的告警。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const DIR = path.join(os.tmpdir(), 'bfb-wsgate');
try { fs.rmdirSync(DIR, { recursive: true }); } catch { /* 不存在 */ }
fs.mkdirSync(DIR, { recursive: true });
app.setPath('userData', path.join(DIR, 'ud'));

const PAGE = (port) => `<!doctype html>
<html><head><meta charset="utf-8"><title>ws-gate</title></head>
<body><div id="r">pending</div>
<script>
  window.__wsResult = 'pending';
  window.__secure = window.isSecureContext;
  try {
    var ws = new WebSocket('ws://127.0.0.1:${port}');
    ws.onopen = function () { window.__wsResult = 'OPEN'; document.getElementById('r').textContent = 'OPEN'; };
    ws.onerror = function () { window.__wsResult = 'ERROR'; document.getElementById('r').textContent = 'ERROR'; };
    ws.onclose = function (e) {
      if (window.__wsResult === 'pending') { window.__wsResult = 'CLOSED:' + e.code; }
      document.getElementById('r').textContent = window.__wsResult;
    };
  } catch (e) { window.__wsResult = 'THROW:' + e.message; }
</script></body></html>`;

app.whenReady().then(() => {
  const wss = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  wss.on('listening', () => {
    const port = wss.address().port;
    const file = path.join(DIR, 'page.html');
    fs.writeFileSync(file, PAGE(port));
    console.log('[gate] ws server on 127.0.0.1:' + port);

    const win = new BrowserWindow({ width: 600, height: 400, show: false, webPreferences: { contextIsolation: true } });
    win.webContents.on('console-message', (_e, _level, message) => {
      if (/mixed|insecure|blocked|Content Security/i.test(String(message))) {
        console.log('[gate] console:', String(message).slice(0, 160));
      }
    });
    win.loadFile(file);

    win.webContents.on('did-finish-load', () => setTimeout(async () => {
      const result = await win.webContents.executeJavaScript(
        'JSON.stringify({ ws: window.__wsResult, secure: window.__secure, origin: String(location.origin) })',
      ).catch((e) => 'ERR ' + e.message);
      console.log('[gate] result:', result);
      console.log('[gate] 判定:', String(result).includes('"ws":"OPEN"') ? 'file:// 可以连 ws://127.0.0.1 —— 前端可继续自连 CDP' : '被拦 —— 必须改走 preload IPC');
      wss.close();
      app.exit(0);
    }, 2500));
  });
});
