const { app, BrowserView, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
app.on('window-all-closed', () => {});
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'auto-scale-verify-')));
const timeout = setTimeout(() => { console.error('[scale-verify] TIMEOUT'); app.exit(1); }, 90000);

const COLMOD = require(path.join(__dirname, '..', '..', '.cache', 'vision-benchmark', 'color-lib.cjs'));
const { extractColorPointSignature, matchColorPointSignature } = COLMOD;

// A game surface (600x400) containing a fixed-relative multi-colour "hook" target (96x64 CSS).
// We simulate the runtime being scaled: via zoomFactor the target's physical size in the frame
// changes. We capture, derive scale = targetActualPhysW / materialW, and verify match hits at that scale.
const FIXTURE = `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#0b1a2e}
  #game{position:absolute;left:100px;top:80px;width:600px;height:400px;background:#14532d;image-rendering:pixelated}
  #hook{position:absolute;left:250px;top:160px;width:96px;height:64px;background:#fbbf24;
    box-shadow:0 0 0 6px #7c2d12, inset 0 0 0 10px #fde68a, inset 14px 0 0 0 #fff}
  #hook::before{content:"";position:absolute;left:14px;top:8px;width:8px;height:8px;background:#dc2626}
  #hook::after{content:"";position:absolute;left:72px;top:44px;width:8px;height:8px;background:#2563eb}
</style><div id="game"><div id="hook"></div></div>
<script>window.__s={game:document.querySelector('#game').getBoundingClientRect().toJSON(),hook:document.querySelector('#hook').getBoundingClientRect().toJSON(),inner:{innerWidth,innerHeight},dpr:devicePixelRatio}</script>`;

app.whenReady().then(async () => {
  const { BrowserViewAutomationCoreSession } = require('../../release/tests/automation-authoring-core.cjs');
  const win = new BrowserWindow({ show: true, width: 1300, height: 760 });
  const VIEWPORT = { width: 1280, height: 720 };
  const view = new BrowserView({ webPreferences: { nodeIntegration: false, contextIsolation: true } });
  win.addBrowserView(view); view.setBounds({ x: 0, y: 0, ...VIEWPORT });
  const wc = view.webContents;
  await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(FIXTURE));
  await new Promise((r) => setTimeout(r, 250));
  const s = await wc.executeJavaScript('window.__s');
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
  console.log('[scale-verify] frame=', `${frame.width}x${frame.height}`, 'hook CSS=', JSON.stringify(s.hook), 'game=', JSON.stringify(s.game));

  // resource surface size (取材时 surface) = game CSS 600x400; runtime surface (current) = same (no scale in this env).
  const matStyle = { w: s.hook.width, h: s.hook.height }; // target in frame = 96x64 (density 1)

  // Build "user material" = a SMALLER version (simulating a different-DPR capture), e.g. 60x40.
  const userMatW = 60, userMatH = 40;
  const userMat = frameImg.crop({ x: Math.round(s.hook.x), y: Math.round(s.hook.y), width: Math.round(s.hook.width), height: Math.round(s.hook.height) }).resize({ width: userMatW, height: userMatH });
  const userMatSize = userMat.getSize();
  console.log('[scale-verify] user material=', JSON.stringify(userMatSize));

  // derived scale = target actual width in frame / user material width = 96 / 60 = 1.6
  const surfaceScale = s.hook.width / userMatW; // = 1.6 (what surfaceReferenceImageScales would give: runtimeSurfaceW/materialSurfaceW)
  console.log('[scale-verify] derivedScale=', surfaceScale.toFixed(3));

  // Encode scene (BGRA) and call color matcher with that single scale to verify it hits the target.
  const full = frameImg.toBitmap(); const fw = frame.width, fh = frame.height;
  const sceneBgra = Buffer.alloc(full.length);
  for (let i = 0; i < full.length; i += 4) { sceneBgra[i] = full[i + 2]; sceneBgra[i + 1] = full[i + 1]; sceneBgra[i + 2] = full[i]; sceneBgra[i + 3] = full[i + 3]; }
  const scene = { pixels: new Uint8Array(sceneBgra), width: fw, height: fh };
  const matBgra = userMat.toBitmap(); const mw = userMatSize.width, mh = userMatSize.height;
  const templateBgra = Buffer.alloc(matBgra.length);
  for (let i = 0; i < matBgra.length; i += 4) { templateBgra[i] = matBgra[i + 2]; templateBgra[i + 1] = matBgra[i + 1]; templateBgra[i + 2] = matBgra[i]; templateBgra[i + 3] = matBgra[i + 3]; }

  let sig;
  try { sig = extractColorPointSignature({ pixels: new Uint8Array(templateBgra), width: mw, height: mh }); }
  catch (e) { console.log('[scale-verify] template signature ERR', e.message); }
  const matches = matchColorPointSignature(scene, sig, { threshold: 0, mirror: false, scales: [surfaceScale], maxCandidates: 3 });
  const top = matches[0];
  const got = top ? (Math.abs(top.x - s.hook.x) < 8 && Math.abs(top.y - s.hook.y) < 8) : false;
  console.log('[scale-verify] match(scale=' + surfaceScale.toFixed(2) + ') =', top ? `${top.score.toFixed(3)}@(${Math.round(top.x)},${Math.round(top.y)}) 命中=${got}` : 'none', '期望@(', Math.round(s.hook.x) + ',' + Math.round(s.hook.y) + ')');
  fs.writeFileSync(path.join(__dirname, '..', '..', 'release', 'automation-probe', 'scale-verify.json'), JSON.stringify({ frame: { w: fw, h: fh }, hookCSS: s.hook, surfaceScale, match: top ? { x: top.x, y: top.y, score: top.score } : null }, null, 2));
  clearTimeout(timeout);
  win.destroy();
  app.exit(0);
}).catch((error) => { clearTimeout(timeout); console.error('[scale-verify] FAIL:', error && error.stack ? error.stack : error); app.exit(1); });
