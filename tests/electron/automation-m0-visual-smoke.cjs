/**
 * Automation M0 visual loop probe:
 * capture template -> move target -> minimize -> capture -> OpenCV locate ->
 * convert device pixels to CSS pixels -> transient CDP click -> verify.
 */
const { app, BrowserView, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'WinUseBrowserSpellChecker');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURE = path.join(ROOT, 'tools', 'automation-probe', 'fixtures', 'input-target.html');
const OUTPUT_DIR = path.join(ROOT, 'release', 'automation-probe');
const VIEWPORT = { width: 900, height: 560 };
const timeout = setTimeout(() => {
  console.error('[automation-m0-visual] FAIL: timed out');
  app.exit(1);
}, Number(process.env.SMOKE_TIMEOUT || 60000));

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function assert(condition, message) { if (!condition) throw new Error(message); }

function loadOpenCv() {
  return new Promise((resolve, reject) => {
    try {
      const cv = require('@techstark/opencv-js');
      cv.then(() => resolve({ cv }));
    } catch (error) {
      reject(error);
    }
  });
}

async function capture(wc) {
  wc.incrementCapturerCount();
  try {
    const image = await wc.capturePage();
    assert(!image.isEmpty(), 'capture returned empty image');
    return image;
  } finally {
    wc.decrementCapturerCount();
  }
}

function cssRectToPixels(rect, imageSize) {
  const scaleX = imageSize.width / VIEWPORT.width;
  const scaleY = imageSize.height / VIEWPORT.height;
  return {
    x: Math.round(rect.x * scaleX),
    y: Math.round(rect.y * scaleY),
    width: Math.round(rect.width * scaleX),
    height: Math.round(rect.height * scaleY),
  };
}

function locateTemplate(cv, sceneImage, templateImage) {
  const sceneSize = sceneImage.getSize();
  const templateSize = templateImage.getSize();
  const scene = cv.matFromArray(sceneSize.height, sceneSize.width, cv.CV_8UC4, sceneImage.toBitmap());
  const template = cv.matFromArray(templateSize.height, templateSize.width, cv.CV_8UC4, templateImage.toBitmap());
  const sceneGray = new cv.Mat();
  const templateGray = new cv.Mat();
  const result = new cv.Mat();
  try {
    cv.cvtColor(scene, sceneGray, cv.COLOR_BGRA2GRAY);
    cv.cvtColor(template, templateGray, cv.COLOR_BGRA2GRAY);
    cv.matchTemplate(sceneGray, templateGray, result, cv.TM_CCOEFF_NORMED);
    const match = cv.minMaxLoc(result);
    return {
      score: match.maxVal,
      x: match.maxLoc.x,
      y: match.maxLoc.y,
      width: templateSize.width,
      height: templateSize.height,
    };
  } finally {
    scene.delete();
    template.delete();
    sceneGray.delete();
    templateGray.delete();
    result.delete();
  }
}

async function cdpClick(wc, point) {
  wc.debugger.attach('1.3');
  try {
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1,
    });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1,
    });
  } finally {
    if (wc.debugger.isAttached()) wc.debugger.detach();
  }
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const win = new BrowserWindow({
    show: true, width: 960, height: 640,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  const view = new BrowserView({
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, plugins: false,
      partition: 'persist:automation-m0-visual', backgroundThrottling: false,
    },
  });
  win.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, ...VIEWPORT });
  const wc = view.webContents;
  const fixtureUrl = pathToFileURL(FIXTURE).href;

  await wc.loadURL(`${fixtureUrl}?x=420&y=245`);
  await delay(200);
  const baselineState = await wc.executeJavaScript('window.__automationProbe.snapshot()');
  const baseline = await capture(wc);
  const templateRect = cssRectToPixels(baselineState.targetRect, baseline.getSize());
  const template = baseline.crop(templateRect);
  fs.writeFileSync(path.join(OUTPUT_DIR, 'visual-template.png'), template.toPNG());

  await wc.loadURL(`${fixtureUrl}?x=105&y=365`);
  await delay(200);
  win.minimize();
  await delay(600);
  assert(win.isMinimized(), 'window is not minimized');
  const scene = await capture(wc);
  fs.writeFileSync(path.join(OUTPUT_DIR, '04-visual-scene-before-click.png'), scene.toPNG());

  const { cv } = await loadOpenCv();
  const startedAt = Date.now();
  const match = locateTemplate(cv, scene, template);
  const matchMs = Date.now() - startedAt;
  assert(match.score >= 0.90, `template score too low: ${match.score}`);

  const sceneSize = scene.getSize();
  const point = {
    x: Math.round((match.x + match.width / 2) * VIEWPORT.width / sceneSize.width),
    y: Math.round((match.y + match.height / 2) * VIEWPORT.height / sceneSize.height),
  };
  await cdpClick(wc, point);
  await delay(150);
  const after = await wc.executeJavaScript('window.__automationProbe.snapshot()');
  assert(after.clicks === 1, `visually located click missed target: ${JSON.stringify({ match, point, after })}`);
  assert(after.targetTrusted === 'true', 'visually located CDP click was not trusted');
  const afterImage = await capture(wc);
  fs.writeFileSync(path.join(OUTPUT_DIR, '05-visual-scene-after-click.png'), afterImage.toPNG());

  const expectedPixelRect = cssRectToPixels(after.targetRect, sceneSize);
  const error = {
    x: Math.abs(match.x - expectedPixelRect.x),
    y: Math.abs(match.y - expectedPixelRect.y),
  };
  const result = {
    opencv: require('@techstark/opencv-js/package.json').version,
    scene: sceneSize,
    template: template.getSize(),
    score: match.score,
    matchMs,
    locatedPixel: { x: match.x, y: match.y },
    expectedPixel: { x: expectedPixelRect.x, y: expectedPixelRect.y },
    pixelError: error,
    dispatchedCssPoint: point,
    minimized: win.isMinimized(),
    clicked: after.clicks === 1,
    trusted: after.targetTrusted,
    debuggerDetached: !wc.debugger.isAttached(),
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'visual-result.json'), JSON.stringify(result, null, 2));
  console.log('[automation-m0-visual] PASS', JSON.stringify(result));
  clearTimeout(timeout);
  win.destroy();
  app.exit(0);
}).catch((error) => {
  clearTimeout(timeout);
  console.error('[automation-m0-visual] FAIL:', error && error.stack ? error.stack : error);
  app.exit(1);
});
