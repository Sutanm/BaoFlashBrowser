const { app, BrowserView, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'WinUseBrowserSpellChecker');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURE = path.join(ROOT, 'tools', 'automation-probe', 'fixtures', 'scale-calib.html');
const OUTPUT_DIR = path.join(ROOT, 'release', 'automation-probe');
const VIEWPORT = { width: 1280, height: 720 };
const timeout = setTimeout(() => { console.error('[calib-probe] TIMEOUT'); app.exit(1); }, Number(process.env.SMOKE_TIMEOUT || 120000));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, m) => { if (!c) throw new Error(m); };
const log = (...a) => console.log('[calib-probe]', ...a);

async function capture(wc) {
  wc.incrementCapturerCount();
  try { const im = await wc.capturePage(); assert(!im.isEmpty(), 'empty capture'); return im; }
  finally { wc.decrementCapturerCount(); }
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const win = new BrowserWindow({ show: true, width: 1300, height: 760, webPreferences: { contextIsolation: true } });
  const view = new BrowserView({ webPreferences: { contextIsolation: true, backgroundThrottling: false, partition: 'persist:calib-probe' } });
  win.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, ...VIEWPORT });
  const wc = view.webContents;
  const url = pathToFileURL(FIXTURE).href;

  const runs = [];
  for (const z of [1, 1.25, 1.5, 2]) {
    await wc.setZoomFactor(z);
    await wc.loadURL(`${url}?zoom=${z}`);
    await delay(250);
    const p = await wc.executeJavaScript('window.__calProbe');
    const img = await capture(wc);
    const bmp = img.getSize();
    const cssX = bmp.width / VIEWPORT.width; const cssY = bmp.height / VIEWPORT.height;
    // Wait: bmp is physical pixels; CSS->physical = bmp/VIEWPORT gives DPR-inclusive scale
    const hudPhysicalW = p.hud.width * cssX;
    const hudPhysicalH = p.hud.height * cssY;
    const gamePhysicalW = p.game.width * cssX;
    log(`zoom=${z} | bitmap=${bmp.width}x${bmp.height} DPR=${p.dpr} inner=${p.inner.innerWidth}x${p.inner.innerHeight}`);
    log(`   HUD CSS=${p.hud.width.toFixed(1)}x${p.hud.height.toFixed(1)} -> 帧内物理≈${hudPhysicalW.toFixed(1)}x${hudPhysicalH.toFixed(1)} (DPR换算后实际=${(p.hud.width*(bmp.width/VIEWPORT.width)).toFixed(1)})`);
    log(`   GAME CSS=${p.game.width.toFixed(1)}x${p.game.height.toFixed(1)} -> 帧内物理≈${gamePhysicalW.toFixed(1)}`);
    runs.push({ z, bitmap: bmp, dpr: p.dpr, inner: p.inner, hud: p.hud, game: p.game, cssX: cssX.toFixed(4) });
  }
  fs.writeFileSync(path.join(OUTPUT_DIR, 'calib-result.json'), JSON.stringify({ viewport: VIEWPORT, runs }, null, 2));
  // Summary: does bitmap size / HUD CSS remain constant across zoom?
  const first = runs[0];
  log('\n=== 结论 ===');
  for (const r of runs) {
    log(`zoom=${r.z}: bitmap=${r.bitmap.width}x${r.bitmap.height} DPR=${r.dpr.toFixed(3)} HUD物理宽=${(r.hud.width * r.cssX).toFixed(1)}`);
  }
  const allHudPhys = runs.map((r) => r.hud.width * r.cssX);
  const spread = Math.max(...allHudPhys) - Math.min(...allHudPhys);
  log(`HUD帧内物理宽最大差=${spread.toFixed(2)}px —— ${spread < 1 ? '基本恒定(scale不受zoom影响)' : '受zoom影响(scale随zoom变)'}`);
  clearTimeout(timeout);
  win.destroy();
  app.exit(0);
}).catch((error) => {
  clearTimeout(timeout);
  console.error('[calib-probe] FAIL:', error && error.stack ? error.stack : error);
  app.exit(1);
});
