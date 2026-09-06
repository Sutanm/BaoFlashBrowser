const { app, BrowserView, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
const forcedDpr = process.env.BAO_PROBE_DPR;
if (forcedDpr) app.commandLine.appendSwitch('force-device-scale-factor', forcedDpr);
app.on('window-all-closed', () => {});
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'autoscale-')));
const timeout = setTimeout(() => { console.error('[scale-real] TIMEOUT'); app.exit(1); }, 90000);

app.whenReady().then(async () => {
  const { BrowserViewAutomationCoreSession } = require('../../release/tests/automation-authoring-core.cjs');
  const win = new BrowserWindow({ show: true, width: 1300, height: 760 });
  const VIEWPORT = { width: 1280, height: 720 };
  const view = new BrowserView({ webPreferences: { nodeIntegration: false, contextIsolation: true } });
  win.addBrowserView(view); view.setBounds({ x: 0, y: 0, ...VIEWPORT });
  const wc = view.webContents;
  await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#123}</style><div style="width:200px;height:100px;background:#e85d75"></div><script>window.__m={innerWidth,innerHeight,dpr:devicePixelRatio}</script>`));
  await new Promise((r) => setTimeout(r, 200));
  const metrics = await wc.executeJavaScript('window.__m');
  global.AbortController = undefined;

  // Multiple DPR passes
  const dprList = process.env.BAO_PROBE_DPR_LIST ? process.env.BAO_PROBE_DPR_LIST.split(',').map(Number) : [1.5];
  const results = [];
  for (const dpr of dprList) {
    const viewport = { width: VIEWPORT.width, height: VIEWPORT.height };
    const handle = {
      tabId: 't', webContents: wc, ready: Promise.resolve(),
      getCssViewport: () => ({ ...viewport }),
      getViewportTransform: () => ({ logicalSize: { ...viewport }, displaySize: { ...viewport }, scaleX: 1, scaleY: 1 }),
      getViewportRevision: () => 1, assertCurrent: () => {},
      release: () => {},
    };
    const session = new BrowserViewAutomationCoreSession(handle, {
      manifest: { format: 'baoauto', formatVersion: 3, id: 's', name: 'S', frontends: {}, features: [], integrity: {} },
      workflow: { formatVersion: 3, id: 'w', name: 'W', root: { id: 'r', kind: 'sequence', nodes: [] } },
      scripts: new Map(), assets: new Map(), profiles: new Map(),
    });
    const frame = await session.capturePreview();
    results.push({ dpr, metrics, logicalViewport: viewport, frameWidth: frame.width, frameHeight: frame.height, captureMs: frame.captureMs });
    await session.close();
  }
  fs.writeFileSync(path.join(__dirname, '..', '..', 'release', 'automation-probe', 'scale-real.json'), JSON.stringify(results, null, 2));
  console.log('[scale-real] RESULT', JSON.stringify(results));
  clearTimeout(timeout);
  win.destroy();
  app.exit(0);
}).catch((error) => {
  clearTimeout(timeout);
  console.error('[scale-real] FAIL:', error && error.stack ? error.stack : error);
  app.exit(1);
});
