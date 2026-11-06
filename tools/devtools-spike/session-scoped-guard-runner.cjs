/**
 * 终态架构验证：
 *   session A = default           → 不挂拦截器（外壳 + 标签页 + 本地 swf/html）
 *   session B = persist:devtools  → 挂拦截器，白名单只有 App 目录（DevTools 前端）
 *
 * 要证明三件事：
 *   1) B 里的页面：自己的资源正常，越界读取被拦
 *   2) A 里的页面：完全不受影响（本地文件随时随地打开，同目录/目录外都能读）
 *   3) A 的请求不会出现在 B 的拦截日志里
 */
const { app, BrowserWindow, BrowserView, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');

const T = path.join(os.tmpdir(), 'bfb-final');
try { fs.rmdirSync(T, { recursive: true }); } catch { /* 不存在 */ }
const APP_DIR = path.join(T, 'app');
const USER_DIR = path.join(T, 'myfiles');
fs.mkdirSync(APP_DIR, { recursive: true });
fs.mkdirSync(USER_DIR, { recursive: true });
app.setPath('userData', path.join(T, 'ud'));
app.commandLine.appendSwitch('remote-debugging-port', '0');

// App 侧（模拟 devtools-frontend）
fs.writeFileSync(path.join(APP_DIR, 'frontend.js'), 'window.__fe = "FE-ASSET-OK";');
fs.writeFileSync(path.join(APP_DIR, 'fe.html'), `<!doctype html>
<html><head><meta charset="utf-8"><title>frontend</title><script src="./frontend.js"></script></head>
<body>fe</body></html>`);

// 用户侧（模拟"我的本地测试页 / 游戏目录"）
fs.writeFileSync(path.join(USER_DIR, 'game.js'), 'window.__gj = "USER-ASSET-OK";');
fs.writeFileSync(path.join(USER_DIR, 'data.txt'), 'USER-DATA');
fs.writeFileSync(path.join(T, 'other-folder.txt'), 'OUTSIDE-USER-DIR');
fs.writeFileSync(path.join(USER_DIR, 'page.html'), `<!doctype html>
<html><head><meta charset="utf-8"><title>user-page</title><script src="./game.js"></script></head>
<body>user</body></html>`);

const toLocal = (u) => { try { return path.normalize(decodeURIComponent(fileURLToPath(u))).toLowerCase(); } catch { return ''; } };

app.whenReady().then(() => {
  const allowRoot = APP_DIR.toLowerCase();
  const feHits = [];

  // 只挂在前端那个有名分区上
  const feSession = session.fromPartition('persist:devtools');
  const registered = feSession.protocol.interceptFileProtocol('file', (request, callback) => {
    const local = toLocal(request.url);
    const ok = local === allowRoot || local.startsWith(allowRoot + path.sep);
    feHits.push((ok ? 'ALLOW ' : 'DENY  ') + local);
    if (ok) callback({ path: fileURLToPath(request.url) });
    else callback({ error: -10 });
  });
  console.log('[final] 拦截器注册在 persist:devtools =', registered);

  const win = new BrowserWindow({ width: 900, height: 760, show: false });

  // A：默认 session（不挂拦截器）——模拟用户在标签页打开本地文件
  const userView = new BrowserView({ webPreferences: { contextIsolation: true } });
  win.addBrowserView(userView);
  userView.setBounds({ x: 0, y: 0, width: 900, height: 360 });
  userView.webContents.loadFile(path.join(USER_DIR, 'page.html'));

  // B：前端分区（挂拦截器）
  const feView = new BrowserView({ webPreferences: { partition: 'persist:devtools', contextIsolation: true } });
  win.addBrowserView(feView);
  feView.setBounds({ x: 0, y: 380, width: 900, height: 340 });
  feView.webContents.loadFile(path.join(APP_DIR, 'fe.html'));

  const battery = (tag) => `(async () => {
    const out = { tag: '${'$'}{TAG}', origin: String(location.origin) };
    out.ownScript = String(window.__fe || window.__gj || 'MISSING');
    try { const r = await fetch('./data.txt'); out.siblingFetch = 'ok:' + (await r.text()); } catch (e) { out.siblingFetch = 'blocked'; }
    try { const r = await fetch('file:///' + ${JSON.stringify(USER_DIR.replace(/\\/g, '/'))} + '/data.txt'); out.crossDir = 'ok:' + (await r.text()); } catch (e) { out.crossDir = 'blocked'; }
    try { const r = await fetch('file:///' + ${JSON.stringify(T.replace(/\\/g, '/'))} + '/other-folder.txt'); out.outsideAll = 'ok:' + (await r.text()); } catch (e) { out.outsideAll = 'blocked'; }
    try { const r = await fetch('file:///C:/Windows/win.ini'); out.disk = 'LEAK'; } catch (e) { out.disk = 'blocked'; }
    return JSON.stringify(out);
  })()`;

  setTimeout(() => {
    Promise.all([
      userView.webContents.executeJavaScript(battery().replace('${TAG}', 'DEFAULT')).catch((e) => 'ERR ' + e.message),
      feView.webContents.executeJavaScript(battery().replace('${TAG}', 'DEVTOOLS')).catch((e) => 'ERR ' + e.message),
    ]).then(([a, b]) => {
      console.log('[final] DEFAULT(默认 session，无拦截器) ' + a);
      console.log('[final] DEVTOOLS(persist:devtools，白名单=App) ' + b);
      console.log('[final] --- 前端分区的拦截命中 ---');
      feHits.forEach((h) => console.log('   ' + h));
      console.log('[final] 命中里是否出现用户目录 =', feHits.some((h) => h.includes('myfiles')));
    });
  }, 4500);
});
