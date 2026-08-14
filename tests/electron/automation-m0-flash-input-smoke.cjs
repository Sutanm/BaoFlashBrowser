/**
 * Automation M0 cross-engine input probe.
 * Runs the same upstream Ruffle button SWF in native PPAPI and bundled Ruffle,
 * minimizes the host, then uses transient CDP mouse input and pixel evidence.
 */
const { app, BrowserView, BrowserWindow, protocol, session } = require('electron');
const fs = require('fs');
const path = require('path');

protocol.registerSchemesAsPrivileged([{
  scheme: 'ruffle-resource',
  privileges: { secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);
// The probe destroys each host before creating the next one.
app.on('window-all-closed', () => {});

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'WinUseBrowserSpellChecker');
app.commandLine.appendSwitch('ignore-gpu-blacklist');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const ROOT = path.join(__dirname, '..', '..');
const OUTPUT_DIR = path.join(ROOT, 'release', 'automation-probe');
const RESOURCE_DIR = path.join(ROOT, 'dist', 'lib', 'ruffle');
const BASE64_FILE = path.join(ROOT, 'tools', 'automation-probe', 'fixtures', 'ruffle-button1.swf.base64');
const TEMP_SWF = path.join(OUTPUT_DIR, 'ruffle-button1.swf');
const VIEWPORT = { width: 550, height: 420 };
const SWF_TARGET = { x: 250, y: 200 };
const timeout = setTimeout(() => fail(new Error('timed out')), Number(process.env.SMOKE_TIMEOUT || 90000));
let currentWindow = null;
let finished = false;

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function assert(condition, message) { if (!condition) throw new Error(message); }

function fail(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  console.error('[automation-m0-flash] FAIL:', error && error.stack ? error.stack : error);
  try { if (currentWindow && !currentWindow.isDestroyed()) currentWindow.destroy(); } catch { /* best effort */ }
  app.exit(1);
}

function configureFlash() {
  let pluginPath;
  if (process.platform === 'win32' && process.arch === 'ia32') {
    pluginPath = path.join(ROOT, 'plugins', 'win32', 'pepflashplayer.dll');
  } else if (process.platform === 'win32') {
    pluginPath = path.join(ROOT, 'plugins', 'win64', 'pepflashplayer64.dll');
  } else {
    pluginPath = path.join(ROOT, 'plugins', 'linux64', 'libpepflashplayer64.so');
  }
  assert(fs.existsSync(pluginPath), `Flash plugin missing: ${pluginPath}`);
  app.commandLine.appendSwitch('ppapi-flash-path', pluginPath);
  app.commandLine.appendSwitch('ppapi-flash-version', process.platform === 'win32' ? '34.0.0.330' : '32.0.0.371');
}

function registerRuffleResources(targetSession) {
  return new Promise((resolve, reject) => {
    const ok = targetSession.protocol.registerBufferProtocol('ruffle-resource', (request, callback) => {
      const url = new URL(request.url);
      const fileName = decodeURIComponent(url.hostname || url.pathname.replace(/^\/+/, ''));
      if (!/^[a-zA-Z0-9._-]+$/.test(fileName)) return callback({ error: -10 });
      fs.readFile(path.join(RESOURCE_DIR, fileName), (error, data) => {
        if (error) return callback({ error: -6 });
        callback({
          mimeType: fileName.endsWith('.wasm') ? 'application/wasm'
            : fileName.endsWith('.js') ? 'application/javascript' : 'application/octet-stream',
          data,
          headers: { 'Access-Control-Allow-Origin': '*' },
        });
      });
    }, (error) => error ? reject(error) : resolve());
    if (!ok) reject(new Error('failed to register ruffle-resource protocol'));
  });
}

async function capture(wc, name) {
  wc.incrementCapturerCount();
  try {
    const image = await wc.capturePage();
    assert(!image.isEmpty(), `${name}: empty capture`);
    fs.writeFileSync(path.join(OUTPUT_DIR, `${name}.png`), image.toPNG());
    return image;
  } finally {
    wc.decrementCapturerCount();
  }
}

function changedPixelRatio(before, after) {
  const a = before.toBitmap();
  const b = after.toBitmap();
  assert(a.length === b.length, `image sizes differ: ${a.length}/${b.length}`);
  let pixels = 0;
  let changed = 0;
  for (let i = 0; i < a.length; i += 4) {
    pixels += 1;
    const delta = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (delta >= 24) changed += 1;
  }
  return changed / pixels;
}

function brightPixelRatio(image) {
  const bitmap = image.toBitmap();
  let bright = 0;
  for (let i = 0; i < bitmap.length; i += 4) {
    if (bitmap[i] + bitmap[i + 1] + bitmap[i + 2] >= 240) bright += 1;
  }
  return bright / (bitmap.length / 4);
}

async function cdpMouse(wc, type, point) {
  wc.debugger.attach('1.3');
  try {
    const payload = { type, x: point.x, y: point.y };
    if (type === 'mousePressed' || type === 'mouseReleased') {
      payload.button = 'left';
      payload.clickCount = 1;
    }
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', payload);
  } finally {
    if (wc.debugger.isAttached()) wc.debugger.detach();
  }
}

function createHost(partition, plugins, contextIsolation) {
  const win = new BrowserWindow({
    show: true, width: 620, height: 500, backgroundColor: '#ffffff',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  const view = new BrowserView({
    webPreferences: {
      nodeIntegration: false, contextIsolation, plugins, partition,
      backgroundThrottling: false,
    },
  });
  win.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, ...VIEWPORT });
  currentWindow = win;
  return { win, view, wc: view.webContents };
}

async function runPpapi(stageSize) {
  // Match the production PPAPI tab session and isolation settings. Run this host
  // before any plugins:false renderer is created in the process.
  const { win, view, wc } = createHost('persist:automation-m0-ppapi', true, false);
  wc.on('dom-ready', () => {
    void wc.insertCSS('html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}' +
      'embed,object{width:100%!important;height:100%!important}');
  });
  await wc.loadURL('file:///' + TEMP_SWF.replace(/\\/g, '/'));
  await delay(1200);
  const embed = await wc.executeJavaScript(`(() => {
    const element = document.querySelector('embed,object');
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return {
      x: rect.x, y: rect.y, width: rect.width, height: rect.height, tag: element.tagName,
      plugins: Array.from(navigator.plugins || []).map(plugin => ({ name: plugin.name, filename: plugin.filename })),
    };
  })()`);
  assert(embed && embed.width > 0 && embed.height > 0, `PPAPI embed missing: ${JSON.stringify(embed)}`);
  const point = {
    x: Math.round(embed.x + SWF_TARGET.x / stageSize.width * embed.width),
    y: Math.round(embed.y + SWF_TARGET.y / stageSize.height * embed.height),
  };
  win.minimize();
  await delay(600);
  const before = await capture(wc, '06-ppapi-before-input');
  await cdpMouse(wc, 'mouseMoved', point);
  await delay(120);
  const hovered = await capture(wc, '07-ppapi-hovered');
  await cdpMouse(wc, 'mousePressed', point);
  await delay(120);
  const pressed = await capture(wc, '08-ppapi-pressed');
  await cdpMouse(wc, 'mouseReleased', point);
  await delay(180);
  const released = await capture(wc, '09-ppapi-released');
  const result = {
    minimized: win.isMinimized(), point, embed,
    registered: embed.plugins.some((plugin) => /shockwave flash/i.test(plugin.name)),
    rendered: brightPixelRatio(before) > 0.1,
    hoverChanged: changedPixelRatio(before, hovered),
    pressChanged: changedPixelRatio(hovered, pressed),
    releaseChanged: changedPixelRatio(pressed, released),
    debuggerDetached: !wc.debugger.isAttached(),
  };
  win.destroy();
  currentWindow = null;
  return result;
}

async function runRuffle(swfBase64) {
  const { win, wc } = createHost('persist:automation-m0-ruffle-input', false, false);
  const traceMessages = [];
  wc.on('console-message', (_event, _level, message) => traceMessages.push(message));
  await wc.loadURL('data:text/html,<html><body style="margin:0;background:white"></body></html>');
  const ruffleJs = fs.readFileSync(path.join(RESOURCE_DIR, 'ruffle.js'), 'utf8');
  const info = await wc.executeJavaScript(`(async () => {
    window.RufflePlayer = { config: { publicPath: 'ruffle-resource://', autoplay: 'on', scale: 'showAll' } };
    new Function(${JSON.stringify(ruffleJs)})();
    const source = window.RufflePlayer.newest();
    const player = source.createPlayer();
    player.style.width = '${VIEWPORT.width}px';
    player.style.height = '${VIEWPORT.height}px';
    document.body.appendChild(player);
    const bytes = Uint8Array.from(atob(${JSON.stringify(swfBase64)}), c => c.charCodeAt(0));
    await player.load({ data: bytes, autoplay: 'on' });
    await new Promise(resolve => setTimeout(resolve, 800));
    const rect = player.getBoundingClientRect();
    return {
      version: source.version,
      metadata: player.metadata,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  })()`, true);
  assert(info.metadata && info.metadata.width > 0 && info.metadata.height > 0,
    `Ruffle metadata missing: ${JSON.stringify(info)}`);
  const point = {
    x: Math.round(info.rect.x + SWF_TARGET.x / info.metadata.width * info.rect.width),
    y: Math.round(info.rect.y + SWF_TARGET.y / info.metadata.height * info.rect.height),
  };
  win.minimize();
  await delay(600);
  const before = await capture(wc, '10-ruffle-before-input');
  await cdpMouse(wc, 'mouseMoved', point);
  await delay(120);
  const hovered = await capture(wc, '11-ruffle-hovered');
  await cdpMouse(wc, 'mousePressed', point);
  await delay(120);
  const pressed = await capture(wc, '12-ruffle-pressed');
  await cdpMouse(wc, 'mouseReleased', point);
  await delay(180);
  const released = await capture(wc, '13-ruffle-released');
  const result = {
    version: info.version, metadata: info.metadata, minimized: win.isMinimized(), point,
    hoverChanged: changedPixelRatio(before, hovered),
    pressChanged: changedPixelRatio(hovered, pressed),
    releaseChanged: changedPixelRatio(pressed, released),
    traces: traceMessages.filter((message) => /roll|drag|press|release/i.test(message)),
    debuggerDetached: !wc.debugger.isAttached(),
  };
  win.destroy();
  currentWindow = null;
  return result;
}

configureFlash();
app.whenReady().then(async () => {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  assert(fs.existsSync(path.join(RESOURCE_DIR, 'ruffle.js')), 'Ruffle build resources missing; run npm run build first');
  const swfBase64 = fs.readFileSync(BASE64_FILE, 'utf8').replace(/\s/g, '');
  fs.writeFileSync(TEMP_SWF, Buffer.from(swfBase64, 'base64'));
  await registerRuffleResources(session.fromPartition('persist:automation-m0-ruffle-input'));

  // The upstream fixture metadata is 550x400. PPAPI runs first so a preceding
  // plugins:false renderer cannot influence Chromium's legacy plugin startup.
  const ppapi = await runPpapi({ width: 550, height: 400 });
  const ruffle = await runRuffle(swfBase64);
  const result = { fixture: 'ruffle-rs/ruffle from_shumway/button1', ppapi, ruffle };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'flash-input-result.json'), JSON.stringify(result, null, 2));

  const ruffleEvidence = Math.max(ruffle.hoverChanged, ruffle.pressChanged, ruffle.releaseChanged) > 0.0001 || ruffle.traces.length > 0;
  const ppapiEvidence = Math.max(ppapi.hoverChanged, ppapi.pressChanged, ppapi.releaseChanged) > 0.0001;
  assert(ruffleEvidence, `Ruffle produced no observable input evidence: ${JSON.stringify(ruffle)}`);
  if (ppapi.rendered) {
    assert(ppapiEvidence, `PPAPI produced no observable pixel response: ${JSON.stringify(ppapi)}`);
  }
  assert(ruffle.debuggerDetached && ppapi.debuggerDetached, 'debugger remained attached');

  const ppapiNote = ppapi.rendered ? 'PPAPI input verified' : 'PPAPI registered but did not render; recorded as an environment blocker';
  console.log('[automation-m0-flash] PASS:', ppapiNote, JSON.stringify(result));
  finished = true;
  clearTimeout(timeout);
  app.exit(0);
}).catch(fail);
