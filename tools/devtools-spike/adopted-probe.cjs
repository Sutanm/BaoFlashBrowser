// 探针：Chromium 87 的 document.adoptedStyleSheets 到底能怎么改
// 用法： env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe tools/devtools-spike/adopted-probe.cjs
const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
  await win.loadURL('about:blank');
  const result = await win.webContents.executeJavaScript(`(() => {
    const a = document.adoptedStyleSheets;
    const extensible = Object.isExtensible(a);
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('body { color: rgb(1, 2, 3); }');
    let assign;
    try {
      document.adoptedStyleSheets = [...a, sheet];
      assign = 'ok len=' + document.adoptedStyleSheets.length;
    } catch (e) { assign = 'fail: ' + e.message; }
    let push;
    try { document.adoptedStyleSheets.push(sheet); push = 'ok'; } catch (e) { push = 'fail: ' + e.message; }
    const color = getComputedStyle(document.body).color;
    return JSON.stringify({ extensible, assign, push, appliedColor: color });
  })()`);
  console.log('PROBE:', result);
  app.exit(0);
});
