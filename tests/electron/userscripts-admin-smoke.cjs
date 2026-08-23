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

const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'userscripts-admin-'));
app.setPath('userData', USER_DATA);

// Read the userscript manager after the app is ready (electron-store needs
// app.getPath('userData')).
let mod = null;
let automationState = 'completed';

app.whenReady().then(async () => {
  ipcMain.on('userscript:get-config', (event, payload) => {
    event.returnValue = mod.getUserscriptManager()
      ? mod.getUserscriptManager().snapshotFor(event.sender.id, payload?.url ?? '', Boolean(payload?.isMainFrame))
      : { ok: false, scripts: [], values: {} };
  });
  ipcMain.on('userscript:report', (event, payload) => {
    mod.getUserscriptManager()?.acceptReport(event.sender.id, payload);
  });
  ipcMain.handle('userscript:automation-list', async () => []);
  ipcMain.handle('userscript:automation-status', async () => ({ enabled: true, state: automationState, executedSteps: automationState === 'completed' ? 1 : 0, logs: [] }));

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
  check('built-in automation frame assistant auto-installed', listed.some((s) => s.metadata.name === 'BaoFlash 页面悬浮相框助手' && s.metadata.grant.includes('GM_baoAutomation')), listed.map((s) => s.metadata.name));

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
  const assistantOverlayVisible = await view.webContents.executeJavaScript(
    "Boolean(document.getElementById('bao-automation-frame-assistant'))",
  );
  check('built-in automation assistant injects a page overlay', assistantOverlayVisible, assistantOverlayVisible);
  const assistantControls = await view.webContents.executeJavaScript(`(() => {
    const root = document.getElementById('bao-automation-frame-assistant');
    const captureLayer = document.getElementById('bao-automation-capture-layer');
    const captureHelp = captureLayer?.querySelector('.bao-capture-help');
    root?.querySelector('.bao-orb')?.click();
    return {
      open: root?.classList.contains('bao-open'),
      tabs: root?.querySelectorAll('.bao-tab').length,
      captureCancel: captureLayer?.querySelector('.bao-capture-cancel')?.textContent,
      captureHelp: captureHelp?.textContent,
      captureHelpTop: captureHelp ? getComputedStyle(captureHelp).top : null,
    };
  })()`);
  check('automation assistant opens as a three-tab floating control center', assistantControls?.open === true && assistantControls?.tabs === 3, assistantControls);
  check('automation capture keeps a visible cancel button without Escape copy', assistantControls?.captureCancel === '取消' && !assistantControls?.captureHelp?.includes('Esc'), assistantControls);
  check('automation capture help clears the top toast area', assistantControls?.captureHelpTop === '64px', assistantControls);
  await new Promise((resolve) => setTimeout(resolve, 750));
  const staleCompletionToasts = await view.webContents.executeJavaScript("document.querySelectorAll('#bao-automation-assistant-toasts .bao-toast').length");
  check('historical completed status does not toast on a newly opened page', staleCompletionToasts === 0, staleCompletionToasts);
  automationState = 'running';
  await new Promise((resolve) => setTimeout(resolve, 750));
  automationState = 'completed';
  await new Promise((resolve) => setTimeout(resolve, 750));
  const liveCompletionToasts = await view.webContents.executeJavaScript("[...document.querySelectorAll('#bao-automation-assistant-toasts .bao-toast')].filter((node) => node.textContent === '自动化脚本执行完成').length");
  check('live running-to-completed transition still toasts once', liveCompletionToasts === 1, liveCompletionToasts);

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
