const { app, BrowserView, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
app.on('window-all-closed', () => {});
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'dino-buffer-')));
const timeout = setTimeout(() => { console.error('[dino-buffer] TIMEOUT'); app.exit(1); }, 120000);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const TARGET_URL = process.env.BAO_URL || 'https://dinosaur.game/zh/dinosaur-game';

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1300, height: 760 });
  const VIEWPORT = { width: 1280, height: 720 };
  const view = new BrowserView({ webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, partition: 'persist:dino-buffer' } });
  win.addBrowserView(view); view.setBounds({ x: 0, y: 0, ...VIEWPORT });
  const wc = view.webContents;
  await wc.loadURL(TARGET_URL);
  await delay(4000);
  async function probe(z) {
    await wc.setZoomFactor(z);
    await delay(500);
    const r = await wc.executeJavaScript(`(() => {
      const c = document.querySelector('canvas');
      if (!c) return { err: 'no canvas' };
      const b = c.getBoundingClientRect();
      return { cssX: b.x, cssY: b.y, cssW: b.width, cssH: b.height, bufferW: c.width, bufferH: c.height, dpr: window.devicePixelRatio, innerWidth, innerHeight };
    })()`);
    return r;
  }
  for (const z of [1, 1.25, 1.5, 2]) {
    const r = await probe(z);
    console.log(`[dino-buffer] zoom=${z} CSS=${r.cssW.toFixed(0)}x${r.cssH.toFixed(0)} buffer=${r.bufferW}x${r.bufferH} dpr=${r.dpr.toFixed(2)} inner=${r.innerWidth}x${r.innerHeight}`);
  }
  clearTimeout(timeout);
  win.destroy();
  app.exit(0);
}).catch((error) => { clearTimeout(timeout); console.error('[dino-buffer] FAIL:', error && error.stack ? error.stack : error); app.exit(1); });
