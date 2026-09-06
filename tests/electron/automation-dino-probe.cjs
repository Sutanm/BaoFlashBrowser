const { app, BrowserView, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'WinUseBrowserSpellChecker');
app.on('window-all-closed', () => {});
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'dino-probe-')));
const timeout = setTimeout(() => { console.error('[dino-probe] TIMEOUT'); app.exit(1); }, 120000);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const TARGET_URL = process.env.BAO_URL || 'https://dinosaur.game/zh/dinosaur-game';

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1300, height: 760 });
  const VIEWPORT = { width: 1280, height: 720 };
  const view = new BrowserView({ webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, partition: 'persist:dino-probe' } });
  win.addBrowserView(view); view.setBounds({ x: 0, y: 0, ...VIEWPORT });
  const wc = view.webContents;
  await wc.loadURL(TARGET_URL);
  await delay(4000); // allow game boot

  const info = await wc.executeJavaScript(`(() => {
    const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
    const canvases = Array.from(document.querySelectorAll('canvas')).map((c) => ({ tag: 'canvas', rect: r(c), w: c.width, h: c.height }));
    const embeds = Array.from(document.querySelectorAll('embed, object')).map((e) => ({ tag: e.tagName.toLowerCase(), src: (e.getAttribute('src')||'').slice(0,80), rect: r(e) }));
    const bodyRect = r(document.body);
    return { canvases, embeds, bodyRect, innerWidth, innerHeight, dpr: window.devicePixelRatio, title: document.title, url: location.href };
  })()`).catch((e) => ({ error: e.message }));

  console.log('[dino-probe] URL loaded');
  console.log('[dino-probe] info=', JSON.stringify(info, null, 2).slice(0, 2500));

  // Try the real detectGameSurfaces via main pipeline (if available)
  try {
    global.AbortController = undefined;
    const { BrowserViewAutomationCoreSession, detectGameSurfaces } = require('../../release/tests/automation-authoring-core.cjs');
    const handle = {
      tabId: 't', webContents: wc, ready: Promise.resolve(),
      getCssViewport: () => ({ ...VIEWPORT }), getViewportTransform: () => ({ logicalSize: { ...VIEWPORT }, displaySize: { ...VIEWPORT }, scaleX: 1, scaleY: 1 }),
      getViewportRevision: () => 1, assertCurrent: () => {}, release: () => {},
    };
    const surfaces = await detectGameSurfaces(wc);
    console.log('[dino-probe] detectGameSurfaces count=', surfaces.length);
    console.log('[dino-probe] surfaces=', JSON.stringify(surfaces.map((s) => ({ kind: s.kind, label: s.label, rect: s.rect, frameUrl: s.frameUrl.slice(0, 60) })), null, 2));
  } catch (e) {
    console.log('[dino-probe] detectGameSurfaces ERR=', e.message);
  }

  clearTimeout(timeout);
  win.destroy();
  app.exit(0);
}).catch((error) => { clearTimeout(timeout); console.error('[dino-probe] FAIL:', error && error.stack ? error.stack : error); app.exit(1); });
