const { app, BrowserView, BrowserWindow, nativeImage } = require('electron');
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
  const fixtureHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'automation-vision-e2e.html'));
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(fixtureHtml);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const win = new BrowserWindow({ show: true, width: 640, height: 480 });
  const view = new BrowserView({ webPreferences: { nodeIntegration: false, contextIsolation: true } });
  win.addBrowserView(view); view.setBounds({ x: 0, y: 0, width: 640, height: 480 });
  await view.webContents.loadURL(`http://127.0.0.1:${server.address().port}/`);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const targetAtCapture = await view.webContents.executeJavaScript(`(() => {
    const canvas = document.querySelector('canvas'); const bounds = canvas.getBoundingClientRect();
    const target = window.automationVisionTarget; const surface = window.automationVisionSurface;
    return { x: Math.round(bounds.x + target.x), y: Math.round(bounds.y + target.y), width: target.width, height: target.height, surface };
  })()`);
  const directTargetImage = await view.webContents.capturePage({ x: targetAtCapture.x, y: targetAtCapture.y, width: targetAtCapture.width, height: targetAtCapture.height });
  check('fixture exposes a capturable pixel target', !directTargetImage.isEmpty() && targetAtCapture.surface.width === 600, { ...targetAtCapture, directBitmap: directTargetImage.getSize() });
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
  const normalizedFrame = nativeImage.createFromBitmap(Buffer.from(frame.bitmap), { width: frame.width, height: frame.height });
  const targetImage = normalizedFrame.crop({ x: targetAtCapture.x, y: targetAtCapture.y, width: targetAtCapture.width, height: targetAtCapture.height });
  check('authoring target uses the normalized logical frame on HiDPI displays', targetImage.getSize().width === 56 && targetImage.getSize().height === 40, { directBitmap: directTargetImage.getSize(), normalizedBitmap: targetImage.getSize() });
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
  const visionSource = {
    ...source,
    manifest: {
      ...source.manifest,
      assetMetadata: {
        'assets/target.png': { source: 'capture', reference: { kind: 'surface', width: targetAtCapture.surface.width, height: targetAtCapture.surface.height } },
        'assets/target-alternative.png': { source: 'capture', reference: { kind: 'surface', width: targetAtCapture.surface.width, height: targetAtCapture.surface.height } },
      },
    },
    assets: new Map([
      ['assets/target.png', new Uint8Array(targetImage.toPNG())],
      ['assets/target-alternative.png', new Uint8Array(targetImage.toPNG())],
      ['assets/legacy-target.png', new Uint8Array(targetImage.toPNG())],
    ]),
    workflow: { formatVersion: 3, id: 'vision-workflow', name: 'Vision Surface', root: {
      id: 'vision-surface', kind: 'with', surface: { kind: 'visual', visualHint: 'canvas', fingerprint: feature }, body: {
        id: 'vision-body', kind: 'sequence', nodes: [
          { id: 'trusted-query', kind: 'query', assignTo: 'trustedFound', valueType: 'boolean', query: { kind: 'exists', resultType: 'boolean', locator: { kind: 'image', asset: 'target.png', alternatives: ['target-alternative.png'], threshold: .9 } } },
          { id: 'trusted-result', kind: 'if', condition: { kind: 'variable', valueType: 'boolean', name: 'trustedFound' }, then: { id: 'trusted-ok', kind: 'action', action: { kind: 'log', message: 'vision-trusted-found' } }, else: { id: 'trusted-missing', kind: 'action', action: { kind: 'log', message: 'vision-trusted-missing' } } },
          { id: 'legacy-query', kind: 'query', assignTo: 'legacyFound', valueType: 'boolean', query: { kind: 'exists', resultType: 'boolean', locator: { kind: 'image', asset: 'legacy-target.png', threshold: .9 } } },
          { id: 'legacy-result', kind: 'if', condition: { kind: 'variable', valueType: 'boolean', name: 'legacyFound' }, then: { id: 'legacy-ok', kind: 'action', action: { kind: 'log', message: 'vision-legacy-found' } }, else: { id: 'legacy-missing', kind: 'action', action: { kind: 'log', message: 'vision-legacy-missing' } } },
        ],
      },
    } },
  };
  let visionReleased = false; const visionLogs = [];
  let visionViewport = { width: 790, height: 480 };
  view.setBounds({ x: 0, y: 0, width: visionViewport.width, height: visionViewport.height });
  await new Promise((resolve) => setTimeout(resolve, 120));
  const visionHandle = {
    ...handle,
    getCssViewport: () => ({ ...visionViewport }),
    getViewportTransform: () => ({ logicalSize: { ...visionViewport }, displaySize: { ...visionViewport }, scaleX: 1, scaleY: 1 }),
    waitForViewport: async () => undefined,
    release: () => { visionReleased = true; },
  };
  const visionSession = new BrowserViewAutomationCoreSession(visionHandle, visionSource, undefined, (message) => visionLogs.push(message));
  const targetAtRuntime = await view.webContents.executeJavaScript(`(() => {
    const canvas = document.querySelector('canvas'); const bounds = canvas.getBoundingClientRect();
    return { bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, target: window.automationVisionTarget, surface: window.automationVisionSurface };
  })()`);
  const visionDiagnostic = await visionSession.testImagePreview('target.png', .9, [1.25], 'none', targetAtRuntime.bounds);
  check('predicted scale produces the expected resized target candidate', visionDiagnostic.bitmapMatch.score >= .9 && visionDiagnostic.bitmapMatch.width === 70 && visionDiagnostic.bitmapMatch.height === 50, { targetAtCapture, targetAtRuntime, match: visionDiagnostic.bitmapMatch });
  const visionResult = await visionSession.startWorkflow().completion;
  check('real OpenCV finds Surface-captured target after 1.25x resize', visionResult.status === 'completed' && visionLogs.includes('vision-trusted-found'), { visionResult, visionLogs });
  check('legacy image without metadata still matches through fallback scales', visionLogs.includes('vision-legacy-found'), visionLogs);
  check('vision workflow releases BrowserView lease', visionReleased);
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
