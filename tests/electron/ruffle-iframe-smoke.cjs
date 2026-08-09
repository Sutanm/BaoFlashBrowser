// Smoke: does the userscript runtime execute in an IFRAME under RUFFLE mode?
// (contextIsolation: false). PPAPI mode is known to work; Ruffle mode may
// differ because the preload shares the page world.
const { app, BrowserView, BrowserWindow, ipcMain } = require('electron');
const http = require('http');
const path = require('path');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'WinUseBrowserSpellChecker');
app.on('window-all-closed', () => {});
app.setPath('userData', path.join(app.getPath('appData'), 'bao-flash-browser'));

const failures = [];
function check(name, ok, detail) {
  console.log(`[ruffle-iframe] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' ' + JSON.stringify(detail) : ''}`);
  if (!ok) failures.push(name);
}

app.whenReady().then(async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../../release/tests/userscripts-admin-module.cjs');
  mod.initUserscriptManager();
  const manager = mod.getUserscriptManager();
  check('demo script installed', Boolean(mod.listUserscripts().find((s) => s.id === 'baoflash-demo-test')));

  ipcMain.on('userscript:get-config', (event, payload) => {
    event.returnValue = manager.snapshotFor(event.sender.id, payload?.url ?? '', Boolean(payload?.isMainFrame));
  });
  ipcMain.on('userscript:report', (event, payload) => {
    manager.acceptReport(event.sender.id, payload);
  });
  ipcMain.on('userscript:menu-register', (event, payload) => {
    manager.registerMenuCommand(event.sender.id, payload.scriptId, payload.documentId, payload.title, payload.commandId, Boolean(payload.isMainFrame));
  });

  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (req.url === '/frame.html') {
      res.end('<!doctype html><html><head><meta charset="utf-8"><title>sub</title></head><body><p>subframe</p></body></html>');
    } else {
      res.end('<!doctype html><html><head><meta charset="utf-8"><title>main</title></head><body><p>main</p><iframe id="game" src="/frame.html" width="300" height="200"></iframe></body></html>');
    }
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${srv.address().port}/`;

  const preloadPath = path.join(__dirname, '..', '..', 'release', 'tests', 'userscript-runtime-preload.cjs');
  const host = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { nodeIntegration: false, contextIsolation: true, spellcheck: false } });
  const view = new BrowserView({
    webPreferences: {
      preload: preloadPath,
      plugins: false,
      contextIsolation: false, // RUFFLE mode
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      spellcheck: false,
      partition: 'persist:ruffle-iframe',
    },
  });
  host.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, width: 900, height: 700 });
  manager.registerView(view.webContents.id, { mode: 'ruffle', generation: 1, token: 'ruffle-iframe' });

  await view.webContents.loadURL(url);
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const probe = await view.webContents.executeJavaScript(`(() => {
    const game = document.getElementById('game');
    let subBadge = null;
    let subBridge = null;
    try {
      subBadge = Boolean(game && game.contentDocument && game.contentDocument.getElementById('baoflash-test-badge'));
      subBridge = game && game.contentDocument ? typeof game.contentDocument.defaultView.__baoflashTest : null;
    } catch (e) { subBadge = 'cross-origin'; subBridge = String(e); }
    return {
      mainBadge: Boolean(document.getElementById('baoflash-test-badge')),
      iframes: document.querySelectorAll('iframe').length,
      subBadge,
      subBridge,
    };
  })()`);
  check('main-frame badge present', probe.mainBadge === true, probe);
  check('iframe exists', probe.iframes >= 1, probe);
  check('iframe badge present (sub-frame script ran)', probe.subBadge === true, probe);

  host.destroy();
  srv.close();
  console.log(`[ruffle-iframe] ${failures.length === 0 ? 'ALL PASS' : 'FAILURES: ' + failures.join(', ')}`);
  app.exit(failures.length === 0 ? 0 : 1);
});
