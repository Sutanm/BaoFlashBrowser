const { app, BrowserView, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'WinUseBrowserSpellChecker');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURE = path.join(ROOT, 'tools', 'automation-probe', 'fixtures', 'scale-target.html');
const OUTPUT_DIR = path.join(ROOT, 'release', 'automation-probe');
const VIEWPORT = { width: 1280, height: 720 };
const timeout = setTimeout(() => { console.error('[scale-perf] TIMEOUT'); app.exit(1); }, Number(process.env.SMOKE_TIMEOUT || 120000));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };
const log = (...a) => console.log('[scale-perf]', ...a);

const { extractColorPointSignature, matchColorPointSignature } = require(path.join(ROOT, '.cache', 'vision-benchmark', 'color-lib.cjs'));

function bgraToScene(img) {
  const bmp = img.toBitmap();
  const size = img.getSize();
  const out = Buffer.alloc(bmp.length);
  for (let i = 0; i < bmp.length; i += 4) { out[i] = bmp[i + 2]; out[i + 1] = bmp[i + 1]; out[i + 2] = bmp[i]; out[i + 3] = bmp[i + 3]; }
  return { pixels: new Uint8Array(out), width: size.width, height: size.height };
}

async function capture(wc) {
  wc.incrementCapturerCount();
  try { const im = await wc.capturePage(); assert(!im.isEmpty(), 'empty capture'); return im; }
  finally { wc.decrementCapturerCount(); }
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const win = new BrowserWindow({ show: true, width: 1300, height: 760, webPreferences: { contextIsolation: true } });
  const view = new BrowserView({ webPreferences: { contextIsolation: true, backgroundThrottling: false, partition: 'persist:scale-perf' } });
  win.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, ...VIEWPORT });
  const wc = view.webContents;
  const url = pathToFileURL(FIXTURE).href;
  await wc.setZoomFactor(1);
  await wc.loadURL(`${url}?zoom=1`);
  await delay(300);

  // Timing: DOM probe
  let t0 = Date.now();
  const snap = await wc.executeJavaScript('window.__scaleProbe');
  const domMs = Date.now() - t0;
  log('DOM probe', domMs + 'ms', 'dpr=', snap.viewport.devicePixelRatio);

  // Timing: capturePage
  t0 = Date.now();
  const img = await capture(wc);
  const captureMs = Date.now() - t0;
  const bmp = img.getSize();
  log('capturePage', captureMs + 'ms', 'bitmap=', JSON.stringify(bmp));

  const scene = bgraToScene(img);

  // Build template from hook DOM element (crop in CSS coords scaled to bitmap)
  const scaleX = scene.width / VIEWPORT.width; const scaleY = scene.height / VIEWPORT.height;
  const hr = snap.hook.rect;
  const tplBytes = Buffer.alloc(Math.round(hr.width * scaleX) * Math.round(hr.height * scaleY) * 4);
  let tplW = 0, tplH = 0;
  t0 = Date.now();
  // Crop: copy the hook bitmap region
  const hx = Math.round(hr.x * scaleX), hy = Math.round(hr.y * scaleY), hw = Math.round(hr.width * scaleX), hh = Math.round(hr.height * scaleY);
  const full = img.toBitmap();
  const tplBuf = Buffer.alloc(hw * hh * 4);
  for (let r = 0; r < hh; r += 1) {
    const s = ((hy + r) * scene.width + hx) * 4;
    full.copy(tplBuf, r * hw * 4, s, s + hw * 4);
  }
  const tplBgra = Buffer.alloc(tplBuf.length);
  for (let i = 0; i < tplBuf.length; i += 4) { tplBgra[i] = tplBuf[i + 2]; tplBgra[i + 1] = tplBuf[i + 1]; tplBgra[i + 2] = tplBuf[i]; tplBgra[i + 3] = tplBuf[i + 3]; }
  const cropMs = Date.now() - t0;
  tplW = hw; tplH = hh;
  log('template crop', cropMs + 'ms', 'hook=', tplW + 'x' + tplH);

  // Timing: color matcher (pure) at several scales
  const scales = [.5, .6, .67, .75, .85, 1, 1.2, 1.5, 2, 3];
  t0 = Date.now();
  let sig;
  try { sig = extractColorPointSignature({ pixels: new Uint8Array(tplBgra), width: tplW, height: tplH }); } catch (e) { log('signature ERR', e.message); }
  const sigMs = Date.now() - t0;
  log('signature extract', sigMs + 'ms', 'groups=', sig ? sig.colorGroups.length : 'ERR');

  t0 = Date.now();
  const matches = matchColorPointSignature(scene, sig, { threshold: 0, mirror: false, scales, maxCandidates: 3 });
  const colorMs = Date.now() - t0;
  const top = matches[0];
  log('识色匹配(纯,多档)', colorMs + 'ms', 'top=', top ? `${top.score.toFixed(3)}@(${Math.round(top.x)},${Math.round(top.y)}) s=${top.scale}` : 'none');

  // Also measure single-scale cost
  t0 = Date.now();
  const m1 = matchColorPointSignature(scene, sig, { threshold: 0, mirror: false, scales: [1], maxCandidates: 1 });
  const singleMs = Date.now() - t0;
  log('识色匹配(单档 scale=1)', singleMs + 'ms');

  const result = { viewport: VIEWPORT, bitmap: bmp, dpr: snap.viewport.devicePixelRatio, domMs, captureMs, sigMs, colorMs, singleMs, top: top ? { x: top.x, y: top.y, scale: top.scale, score: top.score } : null };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'scale-perf.json'), JSON.stringify(result, null, 2));
  log('RESULT', JSON.stringify(result));
  clearTimeout(timeout);
  win.destroy();
  app.exit(0);
}).catch((error) => {
  clearTimeout(timeout);
  console.error('[scale-perf] FAIL:', error && error.stack ? error.stack : error);
  app.exit(1);
});
