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
  ipcMain.handle('userscript:automation-coordinate-begin', async () => ({ ready: true }));
  ipcMain.handle('userscript:automation-coordinate-end', async () => ({ released: true }));
  ipcMain.handle('userscript:automation-game-surfaces', async () => ({
    candidates: [
      { id: 'abcdef0123456789-0', fingerprint: 'abcdef', kind: 'flash', label: '测试 Flash', frameDepth: 2, frameUrl: 'http://frame.test/game', source: 'game.swf', rect: { x: 100, y: 120, width: 600, height: 400 }, score: 150 },
      { id: 'abcdef0123456789-1', fingerprint: 'frame', kind: 'frame', label: 'iframe 游戏区域候选', frameDepth: 2, frameUrl: 'http://frame.test/game', source: 'http://frame.test/game', rect: { x: 90, y: 110, width: 620, height: 420 }, score: 50 },
    ],
    bound: null,
  }));
  ipcMain.handle('userscript:automation-game-surface-bind', async (_event, payload) => ({
    bound: { id: payload.candidateId, fingerprint: 'abcdef', kind: 'flash', label: '测试 Flash', frameDepth: 2, frameUrl: 'http://frame.test/game', source: 'game.swf', rect: { x: 100, y: 120, width: 600, height: 400 }, score: 150 },
  }));
  ipcMain.handle('userscript:automation-game-surface-clear', async () => ({ cleared: true }));

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
  const assistantControls = await view.webContents.executeJavaScript(`(async () => {
    const root = document.getElementById('bao-automation-frame-assistant');
    const captureLayer = document.getElementById('bao-automation-capture-layer');
    const captureHelp = captureLayer?.querySelector('.bao-capture-help');
    if (root) root.style.transition = 'none';
    const orb = root?.querySelector('.bao-orb');
    orb?.focus();
    const focusedButtonOutline = orb ? getComputedStyle(orb).outlineStyle : null;
    orb?.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const openWidth = root?.getBoundingClientRect().width;
    root?.classList.add('bao-right');
    if (root) { root.style.left = 'auto'; root.style.right = '8px'; }
    const orbRect = root?.querySelector('.bao-orb')?.getBoundingClientRect();
    const views = root?.querySelector('.bao-views');
    const outerOverflow = getComputedStyle(views).overflowY;
    root?.querySelector('[data-view="capture"]')?.click();
    const captureRect = root?.querySelector('[data-panel="capture"]')?.getBoundingClientRect();
    const viewsRect = views?.getBoundingClientRect();
    return {
      open: root?.classList.contains('bao-open'),
      tabs: root?.querySelectorAll('.bao-tab').length,
      width: openWidth,
      focusedButtonOutline,
      rightOrbVisible: Boolean(orbRect && orbRect.left >= 0 && orbRect.right <= innerWidth),
      logOverflow: getComputedStyle(root?.querySelector('.bao-log')).overflowY,
      outerOverflow,
      captureHeight: root?.getBoundingClientRect().height,
      captureFits: Boolean(captureRect && viewsRect && captureRect.bottom <= viewsRect.bottom + 1),
      removedSectionsPresent: root?.textContent.includes('命名规则') || root?.textContent.includes('最近保存') || root?.textContent.includes('显示方式'),
      captureCancel: captureLayer?.querySelector('.bao-capture-cancel')?.textContent,
      captureHelp: captureHelp?.textContent,
      captureHelpTop: captureHelp ? getComputedStyle(captureHelp).top : null,
    };
  })()`);
  check('automation assistant opens as a three-tab floating control center', assistantControls?.open === true && assistantControls?.tabs === 3, assistantControls);
  check('automation assistant uses a compact panel and scrollable run log', assistantControls?.width > 300 && assistantControls?.width <= 320 && assistantControls?.logOverflow === 'auto', assistantControls);
  check('automation assistant buttons do not retain a visible focus outline', assistantControls?.focusedButtonOutline === 'none', assistantControls);
  check('automation assistant avoids an outer scrollbar and fully fits Capture tools', assistantControls?.outerOverflow === 'hidden' && assistantControls?.captureHeight >= 175 && assistantControls?.captureFits === true, assistantControls);
  check('automation assistant keeps the orb visible when docked on the right', assistantControls?.rightOrbVisible === true, assistantControls);
  check('automation assistant removes low-value placeholder sections', assistantControls?.removedSectionsPresent === false, assistantControls);
  const staysOpenOnResize = await view.webContents.executeJavaScript(`(() => { const root = document.getElementById('bao-automation-frame-assistant'); root?.classList.add('bao-open'); window.dispatchEvent(new Event('resize')); return root?.classList.contains('bao-open') || false; })()`);
  check('automation assistant remains open when the page viewport changes', staysOpenOnResize === true, staysOpenOnResize);
  check('automation capture keeps a visible cancel button without Escape copy', assistantControls?.captureCancel === '取消' && !assistantControls?.captureHelp?.includes('Esc'), assistantControls);
  check('automation capture help clears the top toast area', assistantControls?.captureHelpTop === '64px', assistantControls);
  const coordinatePicker = await view.webContents.executeJavaScript(`(async () => {
    const root = document.getElementById('bao-automation-frame-assistant');
    root?.querySelector('[data-view="capture"]')?.click();
    root?.querySelector('.bao-coordinate')?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const layer = document.getElementById('bao-automation-coordinate-layer');
    const x = Math.round(innerWidth * 0.625); const y = Math.round(innerHeight * 0.375);
    layer?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y }));
    const shown = layer?.querySelector('.bao-coordinate-value')?.textContent;
    const expected = Math.round(x / Math.max(1, innerWidth - innerWidth / 1280) * 10000) + ',' + Math.round(y / Math.max(1, innerHeight - innerHeight / 720) * 10000);
    const activeBeforeEscape = layer?.classList.contains('bao-active') || false;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { activeBeforeEscape, activeAfterEscape: layer?.classList.contains('bao-active') || false, shown, expected, panelReopened: root?.classList.contains('bao-open') || false };
  })()`);
  check('coordinate picker shows directly reusable normalized X,Y values', coordinatePicker?.activeBeforeEscape === true && coordinatePicker?.shown === coordinatePicker?.expected, coordinatePicker);
  check('coordinate picker exits with Escape and reopens Capture', coordinatePicker?.activeAfterEscape === false && coordinatePicker?.panelReopened === true, coordinatePicker);
  const coordinateCopy = await view.webContents.executeJavaScript(`(async () => {
    let pageClicks = 0;
    document.querySelector('#bao-automation-frame-assistant .bao-coordinate')?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    document.addEventListener('click', () => { pageClicks += 1; }, { once: true });
    const layer = document.getElementById('bao-automation-coordinate-layer');
    const x = Math.round(innerWidth * 0.4); const y = Math.round(innerHeight * 0.6);
    layer?.dispatchEvent(new PointerEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { copied: layer?.getAttribute('data-last-copied'), expected: Math.round(x / Math.max(1, innerWidth - innerWidth / 1280) * 10000) + ',' + Math.round(y / Math.max(1, innerHeight - innerHeight / 720) * 10000), pageClicks, active: layer?.classList.contains('bao-active') || false };
  })()`);
  check('coordinate click copies X,Y, exits, and does not reach the page', coordinateCopy?.copied === coordinateCopy?.expected && coordinateCopy?.pageClicks === 0 && coordinateCopy?.active === false, coordinateCopy);
  const gameSurfacePicker = await view.webContents.executeJavaScript(`(async () => {
    const root = document.getElementById('bao-automation-frame-assistant');
    root?.classList.add('bao-open'); root?.querySelector('[data-view="capture"]')?.click();
    root?.querySelector('.bao-game-select')?.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const layer = document.getElementById('bao-automation-game-layer');
    const candidate = layer?.querySelector('.bao-game-candidate');
    const boxes = [...(layer?.querySelectorAll('.bao-game-candidate') || [])];
    const options = [...(layer?.querySelectorAll('.bao-game-option') || [])];
    const flashAboveFrame = Number(boxes[0]?.style.zIndex) > Number(boxes[1]?.style.zIndex);
    const listHasFlash = options.length === 2 && options[0]?.textContent?.includes('测试 Flash') && options[0]?.textContent?.includes('600 × 400');
    const visible = layer?.classList.contains('bao-active') || false;
    candidate?.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    return { visible, flashAboveFrame, listHasFlash, candidates: layer?.querySelectorAll('.bao-game-candidate').length, closed: !layer?.classList.contains('bao-active'), button: root?.querySelector('.bao-game-select')?.textContent };
  })()`);
  check('game surface picker exposes a list fallback when PPAPI covers precise candidate boxes', gameSurfacePicker?.visible === true && gameSurfacePicker?.flashAboveFrame === true && gameSurfacePicker?.listHasFlash === true && gameSurfacePicker?.candidates === 0 && gameSurfacePicker?.closed === true && gameSurfacePicker?.button?.includes('测试 Flash'), gameSurfacePicker);
  const gameCoordinatePicker = await view.webContents.executeJavaScript(`(async () => {
    const root = document.getElementById('bao-automation-frame-assistant');
    root?.querySelector('.bao-coordinate')?.click();
    await new Promise((resolve) => setTimeout(resolve, 40));
    const layer = document.getElementById('bao-automation-coordinate-layer');
    const x = 100 + 600 * 0.4; const y = 120 + 400 * 0.6;
    layer?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: y }));
    const expected = Math.round((x - 100) / Math.max(1, 600 - innerWidth / 1280) * 10000) + ',' + Math.round((y - 120) / Math.max(1, 400 - innerHeight / 720) * 10000);
    const shown = layer?.querySelector('.bao-coordinate-value')?.textContent;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { shown, expected };
  })()`);
  check('game coordinate picker uses the same endpoint transform as runtime', gameCoordinatePicker?.shown === gameCoordinatePicker?.expected, gameCoordinatePicker);
  const gameSurfaceFeature = await view.webContents.executeJavaScript(`(async () => {
    const root = document.getElementById('bao-automation-frame-assistant');
    const copy = root?.querySelector('.bao-game-copy');
    copy?.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const feature = copy?.getAttribute('data-last-copied') || '';
    root?.querySelector('.bao-game-clear')?.click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { feature, selected: root?.querySelector('.bao-game-select')?.textContent, bound: root?.querySelector('.bao-game-actions')?.classList.contains('bao-bound') || false };
  })()`);
  check('game surface feature is directly copyable and selection can be cleared', gameSurfaceFeature?.feature?.startsWith('BFG1:') && gameSurfaceFeature?.selected === '选择游戏画面' && gameSurfaceFeature?.bound === false, gameSurfaceFeature);
  await waitForPageCondition(
    view.webContents,
    "document.querySelector('#bao-automation-frame-assistant .bao-state-title')?.textContent === '执行完成'",
  );
  const staleCompletionToasts = await view.webContents.executeJavaScript("[...document.querySelectorAll('#bao-automation-assistant-toasts .bao-toast')].filter((node) => node.textContent === '自动化脚本执行完成').length");
  check('historical completed status does not toast on a newly opened page', staleCompletionToasts === 0, staleCompletionToasts);
  automationState = 'running';
  await waitForPageCondition(
    view.webContents,
    "document.querySelector('#bao-automation-frame-assistant .bao-state-title')?.textContent === '正在执行'",
  );
  automationState = 'completed';
  await waitForPageCondition(
    view.webContents,
    "[...document.querySelectorAll('#bao-automation-assistant-toasts .bao-toast')].filter((node) => node.textContent === '自动化脚本执行完成').length === 1",
  );
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
