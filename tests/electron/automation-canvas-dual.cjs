const { app, BrowserView, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
app.on('window-all-closed', () => {});
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-dual-')));
const timeout = setTimeout(() => { console.error('[canvas-dual] TIMEOUT'); app.exit(1); }, 90000);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const COLMOD = require(path.join(__dirname, '..', '..', '.cache', 'vision-benchmark', 'color-lib.cjs'));
const { extractColorPointSignature, matchColorPointSignature } = COLMOD;

// Two canvas fixtures.
//  mode='fixed'   -> canvas.width/height FIXED at 800x600 (never follows DPR); CSS scales to container.
//  mode='adaptive'-> canvas.width = innerWidth*dpr (follows DPR/zoom like dino); CSS = 100%.
// In BOTH, the target is drawn at a FIXED RATIO of the *buffer* (content scales with buffer).
function makeFixture(mode) {
  const baseBuf = mode === 'fixed' ? { w: 800, h: 600 } : { w: 1280, h: 720 };
  return `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#0b1a2e}
    canvas{display:block;width:100%;height:100%;image-rendering:pixelated}
  </style><canvas></canvas><script>
    const c=document.querySelector('canvas'); const ctx=c.getContext('2d');
    function redraw() {
      const bw=${mode === 'fixed' ? '800' : 'c.width'}, bh=${mode === 'fixed' ? '600' : 'c.height'};
      c.width = ${mode === 'fixed' ? '800' : 'Math.floor(window.innerWidth * (window.devicePixelRatio||1))'};
      c.height = ${mode === 'fixed' ? '600' : 'Math.floor(window.innerHeight * (window.devicePixelRatio||1))'};
      const W=c.width, H=c.height;
      ctx.fillStyle='#0ea5e9'; ctx.fillRect(0,0,W,H);
      // target at relative (0.55w, 0.4h) of buffer, relative size (0.2w x 0.25h)
      const tw=Math.round(W*0.2), th=Math.round(H*0.25), tx=Math.round(W*0.55), ty=Math.round(H*0.4);
      ctx.fillStyle='#fbbf24'; ctx.fillRect(tx,ty,tw,th);
      ctx.fillStyle='#7c2d12'; ctx.fillRect(tx,ty,tw,8); ctx.fillRect(tx,ty,8,th);
      ctx.fillStyle='#ffffff'; ctx.fillRect(tx+Math.round(tw*0.3),ty+Math.round(th*0.3),Math.round(tw*0.3),Math.round(th*0.3));
      ctx.fillStyle='#dc2626'; ctx.fillRect(tx+Math.round(tw*0.7),ty+Math.round(th*0.7),Math.round(tw*0.15),Math.round(th*0.15));
      window.__cs={w:c.width,h:c.height,tx,ty,tw,th,dpr:window.devicePixelRatio,iw:innerWidth,ih:innerHeight,bufCss:(c.width&&0||0)};
    }
    redraw();
  <\/script>`;
}

app.whenReady().then(async () => {
  const { BrowserViewAutomationCoreSession } = require('../../release/tests/automation-authoring-core.cjs');
  const win = new BrowserWindow({ show: true, width: 1400, height: 820 });
  const VIEWPORT = { width: 1280, height: 720 };
  const view = new BrowserView({ webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, partition: 'persist:canvas-dual' } });
  win.addBrowserView(view); view.setBounds({ x: 0, y: 0, ...VIEWPORT });
  const wc = view.webContents;

  async function probe(mode, zoom) {
    await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(makeFixture(mode)));
    await wc.setZoomFactor(zoom);
    await delay(300);
    const cs = await wc.executeJavaScript('window.__cs');
    const buf = await wc.executeJavaScript('(()=>{const c=document.querySelector("canvas");return {w:c.width,h:c.height}})()');
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
    return { cs, buf, frame: { w: frame.width, h: frame.height, bitmap: frame.bitmap } };
  }

  for (const mode of ['fixed', 'adaptive']) {
    // Material env: zoom=1
    const ref = await probe(mode, 1);
    const refFrame = nativeImage.createFromBitmap(Buffer.from(ref.frame.bitmap), { width: ref.frame.w, height: ref.frame.h });
    const material = refFrame.crop({ x: Math.round(ref.cs.tx), y: Math.round(ref.cs.ty), width: Math.round(ref.cs.tw), height: Math.round(ref.cs.th) });
    const matSize = material.getSize();
    console.log(`[canvas-dual] ${mode} REF buf=${ref.buf.w}x${ref.buf.h} target=${ref.cs.tw}x${ref.cs.th}@(${ref.cs.tx},${ref.cs.ty}) material=${matSize.width}x${matSize.height}`);
    const refBufW = ref.buf.w;

    // Runtime env: zoom=1.5
    const run = await probe(mode, 1.5);
    console.log(`[canvas-dual] ${mode} RUN buf=${run.buf.w}x${run.buf.h} css~(${run.cs.iw}x${run.cs.ih},dpr=${run.cs.dpr}) target=${run.cs.tw}x${run.cs.th}@(${run.cs.tx},${run.cs.ty})`);

    const scaleBuf = run.buf.w / refBufW;
    const scaleContent = run.cs.tw / ref.cs.tw;
    console.log(`[canvas-dual] ${mode} scale(buf run/ref)=${scaleBuf.toFixed(4)}  scale(content)=${scaleContent.toFixed(4)}`);

    // Match with scaleBuf in run frame
    const runImg = nativeImage.createFromBitmap(Buffer.from(run.frame.bitmap), { width: run.frame.w, height: run.frame.h });
    const sb = runImg.toBitmap(); const fw = run.frame.w, fh = run.frame.h;
    const sceneBgra = Buffer.alloc(sb.length); for (let i = 0; i < sb.length; i += 4) { sceneBgra[i] = sb[i + 2]; sceneBgra[i + 1] = sb[i + 1]; sceneBgra[i + 2] = sb[i]; sceneBgra[i + 3] = sb[i + 3]; }
    const scene = { pixels: new Uint8Array(sceneBgra), width: fw, height: fh };
    const mb = material.toBitmap(); const ms = material.getSize();
    const tpl = Buffer.alloc(mb.length); for (let i = 0; i < mb.length; i += 4) { tpl[i] = mb[i + 2]; tpl[i + 1] = mb[i + 1]; tpl[i + 2] = mb[i]; tpl[i + 3] = mb[i + 3]; }
    let sig; try { sig = extractColorPointSignature({ pixels: new Uint8Array(tpl), width: ms.width, height: ms.height }); } catch (e) { console.log(`[canvas-dual] ${mode} sig ERR`, e.message); }
    const matches = sig ? matchColorPointSignature(scene, sig, { threshold: 0, mirror: false, scales: [scaleBuf], maxCandidates: 3 }) : [];
    const top = matches[0];
    const expX = run.cs.tx, expY = run.cs.ty;
    const hit = top && Math.abs(top.x - expX) < 6 && Math.abs(top.y - expY) < 6;
    console.log(`[canvas-dual] ${mode} match(scale=${scaleBuf.toFixed(3)}) = ${top ? `${top.score.toFixed(3)}@(${Math.round(top.x)},${Math.round(top.y)})` : 'none'} 期望@(${expX},${expY}) ${hit ? 'HIT' : 'MISS'}`);
  }
  clearTimeout(timeout);
  win.destroy();
  app.exit(0);
}).catch((error) => { clearTimeout(timeout); console.error('[canvas-dual] FAIL:', error && error.stack ? error.stack : error); app.exit(1); });
