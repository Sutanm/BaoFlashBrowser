const { app, BrowserView, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
app.on('window-all-closed', () => {});
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-type-')));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const SITES = {
  'dino': 'https://dinosaur.game/zh/dinosaur-game',
  '4399': 'https://www.4399.com/',
  '7k7k': 'https://www.7k7k.com/',
  '2144': 'https://www.2144.com/',
  'wanmei': 'https://www.wanmei.com/',
  '265g': 'https://www.265g.com/',
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1300, height: 760 });
  const VIEWPORT = { width: 1280, height: 720 };
  const view = new BrowserView({ webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, partition: 'persist:canvas-type' } });
  win.addBrowserView(view);
  win.webContents.setBackgroundThrottling(false);
  view.setBounds({ x: 0, y: 0, ...VIEWPORT });
  const wc = view.webContents;

  for (const [name, url] of Object.entries(SITES)) {
    try {
      await wc.loadURL(url);
      await delay(5000);
    } catch (err) {
      console.log(`[canvas-type] ${name}: load ERR ${err.message}`);
      continue;
    }
    for (const z of [1, 1.5, 2]) {
      try {
        await wc.setZoomFactor(z);
        await delay(600);
        const r = await wc.executeJavaScript(`(() => {
          const cans = [...document.querySelectorAll('canvas')];
          if (!cans.length) return { n: 0, dpr: 0, cssW: 0, cssH: 0, bufW: 0, bufH: 0, bufCssRatio: 0 };
          const c = cans[0]; const b = c.getBoundingClientRect();
          const bw = c.width, bh = c.height;
          return { n: cans.length, cssW: Math.round(b.width), cssH: Math.round(b.height), bufW: bw, bufH: bh, dpr: window.devicePixelRatio || 0, iw: innerWidth, ih: innerHeight, bufCssRatio: bw && b.width ? +(bw / b.width).toFixed(3) : 0 };
        })()`);
        const tag = r.n ? (r.cssW === r.bufW ? 'FIXED' : 'adap') : 'NOCANVAS';
        console.log(`[canvas-type] ${name} zoom=${z} dpr=${r.dpr.toFixed(2)} css=${r.cssW}x${r.cssH} buf=${r.bufW}x${r.bufH} buf/css=${r.bufCssRatio} n=${r.n} => ${tag}`);
      } catch (err) {
        console.log(`[canvas-type] ${name} zoom=${z}: probe ERR ${err.message}`);
      }
    }
  }
  win.destroy();
  app.exit(0);
}).catch((error) => { console.error('[canvas-type] FAIL:', error && error.stack ? error.stack : error); app.exit(1); });
