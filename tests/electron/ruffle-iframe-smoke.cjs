// Smoke: does the userscript runtime execute in an IFRAME under RUFFLE mode?
// (contextIsolation: false). PPAPI mode is known to work; Ruffle mode may
// differ because the preload shares the page world.
const { app, BrowserView, BrowserWindow, ipcMain } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'WinUseBrowserSpellChecker');
app.on('window-all-closed', () => {});
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ruffle-iframe-'));
app.setPath('userData', USER_DATA);

const failures = [];
function check(name, ok, detail) {
  console.log(`[ruffle-iframe] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' ' + JSON.stringify(detail) : ''}`);
  if (!ok) failures.push(name);
}

app.whenReady().then(async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../../release/tests/userscripts-admin-module.cjs');
  mod.initUserscriptManager();
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'demo-test.user.js'), 'utf8');
  const installed = mod.installUserscript(fixture);
  const manager = mod.getUserscriptManager();
  check('demo script installed', installed.ok === true && Boolean(mod.listUserscripts().find((s) => s.id === installed.script.id)));

  ipcMain.on('userscript:get-config', (event, payload) => {
    event.returnValue = manager.snapshotFor(event.sender.id, payload?.url ?? '', Boolean(payload?.isMainFrame));
  });
  ipcMain.on('userscript:report', (event, payload) => {
    manager.acceptReport(event.sender.id, payload);
  });
  ipcMain.on('userscript:menu-register', (event, payload) => {
    manager.registerMenuCommand(event.sender.id, payload.scriptId, payload.documentId, payload.title, payload.commandId, Boolean(payload.isMainFrame));
  });
  ipcMain.handle('userscript:automation-v3-list', async () => [{
    packageId: 'smoke-package', name: 'Smoke Automation', assets: ['assets/button.png'], profiles: [],
    frontends: [{ id: 'workflow', kind: 'blockly', name: 'Smoke Workflow' }],
  }]);
  ipcMain.handle('userscript:automation-v3-status', async () => ({ state: 'idle' }));
  const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9WQAAAABJRU5ErkJggg==';
  ipcMain.handle('userscript:automation-v3-asset-preview', async () => ({ dataUrl: pixel, width: 1, height: 1 }));
  ipcMain.handle('userscript:automation-v3-match', async () => ({ dataUrl: pixel, previewWidth: 1280, previewHeight: 720, sourceWidth: 1280, sourceHeight: 720, candidate: { x: 10, y: 20, width: 30, height: 40, score: .97, scale: 1, matchMs: 2 }, matched: true, threshold: .9, captureMs: 3 }));
  ipcMain.handle('userscript:automation-v3-ocr', async () => ({ dataUrl: pixel, previewWidth: 1280, previewHeight: 720, sourceWidth: 1280, sourceHeight: 720, candidates: [{ text: '购买', score: .96, x: 40, y: 50, width: 60, height: 30, matched: true }], matched: true, captureMs: 3, ocrMs: 4 }));
  ipcMain.handle('userscript:automation-v3-capture', async () => ({ token: '0123456789abcdef0123456789abcdef', dataUrl: pixel, previewWidth: 1280, previewHeight: 720, sourceWidth: 1280, sourceHeight: 720, captureMs: 3 }));
  ipcMain.handle('userscript:automation-v3-save-capture', async () => ({ asset: 'assets/smoke.png' }));
  ipcMain.handle('userscript:automation-v3-surfaces', async () => [{ id: 'surface-1', fingerprint: 'fingerprint', kind: 'canvas', label: 'Game Canvas', frameDepth: 0, frameUrl: '', source: '', rect: { x: 20, y: 30, width: 640, height: 480 }, score: 90 }]);

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
  await view.webContents.executeJavaScript(`document.querySelector('#bao-automation-frame-assistant .bao-orb')?.click()`);
  await new Promise((resolve) => setTimeout(resolve, 150));

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
      automationAssistant: Boolean(document.getElementById('bao-automation-frame-assistant')),
      automationAssistantOpen: document.getElementById('bao-automation-frame-assistant')?.classList.contains('bao-open') === true,
      automationPackage: document.querySelector('#bao-automation-frame-assistant .bao-package-run option')?.textContent || '',
      iframes: document.querySelectorAll('iframe').length,
      subBadge,
      subBridge,
    };
  })()`);
  check('main-frame badge present', probe.mainBadge === true, probe);
  check('Automation 2.0 floating assistant present', probe.automationAssistant === true, probe);
  check('Automation 2.0 assistant opens and reads Core packages', probe.automationAssistantOpen === true && probe.automationPackage === 'Smoke Automation', probe);
  const interactions = await view.webContents.executeJavaScript(`(async () => {
    const root = document.getElementById('bao-automation-frame-assistant');
    root.querySelector('[data-view="match"]').click();
    root.querySelector('.bao-compare').click();
    await new Promise(r => setTimeout(r, 80));
    const imageResult = root.querySelector('.bao-result').textContent;
    root.querySelector('[data-match-mode="text"]').click();
    root.querySelector('.bao-ocr-text').value = '购买';
    root.querySelector('.bao-compare').click();
    await new Promise(r => setTimeout(r, 80));
    const textResult = root.querySelector('.bao-result').textContent;
    root.querySelector('[data-view="capture"]').click();
    root.querySelector('.bao-capture').click();
    await new Promise(r => setTimeout(r, 80));
    const captureActive = document.getElementById('bao-automation-capture-layer').classList.contains('bao-active');
    const captureLayer = document.getElementById('bao-automation-capture-layer');
    const captureImage = captureLayer.querySelector('.bao-capture-image');
    captureImage.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 450, width: 800, height: 450, x: 0, y: 0, toJSON() {} });
    captureLayer.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 20 }));
    captureLayer.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 220, clientY: 140 }));
    const selection = captureLayer.querySelector('.bao-selection');
    selection.getBoundingClientRect = () => ({ left: 20, top: 20, right: 220, bottom: 140, width: 200, height: 120, x: 20, y: 20, toJSON() {} });
    captureLayer.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 220, clientY: 140 }));
    captureLayer.querySelector('.bao-capture-name').value = 'smoke.png';
    captureLayer.querySelector('.bao-save-crop').click();
    await new Promise(r => setTimeout(r, 80));
    const captureSaved = !captureLayer.classList.contains('bao-active');
    root.querySelector('.bao-coordinate').click();
    await new Promise(r => setTimeout(r, 20));
    const coordinateActive = document.getElementById('bao-automation-coordinate-layer').classList.contains('bao-active');
    document.getElementById('bao-automation-coordinate-layer').dispatchEvent(new PointerEvent('click', { bubbles: true, clientX: 300, clientY: 250 }));
    await new Promise(r => setTimeout(r, 30));
    const coordinateCopied = document.getElementById('bao-automation-coordinate-layer').getAttribute('data-last-copied');
    root.querySelector('.bao-game-select').click();
    await new Promise(r => setTimeout(r, 80));
    const surfaceActive = document.getElementById('bao-automation-game-layer').classList.contains('bao-active');
    document.querySelector('#bao-automation-game-layer .bao-game-cancel').click();
    const orb = root.querySelector('.bao-orb'); const before = root.style.top;
    orb.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7, clientX: 20, clientY: 80 }));
    orb.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 7, clientX: 180, clientY: 180, movementX: 160, movementY: 100 }));
    orb.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7, clientX: 180, clientY: 180 }));
    return { imageResult, textResult, captureActive, captureSaved, coordinateActive, coordinateCopied, surfaceActive, dragged: root.style.top !== before };
  })()`);
  check('assistant image recognition action responds', /匹配成功/.test(interactions.imageResult), interactions);
  check('assistant OCR action responds', /找到 1 处匹配文字/.test(interactions.textResult), interactions);
  check('assistant capture overlay responds', interactions.captureActive === true, interactions);
  check('assistant capture selection saves through Core package service', interactions.captureSaved === true, interactions);
  check('assistant coordinate overlay responds', interactions.coordinateActive === true && Boolean(interactions.coordinateCopied), interactions);
  check('assistant game surface overlay responds', interactions.surfaceActive === true, interactions);
  check('assistant orb is draggable', interactions.dragged === true, interactions);
  check('iframe exists', probe.iframes >= 1, probe);
  check('iframe badge present (sub-frame script ran)', probe.subBadge === true, probe);

  host.destroy();
  srv.close();
  console.log(`[ruffle-iframe] ${failures.length === 0 ? 'ALL PASS' : 'FAILURES: ' + failures.join(', ')}`);
  app.exit(failures.length === 0 ? 0 : 1);
});
