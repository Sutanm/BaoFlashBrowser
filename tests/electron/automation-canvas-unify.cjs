const { app, BrowserView, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
app.on('window-all-closed', () => {});
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-unify-')));
const timeout = setTimeout(() => { console.error('[canvas-unify] TIMEOUT'); app.exit(1); }, 90000);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const COLMOD = require(path.join(__dirname, '..', '..', '.cache', 'vision-benchmark', 'color-lib.cjs'));
const { extractColorPointSignature, matchColorPointSignature } = COLMOD;

// Canvas whose CSS rect is CONSTANT (controlled): 700x420, positioned at (100,100) in the page.
// The target is drawn at a FIXED RATIO of the BUFFER (relative to buffer), so its CSS-displayed position
// = bufferRel * cssRect. We DO NOT read frame; we compute target geometry in CSS coordinates.
//  - fixed mode:   canvas.width/height = 800x600  (buffer fixed; CSS stretches it into 700x420)
//  - adaptive mode: canvas.width = floor(cssWidth * dpr) (buffer follows DPR; CSS still 700x420)
function makeFixture(mode) {
  return `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#0b1a2e}
    canvas{display:block;width:700px;height:420px;position:absolute;left:100px;top:100px;image-rendering:pixelated}
  </style><canvas></canvas><script>
    const c=document.querySelector('canvas'); const ctx=c.getContext('2d');
    function redraw() {
      if (${mode === 'fixed' ? 'true' : 'false'}) { c.width=800; c.height=600; }
      else { c.width=Math.floor(700*(window.devicePixelRatio||1)); c.height=Math.floor(420*(window.devicePixelRatio||1)); }
      const W=c.width, H=c.height;
      ctx.fillStyle='#0ea5e9'; ctx.fillRect(0,0,W,H);
      const tW=Math.round(W*0.2), tH=Math.round(H*0.25), tX=Math.round(W*0.55), tY=Math.round(H*0.4);
      ctx.fillStyle='#fbbf24'; ctx.fillRect(tX,tY,tW,tH);
      ctx.fillStyle='#7c2d12'; ctx.fillRect(tX,tY,tW,8); ctx.fillRect(tX,tY,8,tH);
      ctx.fillStyle='#ffffff'; ctx.fillRect(tX+Math.round(tW*0.3),tY+Math.round(tH*0.3),Math.round(tW*0.3),Math.round(tH*0.3));
      ctx.fillStyle='#dc2626'; ctx.fillRect(tX+Math.round(tW*0.7),tY+Math.round(tH*0.7),Math.round(tW*0.15),Math.round(tH*0.15));
      const rect=c.getBoundingClientRect();
      // target CSS geometry = bufferRel * cssRect (target is at relative pos in buffer)
      const rx = tX / W, ry = tY / H, rw = tW / W, rh = tH / H;
      window.__cs={bufW:c.width,bufH:c.height,rectX:rect.x,rectY:rect.y,cssW:rect.width,cssH:rect.height,
        tCssX:Math.round(rect.x + rx*rect.width), tCssY:Math.round(rect.y + ry*rect.height),
        tCssW:Math.round(rw*rect.width), tCssH:Math.round(rh*rect.height),
        dpr:window.devicePixelRatio, iw:innerWidth, ih:innerHeight};
    }
    redraw(); window.addEventListener('resize', redraw);
  <\/script>`;
}

app.whenReady().then(async () => {
  const { BrowserViewAutomationCoreSession } = require('../../release/tests/automation-authoring-core.cjs');
  const win = new BrowserWindow({ show: true, width: 1400, height: 820 });
  const VIEWPORT = { width: 1280, height: 720 };
  const view = new BrowserView({ webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, partition: 'persist:canvas-unify' } });
  win.addBrowserView(view); view.setBounds({ x: 0, y: 0, ...VIEWPORT });
  const wc = view.webContents;

  async function probe(mode, zoom) {
    await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(makeFixture(mode)));
    await wc.setZoomFactor(zoom);
    await delay(300);
    // re-trigger redraw to update buffer for adaptive (resize doesn't fire on zoom change)
    const cs = await wc.executeJavaScript('window.__cs.gotResize !== undefined ? null : null, window.__cs');
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
    return { cs, frame: { w: frame.width, h: frame.height, bitmap: frame.bitmap } };
  }

  for (const mode of ['fixed', 'adaptive']) {
    const ref = await probe(mode, 1);
    const run = await probe(mode, 1.5);
    console.log(`[canvas-unify] ${mode} REF frame=${ref.frame.w}x${ref.frame.h} css=${ref.cs.tCssW}x${ref.cs.tCssH}@(${ref.cs.tCssX},${ref.cs.tCssY}) buf=${ref.cs.bufW}x${ref.cs.bufH} cssRect=${ref.cs.cssW}x${ref.cs.cssH}@(${ref.cs.rectX},${ref.cs.rectY}) dpr=${ref.cs.dpr}`);
    console.log(`[canvas-unify] ${mode} RUN frame=${run.frame.w}x${run.frame.h} css=${run.cs.tCssW}x${run.cs.tCssH}@(${run.cs.tCssX},${run.cs.tCssY}) buf=${run.cs.bufW}x${run.cs.bufH} cssRect=${run.cs.cssW}x${run.cs.cssH}@(${run.cs.rectX},${run.cs.rectY}) dpr=${run.cs.dpr}`);
    const scaleCssRect = run.cs.cssRectSw || 0; // placeholder
    // target frame size ratio (CSS coordinate): is content size constant or does it follow buffer?
    const ratioBuf = run.cs.bufW / ref.cs.bufW;
    const ratioCssRect = run.cs.cssW / ref.cs.cssW;
    const ratioTargetCss = run.cs.tCssW / ref.cs.tCssW;
    console.log(`[canvas-unify] ${mode} ratio(buffer)=${ratioBuf.toFixed(3)} ratio(cssRect)=${ratioCssRect.toFixed(3)} ratio(targetFrameDisplay)=${ratioTargetCss.toFixed(3)}`);

    // Match using target CSS coordinate: crop material from ref frame at (tCssX,tCssY,tCssW,tCssH),
    // then in run frame match with scale = run target display size / ref target display size.
    const refImg = nativeImage.createFromBitmap(Buffer.from(ref.frame.bitmap), { width: ref.frame.w, height: ref.frame.h });
    // DIAGNOSE: read colors around candidate positions in the ref frame bitmap to find where the orange target is.
    const rb = refImg.toBitmap(); const rfw = ref.frame.w, rfh = ref.frame.h;
    function pxAt(x, y) { const i = (y * rfw + x) * 4; return [rb[i + 2], rb[i + 1], rb[i]]; }
    // SCAN: find bounding box of BRIGHT ORANGE target body (#fbbf24 = r251,g191,b36) in RGB (read via BGRA).
    let minX = 1e9, minY = 1e9, maxX = -1, maxY = -1; let cnt = 0;
    for (let y = 0; y < rfh; y += 2) for (let x = 0; x < rfw; x += 2) {
      const i = (y * rfw + x) * 4; const r = rb[i + 2], g = rb[i + 1], b = rb[i];
      if (r > 200 && g > 130 && g < 220 && b < 80) { if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; cnt++; }
    }
    console.log(`[canvas-unify] ${mode} TARGET bbox in bitmap = (${minX},${minY})-(${maxX},${maxY}) size=${maxX - minX}x${maxY - minY} count=${cnt}  CSS预期(485,268) 140x105`);

    // material = crop the TRUE target bbox from ref frame (from scan), not logical CSS (which misses zoom).
    const material = refImg.crop({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });
    const ms = material.getSize();
    const runImg = nativeImage.createFromBitmap(Buffer.from(run.frame.bitmap), { width: run.frame.w, height: run.frame.h });
    // SCAN run frame for target bbox (RGB via BGRA)
    const sr = runImg.toBitmap(); const sfw = run.frame.w, sfh = run.frame.h;
    let rminX = 1e9, rminY = 1e9, rmaxX = -1, rmaxY = -1; let rcnt = 0;
    for (let y = 0; y < sfh; y += 2) for (let x = 0; x < sfw; x += 2) {
      const i = (y * sfw + x) * 4; const r = sr[i + 2], g = sr[i + 1], b = sr[i];
      if (r > 200 && g > 130 && g < 220 && b < 80) { if (x < rminX) rminX = x; if (y < rminY) rminY = y; if (x > rmaxX) rmaxX = x; if (y > rmaxY) rmaxY = y; rcnt++; }
    }
    console.log(`[canvas-unify] ${mode} RUN target bbox = (${rminX},${rminY})-(${rmaxX},${rmaxY}) size=${rmaxX - rminX}x${rmaxY - rminY} count=${rcnt}`);
    const sb = runImg.toBitmap(); const fw = run.frame.w, fh = run.frame.h;
    const sceneBgra = Buffer.alloc(sb.length); for (let i = 0; i < sb.length; i += 4) { sceneBgra[i] = sb[i + 2]; sceneBgra[i + 1] = sb[i + 1]; sceneBgra[i + 2] = sb[i]; sceneBgra[i + 3] = sb[i + 3]; }
    const scene = { pixels: new Uint8Array(sceneBgra), width: fw, height: fh };
    const mb = material.toBitmap();
    const tpl = Buffer.alloc(mb.length); for (let i = 0; i < mb.length; i += 4) { tpl[i] = mb[i + 2]; tpl[i + 1] = mb[i + 1]; tpl[i + 2] = mb[i]; tpl[i + 3] = mb[i + 3]; }
    const scale = rmaxX > 0 && maxX > 0 && minX < 1e9 && rminX < 1e9 ? (rmaxX - rminX) / (maxX - minX) : (run.cs.tCssW / ref.cs.tCssW);
    console.log(`[canvas-unify] ${mode} scale(frameBBox run/ref)=${scale.toFixed(4)} (cssRect比=${(run.cs.cssW / ref.cs.cssW).toFixed(3)})`);
    let sig; try { sig = extractColorPointSignature({ pixels: new Uint8Array(tpl), width: ms.width, height: ms.height }); } catch (e) { console.log(`[canvas-unify] ${mode} sig ERR`, e.message); }
    const matches = sig ? matchColorPointSignature(scene, sig, { threshold: 0, mirror: false, scales: [scale], maxCandidates: 3 }) : [];
    const top = matches[0];
    const hit = top && Math.abs(top.x - rminX) < 8 && Math.abs(top.y - rminY) < 8;
    console.log(`[canvas-unify] ${mode} match(scale=${scale.toFixed(3)}) = ${top ? `${top.score.toFixed(3)}@(${Math.round(top.x)},${Math.round(top.y)})` : 'none'}  真实RUN目标@(${rminX},${rminY}) ${hit ? 'HIT' : 'MISS'}`);
  }
  clearTimeout(timeout);
  win.destroy();
  app.exit(0);
}).catch((error) => { clearTimeout(timeout); console.error('[canvas-unify] FAIL:', error && error.stack ? error.stack : error); app.exit(1); });
