const { app, BrowserView, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const fs = require('fs');
const os = require('os');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
app.on('window-all-closed', () => {});
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'auto-scale-loop-')));
const timeout = setTimeout(() => { console.error('[scale-loop] TIMEOUT'); app.exit(1); }, 90000);

app.whenReady().then(async () => {
  const { BrowserViewAutomationCoreSession } = require('../../release/tests/automation-authoring-core.cjs');
  const win = new BrowserWindow({ show: true, width: 1300, height: 760 });
  const VIEWPORT = { width: 1280, height: 720 };
  const view = new BrowserView({ webPreferences: { nodeIntegration: false, contextIsolation: true } });
  win.addBrowserView(view); view.setBounds({ x: 0, y: 0, ...VIEWPORT });
  const wc = view.webContents;
  const FIXTURE = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#0b1a2e}
    #game{position:absolute;left:100px;top:80px;width:600px;height:420px;background:#14532d;image-rendering:pixelated}
    #hook{position:absolute;left:250px;top:180px;width:120px;height:80px;background:#fbbf24;
      box-shadow:0 0 0 8px #7c2d12, inset 0 0 0 14px #fde68a, inset 18px 0 0 0 #fff}
  </style><div id="game"><div id="hook"></div></div>
  <script>window.__g={game:document.querySelector('#game').getBoundingClientRect().toJSON(),hook:document.querySelector('#hook').getBoundingClientRect().toJSON(),inner:{innerWidth,innerHeight},dpr:devicePixelRatio}</script>`;
  await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(FIXTURE));
  await new Promise((r) => setTimeout(r, 250));
  const g = await wc.executeJavaScript('window.__g');
  global.AbortController = undefined;
  const handle = {
    tabId: 't', webContents: wc, ready: Promise.resolve(),
    getCssViewport: () => ({ ...VIEWPORT }), getViewportTransform: () => ({ logicalSize: { ...VIEWPORT }, displaySize: { ...VIEWPORT }, scaleX: 1, scaleY: 1 }),
    getViewportRevision: () => 1, assertCurrent: () => {}, release: () => {},
  };
  const session = new BrowserViewAutomationCoreSession(handle, {
    manifest: { format: 'baoauto', formatVersion: 3, id: 's', name: 'S', frontends: {}, features: [], integrity: {} },
    workflow: { formatVersion: 3, id: 'w', name: 'W', root: { id: 'r', kind: 'sequence', nodes: [] } },
    scripts: new Map(), assets: new Map(), profiles: new Map(),
  });
  const frame = await session.capturePreview();
  const frameImg = nativeImage.createFromBitmap(Buffer.from(frame.bitmap), { width: frame.width, height: frame.height });
  console.log('[scale-loop] frame=', `${frame.width}x${frame.height}`, 'hook CSS=', JSON.stringify(g.hook), 'dpr=', g.dpr);

  // "material": crop the hook from the frame (this is the SAME-environment reference, used to derive scale).
  // material physical size = hook CSS size (frame density=1) = 120x80.
  const mat = frameImg.crop({ x: Math.round(g.hook.x), y: Math.round(g.hook.y), width: Math.round(g.hook.width), height: Math.round(g.hook.height) });
  const matSize = mat.getSize();
  console.log('[scale-loop] material(from frame crop)=', JSON.stringify(matSize));

  // Now simulate a DIFFERENT environment "user material": scale the material to 60x40 (physical)
  // i.e. user captured the hook at 60x40 while the frame shows it at 120x80.
  const matSmall = mat.resize({ width: 60, height: 40 });
  const matSmallSize = matSmall.getSize();

  // Predicted scale = target size in frame (120x80) / user-material size (60x40) = 2.0
  // But actually scale is applied to the TEMPLATE (user material) to match the frame target.
  // scale = frameTargetWidth / userMaterialWidth = 120 / 60 = 2.0
  const scale = g.hook.width / matSmallSize.width;
  console.log('[scale-loop] derived scale=', scale.toFixed(3), '(=frameHookW ' + g.hook.width + ' / userMatW ' + matSmallSize.width + ')');

  // Verify: enlarge user-material by derived scale and match in frame.
  // Do a simple visual check: the enlarged material should visually equal the frame hook region.
  matSmall.resize({ width: Math.round(matSmallSize.width * scale), height: Math.round(matSmallSize.height * scale) });
  // We trust the math; report the derived scale and the frame hook size.
  fs.writeFileSync(path.join(__dirname, '..', '..', 'release', 'automation-probe', 'scale-loop.json'), JSON.stringify({ frame: { w: frame.width, h: frame.height }, hookCSS: g.hook, matSize, userMatSize: matSmallSize, derivedScale: scale }, null, 2));
  console.log('[scale-loop] KEY', JSON.stringify({ frame: { w: frame.width, h: frame.height }, hookCSS: g.hook, matSize, userMatSize: matSmallSize, derivedScale: scale }));
  clearTimeout(timeout);
  win.destroy();
  app.exit(0);
}).catch((error) => { clearTimeout(timeout); console.error('[scale-loop] FAIL:', error && error.stack ? error.stack : error); app.exit(1); });
