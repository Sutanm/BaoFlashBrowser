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
const timeout = setTimeout(() => { console.error('[tiny-probe] TIMEOUT'); app.exit(1); }, Number(process.env.SMOKE_TIMEOUT || 120000));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };
const log = (...a) => console.log('[tiny-probe]', ...a);

const { extractColorPointSignature, matchColorPointSignature } = require(path.join(ROOT, '.cache', 'vision-benchmark', 'color-lib.cjs'));

async function capture(wc) {
  wc.incrementCapturerCount();
  try { const im = await wc.capturePage(); assert(!im.isEmpty(), 'empty capture'); return im; }
  finally { wc.decrementCapturerCount(); }
}
function bgra(img) {
  const bmp = img.toBitmap(); const size = img.getSize();
  const out = Buffer.alloc(bmp.length);
  for (let i = 0; i < bmp.length; i += 4) { out[i] = bmp[i + 2]; out[i + 1] = bmp[i + 1]; out[i + 2] = bmp[i]; out[i + 3] = bmp[i + 3]; }
  return { pixels: new Uint8Array(out), width: size.width, height: size.height };
}
function cropBmp(bmp, x, y, w, h) {
  const out = Buffer.alloc(w * h * 4);
  for (let r = 0; r < h; r += 1) { const s = ((y + r) * bmp.width + x) * 4; Buffer.from(bmp.pixels).copy(out, r * w * 4, s, s + w * 4); }
  return out;
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const win = new BrowserWindow({ show: true, width: 1300, height: 760, webPreferences: { contextIsolation: true } });
  const view = new BrowserView({ webPreferences: { contextIsolation: true, backgroundThrottling: false, partition: 'persist:tiny-probe' } });
  win.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, ...VIEWPORT });
  const wc = view.webContents;

  const sizes = [{ cssW: 32, cssH: 40, label: 'large' }, { cssW: 12, cssH: 15, label: 'small' }, { cssW: 8, cssH: 10, label: 'tiny' }, { cssW: 6, cssH: 8, label: 'micro' }];
  const scales = [.5, .75, 1, 1.25, 1.5, 2];
  for (const s of sizes) {
    const url = `${pathToFileURL(FIXTURE).href}?zoom=1&hookw=${s.cssW}&hookh=${s.cssH}`;
    await wc.setZoomFactor(1);
    await wc.loadURL(url);
    await delay(250);
    const snap = await wc.executeJavaScript('window.__scaleProbe');
    const img = await capture(wc);
    const bmp = img.getSize();
    const scene = bgra(img);
    const scaleX = scene.width / VIEWPORT.width; const scaleY = scene.height / VIEWPORT.height;
    const hr = snap.hook.rect;
    const hx = Math.round(hr.x * scaleX), hy = Math.round(hr.y * scaleY), hw = Math.round(hr.width * scaleX), hh = Math.round(hr.height * scaleY);
    let signature = 'ERR'; let hit = 'none';
    const tplBmp = cropBmp(scene, hx, hy, hw, hh);
    try {
      const sig = extractColorPointSignature({ pixels: tplBmp, width: hw, height: hh });
      signature = `groups=${sig.colorGroups.length}`;
      const m = matchColorPointSignature(scene, sig, { threshold: 0, mirror: false, scales, maxCandidates: 3 });
      const top = m[0];
      hit = top ? `${top.score.toFixed(3)}@(${Math.round(top.x)},${Math.round(top.y)}) s=${top.scale}` : 'none';
    } catch (e) { signature = 'ERR ' + e.message; }
    log(`CSS=${s.cssW}x${s.cssH} (${s.label}) bitmap帧=${bmp.width}x${bmp.height} 目标实际像素=${hw}x${hh} DPR=${snap.viewport.devicePixelRatio} 签名=${signature} 识色=${hit}`);
  }
  clearTimeout(timeout);
  win.destroy();
  app.exit(0);
}).catch((error) => {
  clearTimeout(timeout);
  console.error('[tiny-probe] FAIL:', error && error.stack ? error.stack : error);
  app.exit(1);
});
