const { app, BrowserView, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
app.on('window-all-closed', () => {});
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-scale-')));
const timeout = setTimeout(() => { console.error('[canvas-scale] TIMEOUT'); app.exit(1); }, 90000);
const COLMOD = require(path.join(__dirname, '..', '..', '.cache', 'vision-benchmark', 'color-lib.cjs'));
const { extractColorPointSignature, matchColorPointSignature } = COLMOD;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// A canvas game surface with FIXED logical size (600x400) and a target drawn at a FIXED relative
// position (60% width, 50% height), i.e. the target's absolute pixel size scales with the canvas.
function makeFixture(size) {
  const w = size.width, h = size.height;
  return `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#0b1a2e}
    #game{position:absolute;left:0;top:0;width:100%;height:100%;background:#14532d}
    canvas{display:block;image-rendering:pixelated}
  </style><div id="game"><canvas></canvas></div>
  <script>
    const c=document.querySelector('canvas'); const ctx=c.getContext('2d');
    c.width=${w}; c.height=${h};
    // sky
    ctx.fillStyle='#0ea5e9'; ctx.fillRect(0,0,c.width,c.height);
    // a target at RELATIVE (0.6w, 0.5h), size RELATIVE (0.2w x 0.25h) -> so it scales with canvas
    const tw=Math.round(c.width*0.2), th=Math.round(c.height*0.25), tx=Math.round(c.width*0.55), ty=Math.round(c.height*0.4);
    ctx.fillStyle='#fbbf24'; ctx.fillRect(tx,ty,tw,th);
    ctx.fillStyle='#7c2d12'; ctx.fillRect(tx,ty,tw,8); ctx.fillRect(tx,ty,8,th);
    ctx.fillStyle='#ffffff'; ctx.fillRect(tx+Math.round(tw*0.3),ty+Math.round(th*0.3),Math.round(tw*0.3),Math.round(th*0.3));
    ctx.fillStyle='#dc2626'; ctx.fillRect(tx+Math.round(tw*0.7),ty+Math.round(th*0.7),Math.round(tw*0.15),Math.round(th*0.15));
    window.__cs={w:c.width,h:c.height,tx,ty,tw,th,innerWidth,innerHeight,dpr:devicePixelRatio};
  <\/script>`;
}

app.whenReady().then(async () => {
  const { BrowserViewAutomationCoreSession, detectGameSurfaces } = require('../../release/tests/automation-authoring-core.cjs');
  const win = new BrowserWindow({ show: true, width: 1300, height: 760 });
  const VIEWPORT = { width: 1280, height: 720 };
  const view = new BrowserView({ webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, partition: 'persist:canvas-scale' } });
  win.addBrowserView(view); view.setBounds({ x: 0, y: 0, ...VIEWPORT });
  const wc = view.webContents;
  global.AbortController = undefined;

  async function loadAndProbe(size) {
    await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(makeFixture(size)));
    await delay(200);
    const cs = await wc.executeJavaScript('window.__cs');
    const surfaces = await detectGameSurfaces(wc);
    const canvas = surfaces.find((s) => s.kind === 'canvas');
    // capture via main pipeline
    const handle = {
      tabId: 't', webContents: wc, ready: Promise.resolve(),
      getCssViewport: () => ({ ...VIEWPORT }), getViewportTransform: () => ({ logicalSize: { ...VIEWPORT }, displaySize: { ...VIEWPORT }, scaleX: 1, scaleY: 1 }),
      getViewportRevision: () => 1, assertCurrent: () => {}, release: () => {},
    };
    const session = new BrowserViewAutomationCoreSession(handle, {
      manifest: { format: 'baoauto', formatVersion: 3, id: 's', name: 'S', frontends: {}, features: [], integrity: {} },
      workflow: { formatVersion: 3, id: 'w', name: 'W', root: { id: 'r', kind: 'sequence', nodes: [] } }, scripts: new Map(), assets: new Map(), profiles: new Map(),
    });
    const frame = await session.capturePreview();
    await session.close();
    return { cs, canvasRect: canvas ? canvas.rect : null, frame: { w: frame.width, h: frame.height, bitmap: frame.bitmap } };
  }

  // Material environment (取材): canvas 600x400. Target tw=120, th=100, tx=330, ty=160.
  const ref = await loadAndProbe({ width: 600, height: 400 });
  console.log('[canvas-scale] REF canvas=', JSON.stringify(ref.cs), 'detectRect=', JSON.stringify(ref.canvasRect), 'frame=', ref.frame.w + 'x' + ref.frame.h);
  const refFrameImg = nativeImage.createFromBitmap(Buffer.from(ref.frame.bitmap), { width: ref.frame.w, height: ref.frame.h });
  // material = crop the target region (ref.cs.tx,ty,tw,th). This is the authored asset at reference size.
  const material = refFrameImg.crop({ x: Math.round(ref.cs.tx), y: Math.round(ref.cs.ty), width: Math.round(ref.cs.tw), height: Math.round(ref.cs.th) });
  const matSize = material.getSize();
  console.log('[canvas-scale] material=', JSON.stringify(matSize), '@ref canvas 600x400');
  console.log('[canvas-scale] REF: detect canvas rect=', JSON.stringify(ref.canvasRect));

  // Runtime: canvas 900x600 (1.5x). Target should scale 1.5x: tw=180, th=150.
  const run = await loadAndProbe({ width: 900, height: 600 });
  console.log('[canvas-scale] RUN canvas=', JSON.stringify(run.cs), 'detectRect=', JSON.stringify(run.canvasRect), 'frame=', run.frame.w + 'x' + run.frame.h);

  // Predicted scale from detectGameSurfaces canvas rects (run/ref): should be 1.5.
  const scaleFromDetect = run.canvasRect && ref.canvasRect ? run.canvasRect.width / ref.canvasRect.width : 0;
  const scaleFromCs = run.cs.tw / ref.cs.tw;
  console.log('[canvas-scale] scale(detectRect run/ref)=', scaleFromDetect.toFixed(4), ' scale(cs target)=', scaleFromCs.toFixed(4));

  // Verify match: use material + derived scale in the run frame.
  const full2 = nativeImage.createFromBitmap(Buffer.from(run.frame.bitmap), { width: run.frame.w, height: run.frame.h });
  const sb = full2.toBitmap(); const fw = run.frame.w, fh = run.frame.h;
  const sceneBgra = Buffer.alloc(sb.length); for (let i = 0; i < sb.length; i += 4) { sceneBgra[i] = sb[i + 2]; sceneBgra[i + 1] = sb[i + 1]; sceneBgra[i + 2] = sb[i]; sceneBgra[i + 3] = sb[i + 3]; }
  const scene = { pixels: new Uint8Array(sceneBgra), width: fw, height: fh };
  const mb = material.toBitmap(); const ms = material.getSize();
  const tpl = Buffer.alloc(mb.length); for (let i = 0; i < mb.length; i += 4) { tpl[i] = mb[i + 2]; tpl[i + 1] = mb[i + 1]; tpl[i + 2] = mb[i]; tpl[i + 3] = mb[i + 3]; }
  let sig; try { sig = extractColorPointSignature({ pixels: new Uint8Array(tpl), width: ms.width, height: ms.height }); } catch (e) { console.log('[canvas-scale] sig ERR', e.message); }
  const matches = sig ? matchColorPointSignature(scene, sig, { threshold: 0, mirror: false, scales: [scaleFromDetect], maxCandidates: 3 }) : [];
  const top = matches[0];
  const expX = run.cs.tx; // target top-left in run frame (density 1, so == canvas internal coords)
  const hit = top && Math.abs(top.x - expX) < 6 && Math.abs(top.y - run.cs.ty) < 6;
  console.log('[canvas-scale] match(scale=' + scaleFromDetect.toFixed(3) + ') =', top ? `${top.score.toFixed(3)}@(${Math.round(top.x)},${Math.round(top.y)})` : 'none', '期望@(', expX + ',' + run.cs.ty + ')', hit ? 'HIT' : 'MISS');
  fs.writeFileSync(path.join(__dirname, '..', '..', 'release', 'automation-probe', 'canvas-scale.json'), JSON.stringify({ ref: ref.cs, refDetectRect: ref.canvasRect, material: matSize, run: run.cs, runDetectRect: run.canvasRect, scaleFromDetect, scaleFromCs, match: top ? { x: top.x, y: top.y, score: top.score } : null }, null, 2));
  clearTimeout(timeout);
  win.destroy();
  app.exit(0);
}).catch((error) => { clearTimeout(timeout); console.error('[canvas-scale] FAIL:', error && error.stack ? error.stack : error); app.exit(1); });
