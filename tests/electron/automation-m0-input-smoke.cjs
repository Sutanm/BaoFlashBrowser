/**
 * Automation M0 input probe.
 *
 * Verifies independently:
 *  - focused sendInputEvent baseline;
 *  - minimized capture using the production capturer pattern;
 *  - transient CDP mouse/keyboard input while minimized;
 *  - debugger detaches and navigation still works afterwards.
 */
const { app, BrowserView, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'WinUseBrowserSpellChecker');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURE = path.join(ROOT, 'tools', 'automation-probe', 'fixtures', 'input-target.html');
const OUTPUT_DIR = path.join(ROOT, 'release', 'automation-probe');
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT || 45000);
const watchdog = setTimeout(() => fail(new Error(`timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);

let finished = false;
let win = null;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fail(error) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  console.error('[automation-m0-input] FAIL:', error && error.stack ? error.stack : error);
  try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* best effort */ }
  app.exit(1);
}

async function state(wc) {
  return wc.executeJavaScript('window.__automationProbe.snapshot()');
}

async function capture(wc, name) {
  wc.incrementCapturerCount();
  try {
    const image = await wc.capturePage();
    assert(!image.isEmpty(), `${name}: capture is empty`);
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUTPUT_DIR, `${name}.png`), image.toPNG());
    return image.getSize();
  } finally {
    wc.decrementCapturerCount();
  }
}

function center(rect) {
  return {
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
  };
}

function sendMouseWithElectron(wc, point) {
  wc.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
  wc.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function withTransientDebugger(wc, operation) {
  assert(!wc.debugger.isAttached(), 'debugger was already attached before automation action');
  wc.debugger.attach('1.3');
  try {
    return await operation(wc.debugger);
  } finally {
    if (wc.debugger.isAttached()) wc.debugger.detach();
  }
}

async function sendMouseWithCdp(wc, point) {
  await withTransientDebugger(wc, async (debuggerApi) => {
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1,
    });
    await debuggerApi.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1,
    });
  });
}

async function sendKeyWithCdp(wc, key, code, windowsVirtualKeyCode) {
  await withTransientDebugger(wc, async (debuggerApi) => {
    await debuggerApi.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown', key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode,
    });
    await debuggerApi.sendCommand('Input.dispatchKeyEvent', {
      type: 'char', text: key, unmodifiedText: key, key, code,
      windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode,
    });
    await debuggerApi.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp', key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode,
    });
  });
}

app.whenReady().then(async () => {
  assert(fs.existsSync(FIXTURE), `fixture not found: ${FIXTURE}`);

  win = new BrowserWindow({
    show: true,
    width: 960,
    height: 640,
    backgroundColor: '#dbeafe',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  const view = new BrowserView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      plugins: false,
      partition: 'persist:automation-m0-input',
      backgroundThrottling: false,
    },
  });
  win.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, width: 900, height: 560 });
  const wc = view.webContents;

  await wc.loadFile(FIXTURE);
  await delay(250);
  win.focus();
  wc.focus();

  const initial = await state(wc);
  const targetPoint = center(initial.targetRect);
  sendMouseWithElectron(wc, targetPoint);
  await delay(150);
  const foreground = await state(wc);
  assert(foreground.clicks === 1, `focused sendInputEvent did not click target: ${JSON.stringify(foreground)}`);
  assert(foreground.targetTrusted === 'true', 'focused Electron input was not trusted');
  await capture(wc, '01-foreground-electron-click');

  win.minimize();
  await delay(600);
  assert(win.isMinimized(), 'window did not enter minimized state');
  const minimizedBefore = await state(wc);
  assert(minimizedBefore.visibilityState === 'hidden', `expected hidden visibility, got ${minimizedBefore.visibilityState}`);
  const minimizedSize = await capture(wc, '02-minimized-before-cdp');
  assert(minimizedSize.width >= 899 && minimizedSize.height >= 559,
    `minimized capture has unexpected size ${minimizedSize.width}x${minimizedSize.height}`);

  await sendMouseWithCdp(wc, targetPoint);
  await delay(150);
  const minimizedAfterClick = await state(wc);
  assert(minimizedAfterClick.clicks === 2,
    `transient CDP did not click while minimized: ${JSON.stringify(minimizedAfterClick)}`);
  assert(minimizedAfterClick.targetTrusted === 'true', 'CDP mouse input was not trusted');
  assert(!wc.debugger.isAttached(), 'debugger remained attached after mouse action');

  const keyPoint = center(minimizedAfterClick.keyRect);
  await sendMouseWithCdp(wc, keyPoint);
  await sendKeyWithCdp(wc, 'a', 'KeyA', 65);
  await delay(150);
  const minimizedAfterKey = await state(wc);
  assert(minimizedAfterKey.keys === 'a',
    `transient CDP key input failed while minimized: ${JSON.stringify(minimizedAfterKey)}`);
  assert(minimizedAfterKey.keyTrusted === 'true', 'CDP keyboard input was not trusted');
  assert(!wc.debugger.isAttached(), 'debugger remained attached after keyboard action');
  await capture(wc, '03-minimized-after-cdp');

  await wc.loadURL('data:text/html,<title>navigation-ok</title><main id="ok">navigation-ok</main>');
  const marker = await wc.executeJavaScript('document.querySelector("#ok").textContent');
  assert(marker === 'navigation-ok', 'navigation failed after transient debugger actions');

  const result = {
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    minimizedCapture: `${minimizedSize.width}x${minimizedSize.height}`,
    foregroundElectronClick: foreground.clicks === 1,
    minimizedCdpClick: minimizedAfterClick.clicks === 2,
    minimizedCdpKeyboard: minimizedAfterKey.keys === 'a',
    trustedMouse: minimizedAfterClick.targetTrusted,
    trustedKeyboard: minimizedAfterKey.keyTrusted,
    debuggerDetached: !wc.debugger.isAttached(),
    navigationAfterDetach: marker === 'navigation-ok',
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'input-result.json'), JSON.stringify(result, null, 2));
  console.log('[automation-m0-input] PASS', JSON.stringify(result));

  finished = true;
  clearTimeout(watchdog);
  win.destroy();
  app.exit(0);
}).catch(fail);
