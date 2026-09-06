const { app, BrowserView, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
app.on('window-all-closed', () => {});
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'bao-scale-reference-')));
const watchdog = setTimeout(() => { console.error('[scale-reference] TIMEOUT'); app.exit(1); }, 90_000);

const FIXTURE = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#102033}
#game{position:absolute;left:80px;top:60px;width:600px;height:360px;background:#155e75;overflow:hidden}
#target{position:absolute;left:240px;top:140px;width:120px;height:72px;background:#f59e0b;box-shadow:inset 0 0 0 8px #7c2d12}
#target:before{content:"";position:absolute;left:18px;top:12px;width:18px;height:18px;background:#fff}
#target:after{content:"";position:absolute;right:15px;bottom:10px;width:15px;height:15px;background:#2563eb}
</style><div id="game"><div id="target"></div></div>`;

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function toRgba(bitmap) {
  const result = Buffer.alloc(bitmap.length);
  for (let i = 0; i < bitmap.length; i += 4) {
    result[i] = bitmap[i + 2]; result[i + 1] = bitmap[i + 1]; result[i + 2] = bitmap[i]; result[i + 3] = bitmap[i + 3];
  }
  return new Uint8Array(result);
}
function orangeBounds(image) {
  const { width, height } = image.getSize(); const pixels = toRgba(image.toBitmap());
  let left = width; let top = height; let right = -1; let bottom = -1;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const i = (y * width + x) * 4; const r = pixels[i]; const g = pixels[i + 1]; const b = pixels[i + 2];
    if (r > 190 && g > 75 && g < 190 && b < 55) { left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); }
  }
  if (right < left) throw new Error('fixture target was not found in captured frame');
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}
function iou(a, b) {
  const x1 = Math.max(a.x, b.x); const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width); const y2 = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return intersection / (a.width * a.height + b.width * b.height - intersection);
}

app.whenReady().then(async () => {
  const core = require('../../release/tests/automation-authoring-core.cjs');
  const win = new BrowserWindow({ show: true, width: 1360, height: 800 });
  const view = new BrowserView({ webPreferences: { nodeIntegration: false, contextIsolation: true } });
  win.addBrowserView(view);
  const wc = view.webContents;
  let displaySize = { width: 1280, height: 720 }; let revision = 1;
  const logicalSize = { width: 1280, height: 720 };
  const settle = async (bounds, zoom) => {
    view.setBounds({ x: 0, y: 0, ...bounds }); wc.setZoomFactor(zoom); revision += 1;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await delay(30);
      displaySize = await wc.executeJavaScript('({width:innerWidth,height:innerHeight})');
      if (Math.abs(displaySize.width - bounds.width / zoom) <= 2 && Math.abs(displaySize.height - bounds.height / zoom) <= 2) return;
    }
    throw new Error(`viewport did not settle: ${JSON.stringify({ bounds, zoom, displaySize })}`);
  };
  view.setBounds({ x: 0, y: 0, ...logicalSize });
  await wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(FIXTURE)}`);
  const handle = {
    tabId: 'scale-reference', webContents: wc, ready: Promise.resolve(),
    getCssViewport: () => ({ ...logicalSize }),
    getViewportTransform: () => ({ logicalSize: { ...logicalSize }, displaySize: { ...displaySize }, scaleX: displaySize.width / logicalSize.width, scaleY: displaySize.height / logicalSize.height }),
    getViewportRevision: () => revision, waitForViewport: async () => {}, assertCurrent: () => {}, release: () => {},
  };
  const assets = new Map();
  const session = new core.BrowserViewAutomationCoreSession(handle, {
    manifest: { format: 'baoauto', formatVersion: 3, id: 'scale-reference', name: 'Scale reference', frontends: {}, features: [], integrity: {} },
    workflow: { formatVersion: 3, id: 'scale-reference', name: 'Scale reference', root: { id: 'root', kind: 'sequence', nodes: [] } },
    scripts: new Map(), assets, profiles: new Map(),
  });
  const scenarios = [
    ['zoom-1-to-1', { width: 1280, height: 720 }, 1, { width: 1280, height: 720 }, 1],
    ['zoom-1-to-1.5', { width: 1280, height: 720 }, 1, { width: 1280, height: 720 }, 1.5],
    ['zoom-1.5-to-1', { width: 1280, height: 720 }, 1.5, { width: 1280, height: 720 }, 1],
    ['zoom-1.25-to-1.5', { width: 1280, height: 720 }, 1.25, { width: 1280, height: 720 }, 1.5],
    ['window-to-max', { width: 960, height: 540 }, 1, { width: 1280, height: 720 }, 1],
    ['max-to-window', { width: 1280, height: 720 }, 1, { width: 960, height: 540 }, 1],
  ];
  for (const [name, authorBounds, authorZoom, runtimeBounds, runtimeZoom] of scenarios) {
    await settle(authorBounds, authorZoom);
    const authorTransform = session.currentViewportTransform();
    const authorPreview = await session.capturePreview();
    const authorImage = nativeImage.createFromBitmap(Buffer.from(authorPreview.bitmap), { width: authorPreview.width, height: authorPreview.height });
    const authorBox = orangeBounds(authorImage);
    const template = authorImage.crop(authorBox);
    const assetName = `target-${name}.png`;
    assets.set(`assets/${assetName}`, new Uint8Array(template.toPNG()));
    await settle(runtimeBounds, runtimeZoom);
    const runtimeTransform = session.currentViewportTransform();
    const runtimePreview = await session.capturePreview();
    const runtimeImage = nativeImage.createFromBitmap(Buffer.from(runtimePreview.bitmap), { width: runtimePreview.width, height: runtimePreview.height });
    const runtimeBox = orangeBounds(runtimeImage);
    const predicted = core.surfaceReferenceImageScales(
      [{ width: 600, height: 360, viewportTransform: authorTransform }],
      { width: 600, height: 360, viewportTransform: runtimeTransform },
    )?.[0];
    if (!predicted) throw new Error(`${name}: scale prediction rejected`);
    const measured = Math.sqrt(runtimeBox.width / authorBox.width * runtimeBox.height / authorBox.height);
    const relativeError = Math.abs(predicted - measured) / measured;
    const matchResult = await session.testImagePreview(assetName, .1, [predicted], 'none');
    const top = matchResult.bitmapMatch;
    const best = top ? iou(top, runtimeBox) : 0;
    console.log(`[scale-reference] ${name} predicted=${predicted.toFixed(4)} measured=${measured.toFixed(4)} error=${(relativeError * 100).toFixed(2)}% iou=${best.toFixed(3)} box=${JSON.stringify(runtimeBox)} candidate=${JSON.stringify(top && { x: top.x, y: top.y, width: top.width, height: top.height, score: top.score })} revision=${revision}`);
    if (relativeError > .02 || best < .8) throw new Error(`${name}: scale validation failed`);
  }
  await session.close(); clearTimeout(watchdog); win.destroy(); app.exit(0);
}).catch((error) => { clearTimeout(watchdog); console.error('[scale-reference] FAIL:', error?.stack ?? error); app.exit(1); });
