// Probe 47 helper: runs in a separate Electron process with PPAPI switches
// (they must be appended before app ready, which the probe host cannot do).
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');

const root = process.argv[2];
if (!root) {
  console.log('FLASH_RESULT:' + JSON.stringify({ ok: false, error: 'missing-root' }));
  process.exit(0);
}

const plugin = path.join(root, 'plugins', 'win64', 'pepflashplayer64.dll');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-flash-probe-'));
require('electron').app.setPath('userData', userData);
require('electron').app.commandLine.appendSwitch('ppapi-flash-path', plugin);
require('electron').app.commandLine.appendSwitch('ppapi-flash-version', '34.0.0.330');
require('electron').app.commandLine.appendSwitch('disable-flash-sandbox');
require('electron').app.commandLine.appendSwitch('ignore-gpu-blacklist');

const { app, BrowserWindow, BrowserView } = require('electron');
app.on('window-all-closed', () => { /* keep alive until probe finishes */ });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function captureWithCount(wc, size, attempts = 12) {
  wc.incrementCapturerCount(size, true);
  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const image = await wc.capturePage();
      const dims = image.getSize();
      if (dims.width > 0 && dims.height > 0) return image;
      await wait(400);
    }
    return wc.capturePage();
  } finally { wc.decrementCapturerCount(true); }
}

function pixelStats(image) {
  const size = image.getSize();
  const bitmap = image.toBitmap();
  let min = 255;
  let max = 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < bitmap.length; i += 4 * 97) {
    const value = bitmap[i] + bitmap[i + 1] + bitmap[i + 2];
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
    count += 1;
  }
  return { width: size.width, height: size.height, min, max, mean: count ? Math.round(sum / count) : 0 };
}

app.whenReady().then(async () => {
  const result = { ok: false };
  const winA = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  const winB = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { contextIsolation: true, nodeIntegration: false } });
  const view = new BrowserView({ webPreferences: { plugins: true, contextIsolation: true, nodeIntegration: false, partition: 'persist:flash-tear-off' } });
  winA.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
  try {
    const swf = path.join(root, 'tests', 'sample-swf-files-sample_1280x720.swf');
    await view.webContents.loadURL(pathToFileURL(swf).toString()).catch(() => {});
    await wait(2500);
    const wc = view.webContents;
    const embeds = await wc.executeJavaScript('document.embeds.length').catch(() => -1);
    const before = pixelStats(await captureWithCount(wc, { width: 800, height: 600 }));
    const first = { wcId: wc.id, pid: wc.getOSProcessId(), embeds, before };

    winA.removeBrowserView(view);
    await wait(150);
    winB.addBrowserView(view);
    view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
    await wait(600);
    const after = pixelStats(await captureWithCount(wc, { width: 800, height: 600 }));

    result.ok = Boolean(embeds > 0
      && wc.id === first.wcId
      && wc.getOSProcessId() === first.pid
      && !wc.isDestroyed()
      && before.width > 0 && before.height > 0
      && before.max - before.min > 8
      && after.max - after.min > 8
      && after.width === before.width && after.height === before.height
      && winB.getBrowserViews().length === 1 && winA.getBrowserViews().length === 0);
    result.first = first;
    result.after = after;
  } catch (error) {
    result.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
  } finally {
    console.log('FLASH_RESULT:' + JSON.stringify(result));
    try { if (!view.webContents.isDestroyed()) view.webContents.destroy(); } catch { /* ignore */ }
    for (const win of [winA, winB]) { try { if (!win.isDestroyed()) win.destroy(); } catch { /* ignore */ } }
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }
    setTimeout(() => app.quit(), 100);
  }
});
