/**
 * 关键前提验证：把前端搬到「独立 WebContents + 独立 persist: 分区」后，
 *   1) 它的 localStorage 是否与外壳隔离（读不到外壳的东西）
 *   2) 是否仍然跨启动持久（设置的持久化诉求）
 *   3) 是否没有 parent（不在外壳 frame 树里）
 *
 * 外壳走默认 session（file://），前端走 partition='persist:devtools'（同为 file://）。
 */
const { app, BrowserWindow, BrowserView } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.tmpdir(), 'bfb-partition');
fs.mkdirSync(DIR, { recursive: true });
app.setPath('userData', path.join(DIR, 'ud'));
app.commandLine.appendSwitch('remote-debugging-port', '0');

const PAGE = (label) => `<!doctype html><html><head><meta charset="utf-8"></head>
<body><div id="v">${label}</div>
<script>
  var key = 'probe-key';
  var existing = localStorage.getItem(key);
  if (!existing) { localStorage.setItem(key, '${label}-' + Date.now()); existing = localStorage.getItem(key); }
  window.__report = JSON.stringify({
    label: '${label}',
    origin: String(location.origin),
    value: existing,
    sibling: localStorage.getItem('shell-only') || localStorage.getItem('guest-only') || null,
    keys: Object.keys(localStorage).length,
    hasParent: window.parent !== window,
  });
</script></body></html>`;

fs.writeFileSync(path.join(DIR, 'shell.html'), PAGE('SHELL'));
fs.writeFileSync(path.join(DIR, 'guest.html'), PAGE('GUEST'));

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 900, height: 700, show: false });
  win.loadFile(path.join(DIR, 'shell.html'));

  const view = new BrowserView({
    webPreferences: { partition: 'persist:devtools', contextIsolation: true, nodeIntegration: false },
  });
  win.addBrowserView(view);
  view.setBounds({ x: 0, y: 350, width: 900, height: 340 });
  view.webContents.loadFile(path.join(DIR, 'guest.html'));

  win.webContents.on('did-finish-load', () => {
    // 外壳额外写一个只有它才有的键，用来测隔离
    win.webContents.executeJavaScript("localStorage.setItem('shell-only','SHELL-PRIVATE'); window.__report")
      .then((r) => console.log('[part] SHELL ' + r));
  });
  view.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      view.webContents.executeJavaScript("localStorage.setItem('guest-only','GUEST-PRIVATE'); window.__report")
        .then((r) => console.log('[part] GUEST ' + r));
    }, 600);
  });
});
