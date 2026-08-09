// Verify the demo test script executes on a real page: badge presence,
// persistent visit counter, and the page-world bridge flag.
const { app, BrowserView, BrowserWindow, ipcMain } = require('electron');
const http = require('http');
const path = require('path');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'WinUseBrowserSpellChecker');
app.on('window-all-closed', () => {});
app.setPath('userData', path.join(app.getPath('appData'), 'bao-flash-browser'));

const failures = [];
function check(name, ok, detail) {
  console.log(`[demo-test-verify] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' ' + JSON.stringify(detail) : ''}`);
  if (!ok) failures.push(name);
}

app.whenReady().then(async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../../release/tests/userscripts-admin-module.cjs');
  mod.initUserscriptManager();
  const manager = mod.getUserscriptManager();

  const installed = mod.listUserscripts().find((s) => s.id === 'baoflash-demo-test');
  check('demo script installed', Boolean(installed), installed ? installed.metadata.name : null);

  ipcMain.on('userscript:get-config', (event, payload) => {
    event.returnValue = manager.snapshotFor(event.sender.id, payload?.url ?? '', Boolean(payload?.isMainFrame));
  });
  ipcMain.on('userscript:report', (event, payload) => {
    manager.acceptReport(event.sender.id, payload);
  });

  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><meta charset="utf-8"><title>verify</title></head><body>verify page</body></html>');
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${srv.address().port}/`;

  const preloadPath = path.join(__dirname, '..', '..', 'release', 'tests', 'userscript-runtime-preload.cjs');
  const host = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { nodeIntegration: false, contextIsolation: true, spellcheck: false } });
  const view = new BrowserView({
    webPreferences: {
      preload: preloadPath,
      plugins: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      spellcheck: false,
      partition: 'persist:demo-test-verify',
    },
  });
  host.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, width: 900, height: 700 });
  manager.registerView(view.webContents.id, { mode: 'ppapi', generation: 1, token: 'verify' });

  await view.webContents.loadURL(url);
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const probe = await view.webContents.executeJavaScript(`(() => {
    const badge = document.getElementById('baoflash-test-badge');
    return {
      badge: Boolean(badge),
      badgeText: badge ? badge.textContent : '',
      head: Boolean(badge && badge.querySelector('.bf-head')),
      body: Boolean(badge && badge.querySelector('.bf-body')),
      collapseBtn: Boolean(badge && badge.querySelector('.bf-collapsed') === null) && Boolean(badge && Array.from(badge.querySelectorAll('.bf-btn')).some((b) => b.textContent === '—')),
      closeBtn: Boolean(badge && Array.from(badge.querySelectorAll('.bf-btn')).some((b) => b.textContent === '×')),
      bridge: window.__baoflashTest ? window.__baoflashTest.visits : null,
      mainBridge: window.__baoflashTest ? true : false,
    };
  })()`);
  check('badge rendered', probe.badge === true, probe.badgeText);
  check('badge drag handle present', probe.head === true && probe.body === true);
  check('badge collapse/close buttons present', probe.collapseBtn === true && probe.closeBtn === true);
  check('badge shows visit count', /访问计数\(持久化\):\d+/.test(probe.badgeText), probe.badgeText);
  check('page-world bridge flag visible from main world', probe.mainBridge === true && probe.bridge >= 1, probe.bridge);

  host.destroy();
  srv.close();
  console.log(`[demo-test-verify] ${failures.length === 0 ? 'ALL PASS' : 'FAILURES: ' + failures.join(', ')}`);
  app.exit(failures.length === 0 ? 0 : 1);
});
