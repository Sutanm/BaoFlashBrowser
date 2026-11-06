/**
 * A/B：同一个本地页面，分别在「默认 session」和「persist: 分区」里加载，
 * 完全不挂任何拦截器。判断 file:// 的宽松/严格到底是 session 差异，
 * 还是我上一轮挂 interceptFileProtocol 带来的副作用。
 */
const { app, BrowserWindow, BrowserView } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const T = path.join(os.tmpdir(), 'bfb-ab');
try { fs.rmdirSync(T, { recursive: true }); } catch { /* 不存在 */ }
fs.mkdirSync(T, { recursive: true });
app.setPath('userData', path.join(T, 'ud'));
app.commandLine.appendSwitch('remote-debugging-port', '0');

fs.writeFileSync(path.join(T, 'game.js'), 'window.__gameJs = "GAME-JS-OK";');
fs.writeFileSync(path.join(T, 'data.txt'), 'PAGE-DATA');
fs.writeFileSync(path.join(T, 'page.html'), `<!doctype html>
<html><head><meta charset="utf-8"><title>ab-page</title>
<script src="./game.js"></script></head><body>ab</body></html>`);

const BATTERY = `(async () => {
  const out = { tag: '${'$'}{TAG}', origin: String(location.origin) };
  out.siblingScript = String(window.__gameJs || 'MISSING');
  try { const r = await fetch('./data.txt'); out.siblingFetch = 'ok:' + (await r.text()); } catch (e) { out.siblingFetch = 'BLOCKED'; }
  try { const r = await fetch('file:///C:/Windows/win.ini'); out.diskFetch = 'LEAK:' + (await r.text()).trim().slice(0, 12); } catch (e) { out.diskFetch = 'blocked'; }
  try { localStorage.setItem('k', '1'); out.storage = 'ok'; } catch (e) { out.storage = 'THROW:' + e.name; }
  return JSON.stringify(out);
})()`;

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 900, height: 700, show: false });

  const mk = (partition, y) => {
    const opts = { webPreferences: { contextIsolation: true } };
    if (partition) opts.webPreferences.partition = partition;
    const v = new BrowserView(opts);
    win.addBrowserView(v);
    v.setBounds({ x: 0, y, width: 900, height: 320 });
    v.webContents.loadFile(path.join(T, 'page.html'));
    return v;
  };

  const a = mk(null, 0);
  const b = mk('persist:', 340);

  const report = (label, v) => v.webContents.executeJavaScript(BATTERY.replace('${TAG}', label))
    .then((r) => console.log('[ab] ' + label + ' ' + r))
    .catch((e) => console.log('[ab] ' + label + ' ERR ' + e.message));

  setTimeout(() => {
    report('DEFAULT', a);
    report('PERSIST', b);
  }, 3000);
});
