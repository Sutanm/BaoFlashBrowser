// Smoke: GM_registerMenuCommand dedupe across main frame + iframe.
// The same script registers 2 commands in BOTH the main frame and the iframe.
// The demo contributes exactly 2 commands (main-frame ones only), and invoking
// them must actually run the callback in the page. Built-ins may add commands.
const { app, BrowserView, BrowserWindow, ipcMain } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'WinUseBrowserSpellChecker');
app.on('window-all-closed', () => {});
const OWNS_USER_DATA = !process.env.BAO_SMOKE_USER_DATA;
const USER_DATA = process.env.BAO_SMOKE_USER_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'menu-command-dedupe-'));
app.setPath('userData', USER_DATA);

const failures = [];
function check(name, ok, detail) {
  console.log(`[menu-dedupe] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' ' + JSON.stringify(detail) : ''}`);
  if (!ok) failures.push(name);
}

const logEvents = [];
ipcMain.on('userscript:log', (_event, payload) => { logEvents.push(payload); });

app.whenReady().then(async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../../release/tests/userscripts-admin-module.cjs');
  mod.initUserscriptManager();
  const manager = mod.getUserscriptManager();
  const demoSource = fs.readFileSync(path.join(__dirname, 'fixtures', 'demo-test.user.js'), 'utf8');
  mod.installUserscript(demoSource, { id: 'baoflash-demo-test', enabled: true });
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
  ipcMain.on('userscript:menu-unregister', (event, payload) => {
    manager.unregisterMenuCommand(event.sender.id, payload.commandId);
  });
  ipcMain.on('userscript:menu-invoked', (event, payload) => {
    manager.acceptReport(event.sender.id, {
      documentId: payload.documentId,
      frameUrl: '',
      isMainFrame: false,
      mode: 'ppapi',
      generation: 1,
      phase: 'command-invoked',
      detail: payload,
      accepted: true,
    });
  });
  ipcMain.handle('userscript:automation-list', async () => []);
  ipcMain.handle('userscript:automation-status', async () => ({ state: 'idle', executedSteps: 0, logs: [] }));

  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (req.url === '/frame.html') {
      res.end('<!doctype html><html><head><meta charset="utf-8"><title>sub</title></head><body><p>subframe</p></body></html>');
    } else {
      res.end('<!doctype html><html><head><meta charset="utf-8"><title>main</title></head><body><p>main</p><iframe src="/frame.html" width="300" height="200"></iframe></body></html>');
    }
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
      partition: 'persist:menu-dedupe',
    },
  });
  host.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, width: 900, height: 700 });
  manager.registerView(view.webContents.id, { mode: 'ppapi', generation: 1, token: 'dedupe' });

  await view.webContents.loadURL(url);
  await new Promise((resolve) => setTimeout(resolve, 2500));

  const commands = manager.commandsFor(view.webContents.id);
  const demoCommands = commands.filter((command) => command.scriptId === 'baoflash-demo-test');
  check('demo contributes exactly 2 commands after main+iframe registration', demoCommands.length === 2, commands.map((c) => c.title));
  check('all listed commands are main-frame ones', commands.every((c) => c.isMainFrame), commands);

  const reset = commands.find((c) => c.title === '重置访问计数');
  check('reset-counter command present', Boolean(reset));
  if (reset) {
    view.webContents.send('userscript:menu-invoke', { commandId: reset.commandId, documentId: reset.documentId });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const text = await view.webContents.executeJavaScript(
      `document.getElementById('baoflash-test-badge')?.textContent || ''`,
    );
    check('invoked command actually ran in the page (counter reset to 0)', /访问计数\(持久化\):0\b/.test(text), text);
  }

  host.destroy();
  srv.close();
  mod.uninstallUserscript('baoflash-demo-test');
  check('GM_log reached main process', logEvents.some((l) => String(l.message).includes('probe-log-marker')));
  console.log(`[menu-dedupe] ${failures.length === 0 ? 'ALL PASS' : 'FAILURES: ' + failures.join(', ')}`);
  if (OWNS_USER_DATA) {
    try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  app.exit(failures.length === 0 ? 0 : 1);
});
