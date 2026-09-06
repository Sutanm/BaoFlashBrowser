const { app, BrowserView, BrowserWindow, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
app.on('window-all-closed', () => {});
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'dino-loop-')));
const timeout = setTimeout(() => { console.error('[dino-loop] TIMEOUT'); app.exit(1); }, 120000);
const COLMOD = require(path.join(__dirname, '..', '..', '.cache', 'vision-benchmark', 'color-lib.cjs'));
const { extractColorPointSignature, matchColorPointSignature } = COLMOD;

const TARGET_URL = process.env.BAO_URL || 'https://dinosaur.game/zh/dinosaur-game';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1300, height: 760 });
  const VIEWPORT = { width: 1280, height: 720 };
  const view = new BrowserView({ webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, partition: 'persist:dino-loop' } });
  win.addBrowserView(view); view.setBounds({ x: 0, y: 0, ...VIEWPORT });
  const wc = view.webContents;
  await wc.loadURL(TARGET_URL);
  await delay(4000);

  async function metrics() {
    return wc.executeJavaScript(`(() => { const c = document.querySelector('canvas'); const b = c.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, dpr: window.devicePixelRatio, innerWidth, innerHeight, zoomHint: c.getBoundingClientRect().width }; })()`);
  }
  const m1 = await metrics();
  console.log('[dino-loop] canvas@zoom1=', JSON.stringify(m1));
  global.AbortController = undefined;
  const { BrowserViewAutomationCoreSession } = require('../../release/tests/automation-authoring-core.cjs');
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
  console.log('[dino-loop] frame=', `${frame.width}x${frame.height}`);

  // "material" = crop the CANVAS region (the game surface). This is the whole game screen asset.
  const canvasMat = frameImg.crop({ x: Math.round(m1.x), y: Math.round(m1.y), width: Math.round(m1.width), height: Math.round(m1.height) });
  const matSize = canvasMat.getSize();
  console.log('[dino-loop] material(canvas region)=', JSON.stringify(matSize), '(reference surface size)');

  // Now change zoom -> canvas CSS size should change (runtime surface differs).
  await wc.setZoomFactor(1.5);
  await delay(600);
  const m2 = await metrics();
  console.log('[dino-loop] canvas@zoom1.5=', JSON.stringify(m2));
  const frame2 = await session.capturePreview();
  const frameImg2 = nativeImage.createFromBitmap(Buffer.from(frame2.bitmap), { width: frame2.width, height: frame2.height });
  // predicted scale via surfaceReferenceImageScales equivalent: current surface / reference surface
  const scale = m2.width / m1.width;
  console.log('[dino-loop] derivedScale(curSurface/refSurface)=', scale.toFixed(4));

  // Encode scene2 (BGRA) + template (canvasMat) and match at derived scale.
  const full2 = frameImg2.toBitmap(); const fw = frame2.width, fh = frame2.height;
  const sceneBgra = Buffer.alloc(full2.length);
  for (let i = 0; i < full2.length; i += 4) { sceneBgra[i] = full2[i + 2]; sceneBgra[i + 1] = full2[i + 1]; sceneBgra[i + 2] = full2[i]; sceneBgra[i + 3] = full2[i + 3]; }
  const scene = { pixels: new Uint8Array(sceneBgra), width: fw, height: fh };
  const mb = canvasMat.toBitmap(); const mbS = canvasMat.getSize();
  const tpl = Buffer.alloc(mb.length);
  for (let i = 0; i < mb.length; i += 4) { tpl[i] = mb[i + 2]; tpl[i + 1] = mb[i + 1]; tpl[i + 2] = mb[i]; tpl[i + 3] = mb[i + 3]; }
  let sig; try { sig = extractColorPointSignature({ pixels: new Uint8Array(tpl), width: mbS.width, height: mbS.height }); } catch (e) { console.log('[dino-loop] template sig ERR', e.message); }
  const matches = sig ? matchColorPointSignature(scene, sig, { threshold: 0, mirror: false, scales: [scale], maxCandidates: 3 }) : [];
  const top = matches[0];
  console.log('[dino-loop] match(scale=' + scale.toFixed(3) + ') =', top ? `${top.score.toFixed(3)}@(${Math.round(top.x)},${Math.round(top.y)}) ${Math.round(top.width)}x${Math.round(top.height)}` : 'none');
  console.log('[dino-loop] expected canvas top-left @(', Math.round(m2.x) + ',' + Math.round(m2.y) + ') size ', Math.round(m2.width) + 'x' + Math.round(m2.height));
  fs.writeFileSync(path.join(__dirname, '..', '..', 'release', 'automation-probe', 'dino-loop.json'), JSON.stringify({ m1, matSize, m2, derivedScale: scale, match: top ? { x: top.x, y: top.y, score: top.score, width: top.width, height: top.height } : null }, null, 2));
  clearTimeout(timeout);
  win.destroy();
  app.exit(0);
}).catch((error) => { clearTimeout(timeout); console.error('[dino-loop] FAIL:', error && error.stack ? error.stack : error); app.exit(1); });
