const { app, BrowserView, BrowserWindow } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
app.on('window-all-closed', () => {});
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'automation-authoring-')));

function check(name, ok, detail) {
  console.log(`[automation-authoring] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` ${JSON.stringify(detail)}` : ''}`);
  if (!ok) throw new Error(name);
}

app.whenReady().then(async () => {
  const { BrowserViewAutomationCoreSession, detectGameSurfaces, gameSurfaceFeatureFromCandidate, encodeGameSurfaceFeature, inspectWithPasswordCapturePaused, setupCapture, teardownCapture, getCdpLeaseOwner } = require('../../release/tests/automation-authoring-core.cjs');
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><canvas width="760" height="150" style="width:760px;height:150px"></canvas><script>window.clicks=0;document.querySelector("canvas").addEventListener("click",()=>window.clicks++);</script>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const win = new BrowserWindow({ show: true, width: 640, height: 480 });
  const view = new BrowserView({ webPreferences: { nodeIntegration: false, contextIsolation: true } });
  win.addBrowserView(view); view.setBounds({ x: 0, y: 0, width: 640, height: 480 });
  await view.webContents.loadURL(`http://127.0.0.1:${server.address().port}/`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const source = { manifest: { format: 'baoauto', formatVersion: 3, id: 'smoke', name: 'Smoke', frontends: { workflow: 'workflow.json', scripts: [] }, features: [], integrity: {} }, workflow: { formatVersion: 3, id: 'smoke-workflow', name: 'Smoke', root: { id: 'root', kind: 'sequence', nodes: [] } }, scripts: new Map(), assets: new Map(), profiles: new Map() };
  let released = false;
  const handle = {
    tabId: 'smoke-tab', webContents: view.webContents, ready: Promise.resolve(),
    getCssViewport: () => ({ width: 640, height: 480 }),
    getViewportTransform: () => ({ logicalSize: { width: 640, height: 480 }, displaySize: { width: 640, height: 480 }, scaleX: 1, scaleY: 1 }),
    getViewportRevision: () => 1, assertCurrent: () => {},
    release: () => { released = true; },
  };
  // Electron 11's main-process Node runtime has no native AbortController.
  global.AbortController = undefined;
  const session = new BrowserViewAutomationCoreSession(handle, source);
  const frame = await session.capturePreview();
  check('real BrowserView capture works without native AbortController', frame.width === 640 && frame.height === 480, { width: frame.width, height: frame.height, captureMs: frame.captureMs });
  let ocrError = '';
  try { await session.testTextPreview('购买'); } catch (error) { ocrError = String(error && error.message || error); }
  check('OCR authoring reaches provider instead of crashing at AbortController', !ocrError.includes('AbortController is not defined'), { ocrError });
  setupCapture(view.webContents);
  await new Promise((resolve) => setTimeout(resolve, 50));
  check('password capture owns CDP before Surface inspection', getCdpLeaseOwner(view.webContents.id) === 'password-capture');
  const surfaces = await inspectWithPasswordCapturePaused(view.webContents, detectGameSurfaces);
  check('real game-surface detection finds canvas', surfaces.some((item) => item.kind === 'canvas'), surfaces);
  check('password capture is restored after Surface inspection', getCdpLeaseOwner(view.webContents.id) === 'password-capture');
  teardownCapture(view.webContents);
  await session.close();
  check('authoring session releases BrowserView lease', released);
  const canvas = surfaces.find((item) => item.kind === 'canvas');
  const feature = encodeGameSurfaceFeature(gameSurfaceFeatureFromCandidate(canvas));
  const runtimeSource = {
    ...source,
    workflow: { formatVersion: 3, id: 'runtime-workflow', name: 'Runtime Surface', root: {
      id: 'surface', kind: 'with', surface: { kind: 'visual', visualHint: 'canvas', fingerprint: feature }, body: {
        id: 'body', kind: 'sequence', nodes: [
          { id: 'log', kind: 'action', action: { kind: 'log', message: 'surface-ready' } },
          { id: 'click', kind: 'action', action: { kind: 'click', target: { locator: { kind: 'coordinate', point: { unit: 'ratio', x: .5, y: .5 } } }, button: 'primary', count: 1 } },
        ],
      },
    } },
  };
  let runtimeReleased = false; const runtimeLogs = [];
  let runtimeDisplay = { width: 640, height: 480 };
  const runtimeHandle = {
    ...handle,
    getCssViewport: () => ({ width: 1280, height: 720 }),
    getViewportTransform: () => ({
      logicalSize: { width: 1280, height: 720 }, displaySize: { ...runtimeDisplay },
      scaleX: runtimeDisplay.width / 1280, scaleY: runtimeDisplay.height / 720,
    }),
    waitForViewport: async () => undefined,
    release: () => { runtimeReleased = true; },
  };
  const runtimeSession = new BrowserViewAutomationCoreSession(runtimeHandle, runtimeSource, undefined, (message) => runtimeLogs.push(message));
  // Keep one Core session alive while the BrowserView changes from its initial
  // size to a different aspect/scale. Surface-relative input must use the new
  // transform, not the constructor-time viewport.
  view.setBounds({ x: 0, y: 0, width: 900, height: 600 });
  runtimeDisplay = { width: 900, height: 600 };
  await new Promise((resolve) => setTimeout(resolve, 100));
  const runtimeResult = await runtimeSession.startWorkflow().completion;
  check('selected game surface resolves during real workflow execution', runtimeResult.status === 'completed', runtimeResult);
  check('workflow log action reaches runtime log port', runtimeLogs.includes('surface-ready'), runtimeLogs);
  check('surface-relative coordinate click reaches the selected canvas', await view.webContents.executeJavaScript('window.clicks') === 1);
  check('surface-relative coordinate survives a BrowserView resize', runtimeResult.status === 'completed' && runtimeDisplay.width === 900);
  check('completed workflow releases BrowserView lease', runtimeReleased);
  win.destroy(); server.close(); app.exit(0);
}).catch((error) => { console.error('[automation-authoring] FAIL', error); app.exit(1); });
