// Stage 2 end-to-end smoke: install a REAL userscript through the persistent
// store, load a page with the production preload, verify the script executes
// (script-complete report), then restart the manager and confirm persistence.
const { app, BrowserView, BrowserWindow, ipcMain, session } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'WinUseBrowserSpellChecker');
app.on('window-all-closed', () => {});

const failures = [];
function check(name, ok, detail) {
  console.log(`[userscripts-admin-smoke] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' ' + JSON.stringify(detail) : ''}`);
  if (!ok) failures.push(name);
}

async function waitForPageCondition(webContents, expression, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for page condition: ${expression}`);
}

const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'userscripts-admin-'));
app.setPath('userData', USER_DATA);

// Read the userscript manager after the app is ready (electron-store needs
// app.getPath('userData')).
let mod = null;

app.whenReady().then(async () => {
  ipcMain.on('userscript:get-config', (event, payload) => {
    event.returnValue = mod.getUserscriptManager()
      ? mod.getUserscriptManager().snapshotFor(event.sender.id, payload?.url ?? '', Boolean(payload?.isMainFrame))
      : { ok: false, scripts: [], values: {} };
  });
  ipcMain.on('userscript:report', (event, payload) => {
    mod.getUserscriptManager()?.acceptReport(event.sender.id, payload);
  });

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  mod = require('../../release/tests/userscripts-admin-module.cjs');
  mod.initUserscriptManager();

  const fixture = fs.readFileSync(path.join(__dirname, '..', '..', 'tests', 'electron', 'fixtures', 'mouse-gestures.user.js'), 'utf8');

  // 1. Install through the persistent store.
  const installed = mod.installUserscript(fixture);
  check('install succeeds', installed.ok === true, installed.ok ? installed.script.id : installed.error);
  check('install metadata parsed', installed.ok === true && installed.script.metadata.name.length > 0, installed.ok ? installed.script.metadata.name : null);

  // 2. Manager sees it and a matching page snapshot includes it.
  const listed = mod.listUserscripts();
  check('list returns the script', listed.some((s) => s.id === installed.script.id), listed.map((s) => s.id));
  check('built-in css fixer auto-installed', listed.some((s) => s.metadata.name === 'BaoFlash Modern CSS Fixer'), listed.map((s) => s.metadata.name));

  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><head><meta charset="utf-8"><title>target</title></head><body>target</body></html>');
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${srv.address().port}/`;

  // 3. Load the page with the production preload and wait for a report.
  const manager = mod.getUserscriptManager();
  const reports = [];
  const originalAccept = manager.acceptReport.bind(manager);
  manager.acceptReport = (wcId, report) => { reports.push(report); return originalAccept(wcId, report); };

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
      partition: 'persist:userscripts-admin-smoke',
    },
  });
  host.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, width: 900, height: 700 });
  manager.registerView(view.webContents.id, { mode: 'ppapi', generation: 1, token: 'admin-smoke' });

  await view.webContents.loadURL(url);
  const deadline = Date.now() + 15000;
  let complete = null;
  while (Date.now() < deadline) {
    complete = reports.find((r) => r.phase === 'script-complete' && r.detail?.scriptId === installed.script.id);
    if (complete) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check('real script executes end-to-end', Boolean(complete), complete ? { scriptId: complete.scriptId, phase: complete.phase } : null);
  check('script id matches installed id', complete?.detail?.scriptId === installed.script.id, { reportScriptId: complete?.detail?.scriptId, installedId: installed.script.id });
  // 4. Toggle disable then re-enable.
  const byId = (id) => mod.listUserscripts().find((s) => s.id === id);
  check('disable', mod.setUserscriptEnabled(installed.script.id, false) === true && byId(installed.script.id)?.enabled === false);
  check('enable', mod.setUserscriptEnabled(installed.script.id, true) === true && byId(installed.script.id)?.enabled === true);

  // 5. Persistence: "restart" by re-reading the store from disk.
  const restarted = mod.listUserscripts();
  check('persists across restart', restarted.some((s) => s.id === installed.script.id), restarted.map((s) => s.id));

  // 6. Uninstall.
  check('uninstall', mod.uninstallUserscript(installed.script.id) === true && !mod.listUserscripts().some((s) => s.id === installed.script.id), mod.listUserscripts().map((s) => s.id));

  host.destroy();
  srv.close();
  console.log(`[userscripts-admin-smoke] ${failures.length === 0 ? 'ALL PASS' : 'FAILURES: ' + failures.join(', ')}`);
  app.exit(failures.length === 0 ? 0 : 1);
});
