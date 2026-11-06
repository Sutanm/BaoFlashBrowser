/**
 * webview 可行性探针：在「已有 BrowserView」的窗口里再放一个 <webview>，
 * 验证它能不能承担 DevTools 前端容器。
 *
 * 要回答：
 *   1) webviewTag 打开后 <webview> 能否加载 file:// 页面（Electron 11）
 *   2) 它是否是独立 WebContents + 独立分区 + 没有 parent
 *   3) 能不能挂自己的 preload（前端只需要一个窄 CDP API）
 *   4) 是否由 CSS 布局（不需要手算 bounds）
 *   5) 和已有的 BrowserView 共存有没有问题
 */
const { app, BrowserWindow, BrowserView, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const T = path.join(os.tmpdir(), 'bfb-wv');
try { fs.rmdirSync(T, { recursive: true }); } catch { /* 不存在 */ }
fs.mkdirSync(T, { recursive: true });
app.setPath('userData', path.join(T, 'ud'));
app.commandLine.appendSwitch('remote-debugging-port', '0');

fs.writeFileSync(path.join(T, 'fe-preload.js'), [
  "const { contextBridge, ipcRenderer } = require('electron');",
  "contextBridge.exposeInMainWorld('bfbBridge', {",
  "  marker: 'FRONTEND-PRIVATE-API',",
  "  version: ipcRenderer.sendSync ? 'ok' : 'no',",
  "});",
].join('\n'));

fs.writeFileSync(path.join(T, 'fe.html'), `<!doctype html>
<html><head><meta charset="utf-8"><title>FE</title></head>
<body><div id="root">frontend</div>
<script>
  try { localStorage.setItem('fe-key', 'FE-STORED'); window.__ls = 'ok'; } catch (e) { window.__ls = 'THROW'; }
  window.__hasParent = window.parent !== window;
  window.__origin = String(location.origin);
</script></body></html>`);

fs.writeFileSync(path.join(T, 'tab.html'), '<!doctype html><meta charset="utf-8"><title>TAB</title>tab content');

// 外壳：flex 布局，中间放 webview（模拟抽屉内容区）
fs.writeFileSync(path.join(T, 'shell.html'), `<!doctype html>
<html><head><meta charset="utf-8"><title>SHELL</title>
<style>
  html,body{margin:0;height:100%;font:12px sans-serif}
  #app{display:flex;flex-direction:column;height:100%}
  #topbar{height:40px;background:#eee;flex:0 0 auto}
  #middle{flex:1 1 auto;background:#ddd;display:flex;flex-direction:column}
  #fe{flex:1 1 auto;border:0;display:flex;width:100%}
  #status{height:24px;background:#ccc;flex:0 0 auto}
</style></head>
<body><div id="app">
  <div id="topbar">topbar</div>
  <div id="middle"><webview id="fe" src="file:///${path.join(T, 'fe.html').replace(/\\/g, '/')}"
      preload="file:///${path.join(T, 'fe-preload.js').replace(/\\/g, '/')}"
      partition="persist:devtools" webpreferences="contextIsolation=yes"></webview></div>
  <div id="status">status</div>
</div></body></html>`);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900, height: 700, show: false,
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false },
  });

  // 先用一个 BrowserView 占据上半部分（模拟标签页区域），证明两者共存
  const tab = new BrowserView({ webPreferences: { contextIsolation: true } });
  win.addBrowserView(tab);
  tab.setBounds({ x: 0, y: 40, width: 900, height: 300 });
  tab.webContents.loadFile(path.join(T, 'tab.html'));

  win.webContents.on('did-finish-load', async () => {
    await new Promise((r) => setTimeout(r, 2500));
    const expr = `(() => {
      const wv = document.getElementById('fe');
      if (!wv) return JSON.stringify({ error: 'no webview element' });
      const r = wv.getBoundingClientRect();
      return JSON.stringify({
        tagFound: true,
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        url: String(wv.getURL ? wv.getURL() : '').slice(0, 50),
        wcId: typeof wv.getWebContentsId === 'function' ? wv.getWebContentsId() : null,
      });
    })()`;
    console.log('[wv] shell 侧:', await win.webContents.executeJavaScript(expr).catch((e) => 'ERR ' + e.message));

    const probe = await win.webContents.executeJavaScript(`(async () => {
      const wv = document.getElementById('fe');
      try {
        return await wv.executeJavaScript("JSON.stringify({ origin: window.__origin, ls: window.__ls, hasParent: window.__hasParent, bridge: typeof window.bfbBridge, marker: (window.bfbBridge && window.bfbBridge.marker) || 'n/a' })");
      } catch (e) { return 'EXEC-ERR ' + e.message; }
    })()`).catch((e) => 'ERR ' + e.message);
    console.log('[wv] guest 内部:', probe);

    const wcId = await win.webContents.executeJavaScript(`document.getElementById('fe').getWebContentsId()`).catch(() => null);
    const { webContents } = require('electron');
    const guest = wcId ? webContents.fromId(wcId) : null;
    if (guest) {
      console.log('[wv] guest 是否独立 WebContents =', guest !== win.webContents);
      console.log('[wv] guest session 是否默认 =', String(guest.session === session.defaultSession));
      console.log('[wv] guest URL =', guest.getURL().slice(0, 50));
      // 隔离检查：在外壳里写一个键，看 guest 能不能看到
      await win.webContents.executeJavaScript("localStorage.setItem('shell-only','SHELL-PRIVATE')").catch(() => null);
      const iso = await guest.executeJavaScript("JSON.stringify({ seesShellKey: localStorage.getItem('shell-only'), own: localStorage.getItem('fe-key') })").catch((e) => 'ERR ' + e.message);
      console.log('[wv] 存储隔离:', iso);
    } else {
      console.log('[wv] 拿不到 guest webContents');
    }
  });

  await win.loadFile(path.join(T, 'shell.html'));
});
