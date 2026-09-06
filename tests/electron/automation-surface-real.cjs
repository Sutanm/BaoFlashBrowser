const { app, BrowserView, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
app.on('window-all-closed', () => {});
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'auto-surface-')));
const timeout = setTimeout(() => { console.error('[surface-real] TIMEOUT'); app.exit(1); }, 90000);

// A fixture with a canvas "game screen" (fixed CSS size) and a known-size target inside it.
const FIXTURE = `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#0b1a2e}
  #stage{position:absolute;left:120px;top:100px;width:720px;height:480px;background:#14532d}
  canvas{display:block;width:720px;height:480px;background:#1e3a8a;image-rendering:pixelated}
  #tgt{position:absolute;left:300px;top:200px;width:120px;height:80px;background:#e85d75}
</style><div id="stage"><canvas></canvas><div id="tgt">TGT</div></div>
<script>
  // draw a fixed reference inside the canvas
  const c=document.querySelector('canvas');const ctx=c.getContext('2d');c.width=720;c.height=480;
  ctx.fillStyle='#fbbf24';ctx.fillRect(80,60,96,48);
  window.__surf={stage:document.querySelector('#stage').getBoundingClientRect().toJSON(),
    canvas:document.querySelector('canvas').getBoundingClientRect().toJSON(),
    tgt:document.querySelector('#tgt').getBoundingClientRect().toJSON(),inner:{innerWidth,innerHeight},dpr:devicePixelRatio};
</script>`;

app.whenReady().then(async () => {
  const { BrowserViewAutomationCoreSession } = require('../../release/tests/automation-authoring-core.cjs');
  const win = new BrowserWindow({ show: true, width: 1300, height: 760 });
  const VIEWPORT = { width: 1280, height: 720 };
  const view = new BrowserView({ webPreferences: { nodeIntegration: false, contextIsolation: true } });
  win.addBrowserView(view); view.setBounds({ x: 0, y: 0, ...VIEWPORT });
  const wc = view.webContents;
  await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(FIXTURE));
  await new Promise((r) => setTimeout(r, 250));
  const surf = await wc.executeJavaScript('window.__surf');
  global.AbortController = undefined;
  const handle = {
    tabId: 't', webContents: wc, ready: Promise.resolve(),
    getCssViewport: () => ({ ...VIEWPORT }),
    getViewportTransform: () => ({ logicalSize: { ...VIEWPORT }, displaySize: { ...VIEWPORT }, scaleX: 1, scaleY: 1 }),
    getViewportRevision: () => 1, assertCurrent: () => {}, release: () => {},
  };
  const session = new BrowserViewAutomationCoreSession(handle, {
    manifest: { format: 'baoauto', formatVersion: 3, id: 's', name: 'S', frontends: {}, features: [], integrity: {} },
    workflow: { formatVersion: 3, id: 'w', name: 'W', root: { id: 'r', kind: 'sequence', nodes: [] } },
    scripts: new Map(), assets: new Map(), profiles: new Map(),
  });
  const frame = await session.capturePreview();
  console.log('[surface-real] stage CSS=', JSON.stringify(surf.stage));
  console.log('[surface-real] canvas CSS=', JSON.stringify(surf.canvas));
  console.log('[surface-real] tgt CSS=', JSON.stringify(surf.tgt));
  console.log('[surface-real] inner=', JSON.stringify(surf.inner), 'dpr=', surf.dpr);
  console.log('[surface-real] frame=', `${frame.width}x${frame.height}`);
  // Key: since frame == logical viewport 1280x720 (density=1), CSS coords == bitmap coords.
  // So stage/canvas/tgt in the frame should be exactly their CSS rect.
  const key = { frame: { w: frame.width, h: frame.height }, canvasCSS: { x: surf.canvas.x, y: surf.canvas.y, w: surf.canvas.width, h: surf.canvas.height }, tgtCSS: { x: surf.tgt.x, y: surf.tgt.y, w: surf.tgt.width, h: surf.tgt.height } };
  fs.writeFileSync(path.join(__dirname, '..', '..', 'release', 'automation-probe', 'surface-real.json'), JSON.stringify(key, null, 2));
  console.log('[surface-real] KEY', JSON.stringify(key));
  clearTimeout(timeout);
  win.destroy();
  app.exit(0);
}).catch((error) => { clearTimeout(timeout); console.error('[surface-real] FAIL:', error && error.stack ? error.stack : error); app.exit(1); });
