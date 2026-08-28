/**
 * Virtual logical viewport probe for Electron 11 / Chromium 87.
 * It verifies that automation can normalize screenshots and map transient-CDP
 * input across host sizes without changing the live page zoom or its bounds.
 */
const { app, BrowserView, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('force-device-scale-factor', '1.25');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.on('window-all-closed', () => {});

const ROOT = process.env.BAO_PROBE_ROOT
  ? path.resolve(process.env.BAO_PROBE_ROOT)
  : path.join(__dirname, '..', '..');
const OUTPUT_DIR = path.join(ROOT, 'release', 'automation-probe');
const REFERENCE = { width: 1000, height: 600 };
const TARGET = { x: 730, y: 410 };
const REGION = { x: 650, y: 340, width: 220, height: 150 };
const CASES = [
  { name: 'large', available: { width: 1200, height: 720 } },
  { name: 'windowed', available: { width: 800, height: 600 } },
  { name: 'narrow', available: { width: 660, height: 500 } },
];
const timeout = setTimeout(() => { console.error('[fixed-viewport] FAIL: timed out'); app.exit(1); }, 45_000);

function assert(condition, message) { if (!condition) throw new Error(message); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function pageUrl() {
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#182136}
    canvas{display:block;width:100%;height:100%}
  </style><canvas width="${REFERENCE.width}" height="${REFERENCE.height}"></canvas><script>
    const canvas=document.querySelector('canvas');const ctx=canvas.getContext('2d');
    function draw(){ctx.fillStyle='#182136';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#20e080';ctx.fillRect(${TARGET.x - 20},${TARGET.y - 20},40,40);ctx.fillStyle='#fff';ctx.font='24px sans-serif';ctx.fillText(innerWidth+'x'+innerHeight,20,35)}
    draw();window.__clicks=[];addEventListener('resize',draw);addEventListener('mousedown',e=>{const tx=${TARGET.x / REFERENCE.width}*innerWidth,ty=${TARGET.y / REFERENCE.height}*innerHeight;const hit=Math.abs(e.clientX-tx)<=22&&Math.abs(e.clientY-ty)<=22;window.__clicks.push({x:e.clientX,y:e.clientY,tx,ty,hit})});
  <\/script>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

async function capture(wc, rect) {
  wc.incrementCapturerCount();
  try {
    const image = await wc.capturePage(rect);
    assert(!image.isEmpty(), 'capture is empty');
    return image;
  } finally {
    wc.decrementCapturerCount();
  }
}

function greenBounds(image) {
  const size = image.getSize();
  const bitmap = image.toBitmap();
  let left = size.width; let top = size.height; let right = -1; let bottom = -1; let count = 0;
  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      const offset = (y * size.width + x) * 4;
      const blue = bitmap[offset]; const green = bitmap[offset + 1]; const red = bitmap[offset + 2];
      if (green > 170 && red < 90 && blue > 60 && blue < 190) {
        left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); count += 1;
      }
    }
  }
  return right >= left ? { left, top, right, bottom, count, centerX: (left + right) / 2, centerY: (top + bottom) / 2 } : null;
}

async function clickAt(wc, point) {
  wc.debugger.attach('1.3');
  try {
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  } finally {
    if (wc.debugger.isAttached()) wc.debugger.detach();
  }
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const host = new BrowserWindow({ show: true, width: 1240, height: 780, backgroundColor: '#080b12' });
  const view = new BrowserView({ webPreferences: { nodeIntegration: false, contextIsolation: true, plugins: false, backgroundThrottling: false } });
  host.addBrowserView(view);
  const wc = view.webContents;
  view.setBounds({ x: 0, y: 0, width: REFERENCE.width, height: REFERENCE.height });
  await wc.loadURL(pageUrl());

  const results = [];
  for (const item of CASES) {
    const scaleX = item.available.width / REFERENCE.width;
    const scaleY = item.available.height / REFERENCE.height;
    const bounds = { x: 0, y: 0, width: item.available.width, height: item.available.height };
    host.setContentSize(item.available.width, item.available.height);
    view.setBounds(bounds);
    await delay(350);

    const metrics = await wc.executeJavaScript(`({innerWidth,innerHeight,devicePixelRatio,clicks:window.__clicks=[]})`);
    const full = await capture(wc);
    const fullGreen = greenBounds(full);
    assert(fullGreen, `${item.name}: green marker missing from full capture`);
    const fullSize = full.getSize();
    const reconstructed = {
      x: fullGreen.centerX / fullSize.width * REFERENCE.width,
      y: fullGreen.centerY / fullSize.height * REFERENCE.height,
    };

    await clickAt(wc, { x: TARGET.x * scaleX, y: TARGET.y * scaleY });
    await delay(50);
    const displayMappedClick = await wc.executeJavaScript('window.__clicks[window.__clicks.length - 1]');

    const displayRegion = {
      x: Math.round(REGION.x * scaleX), y: Math.round(REGION.y * scaleY),
      width: Math.round(REGION.width * scaleX), height: Math.round(REGION.height * scaleY),
    };
    const cropped = await capture(wc, displayRegion);
    const cropGreen = greenBounds(cropped);
    assert(cropGreen, `${item.name}: green marker missing from display-scaled region capture`);
    const cropSize = cropped.getSize();
    const cropReconstructed = {
      x: REGION.x + cropGreen.centerX / cropSize.width * REGION.width,
      y: REGION.y + cropGreen.centerY / cropSize.height * REGION.height,
    };

    fs.writeFileSync(path.join(OUTPUT_DIR, `fixed-viewport-${item.name}.png`), full.toPNG());
    results.push({
      name: item.name, available: item.available, mapping: { scaleX, scaleY }, actualZoom: wc.getZoomFactor(), bounds,
      metrics, capture: { size: fullSize, marker: fullGreen, reconstructed },
      regionCapture: { requested: displayRegion, size: cropSize, marker: cropGreen, reconstructed: cropReconstructed },
      displayMappedClick, debuggerDetached: !wc.debugger.isAttached(),
    });
  }

  for (const result of results) {
    assert(Math.abs(result.actualZoom - 1) <= 0.001,
      `${result.name}: automation changed the live page zoom: ${result.actualZoom}`);
    assert(result.bounds.width === result.available.width && result.bounds.height === result.available.height,
      `${result.name}: automation letterboxed the BrowserView: ${JSON.stringify(result.bounds)}`);
    assert(Math.abs(result.capture.reconstructed.x - TARGET.x) <= 2 && Math.abs(result.capture.reconstructed.y - TARGET.y) <= 2,
      `${result.name}: full screenshot mapping drifted: ${JSON.stringify(result.capture.reconstructed)}`);
    assert(result.displayMappedClick && result.displayMappedClick.hit,
      `${result.name}: display-mapped CDP click drifted: ${JSON.stringify(result.displayMappedClick)}`);
    assert(Math.abs(result.regionCapture.reconstructed.x - TARGET.x) <= 3 && Math.abs(result.regionCapture.reconstructed.y - TARGET.y) <= 3,
      `${result.name}: regional screenshot mapping drifted: ${JSON.stringify(result.regionCapture.reconstructed)}`);
    assert(result.debuggerDetached, `${result.name}: debugger remained attached`);
  }

  const output = { reference: REFERENCE, forcedDeviceScaleFactor: 1.25, target: TARGET, region: REGION, results };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'fixed-viewport-result.json'), JSON.stringify(output, null, 2));
  console.log('[fixed-viewport] PASS', JSON.stringify(output));
  clearTimeout(timeout);
  host.destroy();
  app.exit(0);
}).catch((error) => {
  clearTimeout(timeout);
  console.error('[fixed-viewport] FAIL:', error && error.stack ? error.stack : String(error));
  app.exit(1);
});
