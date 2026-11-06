/**
 * 三件事一次问清：
 *   1) partition:'persist:' （空名）到底是不是独立的 session？
 *   2) module 级 protocol.interceptFileProtocol 只作用于默认 session，还是全部？
 *   3) 两个视图的 localStorage 是否隔离。
 */
const { app, BrowserWindow, BrowserView, protocol, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');

const T = path.join(os.tmpdir(), 'bfb-scope');
try { fs.rmdirSync(T, { recursive: true }); } catch { /* 不存在 */ }
const ALLOW = path.join(T, 'allow');
const PAGE = path.join(T, 'page');
fs.mkdirSync(ALLOW, { recursive: true });
fs.mkdirSync(PAGE, { recursive: true });
app.setPath('userData', path.join(T, 'ud'));
app.commandLine.appendSwitch('remote-debugging-port', '0');

fs.writeFileSync(path.join(ALLOW, 'ok.html'), '<!doctype html><meta charset="utf-8"><title>ok</title>ok');
fs.writeFileSync(path.join(PAGE, 'game.js'), 'window.__gameJs = "GAME-JS-OK";');
fs.writeFileSync(path.join(PAGE, 'page.html'), `<!doctype html>
<html><head><meta charset="utf-8"><title>page</title><script src="./game.js"></script></head><body>p</body></html>`);

const toLocal = (u) => { try { return path.normalize(decodeURIComponent(fileURLToPath(u))).toLowerCase(); } catch { return ''; } };

app.whenReady().then(() => {
  const allowRoot = ALLOW.toLowerCase();
  const hits = [];
  protocol.interceptFileProtocol('file', (request, callback) => {
    const local = toLocal(request.url);
    const ok = local === allowRoot || local.startsWith(allowRoot + path.sep);
    hits.push((ok ? 'ALLOW ' : 'DENY  ') + local);
    if (ok) callback({ path: fileURLToPath(request.url) });
    else callback({ error: -10 });
  });

  const win = new BrowserWindow({ width: 900, height: 700, show: false });
  const vd = new BrowserView({ webPreferences: { contextIsolation: true } });
  const vp = new BrowserView({ webPreferences: { contextIsolation: true, partition: 'persist:' } });
  win.addBrowserView(vd);
  win.addBrowserView(vp);
  vd.setBounds({ x: 0, y: 0, width: 900, height: 300 });
  vp.setBounds({ x: 0, y: 320, width: 900, height: 300 });

  console.log('[scope] same object            =', String(session.fromPartition('persist:') === session.defaultSession));
  console.log('[scope] viewA.session==default =', String(vd.webContents.session === session.defaultSession));
  console.log('[scope] viewB.session==default =', String(vp.webContents.session === session.defaultSession));

  vd.webContents.loadFile(path.join(PAGE, 'page.html'));
  vp.webContents.loadFile(path.join(PAGE, 'page.html'));

  setTimeout(() => {
    console.log('[scope] --- 拦截器命中 ---');
    hits.forEach((h) => console.log('   ' + h));
    const pageHits = hits.filter((h) => h.includes(path.sep + 'page' + path.sep));
    console.log('[scope] 命中 page 目录次数 =', pageHits.length);
    console.log('[scope] --- 两个视图各自看到的 title/origin ---');
    Promise.all([
      vd.webContents.executeJavaScript('JSON.stringify({t:document.title,o:String(location.origin),js:String(window.__gameJs||"MISSING")})').catch((e) => 'ERR ' + e.message),
      vp.webContents.executeJavaScript('JSON.stringify({t:document.title,o:String(location.origin),js:String(window.__gameJs||"MISSING")})').catch((e) => 'ERR ' + e.message),
    ]).then(([a, b]) => {
      console.log('[scope] viewA(default) ' + a);
      console.log('[scope] viewB(persist) ' + b);
    });
  }, 4000);
});
