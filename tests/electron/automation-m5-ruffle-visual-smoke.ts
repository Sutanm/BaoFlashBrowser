import { app, BrowserView, BrowserWindow, protocol, session } from 'electron';
import fs from 'fs';
import path from 'path';
import { BrowserViewAutomationDriver, deviceMatchToCssPoint, type AutomationWebContentsLike } from '../../src/main/modules/automation/browserview-driver';
import { OpenCvWorkerMatcher, type AutomationTemplateProvider } from '../../src/main/modules/automation/vision-worker-matcher';
import { createAutomationAbortController } from '../../src/shared/automation/abort-controller';

protocol.registerSchemesAsPrivileged([{ scheme: 'ruffle-resource', privileges: { secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'WinUseBrowserSpellChecker');
app.commandLine.appendSwitch('ignore-gpu-blacklist');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const ROOT = path.join(__dirname, '..', '..');
const RESOURCE_DIR = path.join(ROOT, 'dist', 'lib', 'ruffle');
const BASE64_FILE = path.join(ROOT, 'tools', 'automation-probe', 'fixtures', 'ruffle-button1.swf.base64');
const OUTPUT_DIR = path.join(ROOT, 'release', 'automation-probe');
const VIEWPORT = { width: 550, height: 420 };
const timeout = setTimeout(() => { console.error('[automation-m5-ruffle] FAIL: timed out'); app.exit(1); }, 60_000);

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

function registerResources(): Promise<void> {
  const target = session.fromPartition('persist:automation-m5-ruffle');
  return new Promise((resolve, reject) => {
    const registered = target.protocol.registerBufferProtocol('ruffle-resource', (request, callback) => {
      const url = new URL(request.url);
      const fileName = decodeURIComponent(url.hostname || url.pathname.replace(/^\/+/, ''));
      if (!/^[a-zA-Z0-9._-]+$/.test(fileName)) return callback({ error: -10 });
      fs.readFile(path.join(RESOURCE_DIR, fileName), (error, data) => error ? callback({ error: -6 }) : callback({
        mimeType: fileName.endsWith('.wasm') ? 'application/wasm' : fileName.endsWith('.js') ? 'application/javascript' : 'application/octet-stream',
        data, headers: { 'Access-Control-Allow-Origin': '*' },
      }));
    }, (error) => error ? reject(error) : resolve());
    if (!registered) reject(new Error('failed to register ruffle-resource protocol'));
  });
}

function coloredBounds(image: Electron.NativeImage): { x: number; y: number; width: number; height: number } {
  const size = image.getSize(); const pixels = image.toBitmap();
  let left = size.width; let top = size.height; let right = -1; let bottom = -1;
  for (let y = 0; y < size.height; y += 1) for (let x = 0; x < size.width; x += 1) {
    const offset = (y * size.width + x) * 4;
    const blue = pixels[offset]; const green = pixels[offset + 1]; const red = pixels[offset + 2];
    if (Math.max(blue, green, red) - Math.min(blue, green, red) < 45) continue;
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  if (right < left || bottom < top) throw new Error('Ruffle fixture has no coloured target');
  const margin = 8;
  const x = Math.max(0, left - margin); const y = Math.max(0, top - margin);
  return { x, y, width: Math.min(size.width - x, right - left + 1 + margin * 2), height: Math.min(size.height - y, bottom - top + 1 + margin * 2) };
}

function changedPixelRatio(before: Electron.NativeImage, after: Electron.NativeImage): number {
  const left = before.toBitmap(); const right = after.toBitmap(); let changed = 0;
  if (left.byteLength !== right.byteLength) throw new Error('Ruffle captures changed size');
  for (let index = 0; index < left.byteLength; index += 4) {
    if (Math.abs(left[index] - right[index]) + Math.abs(left[index + 1] - right[index + 1]) + Math.abs(left[index + 2] - right[index + 2]) >= 24) changed += 1;
  }
  return changed / (left.byteLength / 4);
}

async function capture(wc: Electron.WebContents): Promise<Electron.NativeImage> {
  wc.incrementCapturerCount();
  try { return await wc.capturePage(); } finally { wc.decrementCapturerCount(); }
}

app.whenReady().then(async () => {
  await registerResources(); fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const win = new BrowserWindow({ show: true, width: 620, height: 500, webPreferences: { nodeIntegration: false, contextIsolation: true } });
  const view = new BrowserView({ webPreferences: { nodeIntegration: false, contextIsolation: false, plugins: false, partition: 'persist:automation-m5-ruffle', backgroundThrottling: false } });
  win.addBrowserView(view); view.setBounds({ x: 0, y: 0, ...VIEWPORT });
  const wc = view.webContents;
  await wc.loadURL('data:text/html,<html><body style="margin:0;background:white"></body></html>');
  const ruffleJs = fs.readFileSync(path.join(RESOURCE_DIR, 'ruffle.js'), 'utf8');
  const swfBase64 = fs.readFileSync(BASE64_FILE, 'utf8').replace(/\s/g, '');
  const info = await wc.executeJavaScript(`(async () => {
    window.RufflePlayer = { config: { publicPath: 'ruffle-resource://', autoplay: 'on', scale: 'showAll' } };
    new Function(${JSON.stringify(ruffleJs)})();
    const source = window.RufflePlayer.newest(); const player = source.createPlayer();
    player.style.width = '${VIEWPORT.width}px'; player.style.height = '${VIEWPORT.height}px'; document.body.appendChild(player);
    const bytes = Uint8Array.from(atob(${JSON.stringify(swfBase64)}), c => c.charCodeAt(0));
    await player.load({ data: bytes, autoplay: 'on' }); await new Promise(resolve => setTimeout(resolve, 800));
    return { version: source.version, metadata: player.metadata };
  })()`, true) as { version: string; metadata: { width: number; height: number } };
  if (!info.metadata?.width) throw new Error(`Ruffle metadata missing: ${JSON.stringify(info)}`);

  wc.debugger.attach('1.3');
  try { await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 }); }
  finally { if (wc.debugger.isAttached()) wc.debugger.detach(); }
  await delay(100);
  const before = await capture(wc);
  // Production v2 assets are saved at one bitmap pixel per logical viewport
  // pixel. Mirror that format here instead of feeding a device-DPI crop back
  // into a driver that intentionally scales canonical assets for capture DPI.
  const canonicalBefore = before.resize(VIEWPORT);
  const bounds = coloredBounds(canonicalBefore); const template = canonicalBefore.crop(bounds); const templateSize = template.getSize();
  const templates: AutomationTemplateProvider = { async load() { return { cacheKey: 'm5-ruffle-button@1', width: templateSize.width, height: templateSize.height, bgra: Uint8Array.from(template.toBitmap()) }; } };
  const matcher = new OpenCvWorkerMatcher(templates, { workerPath: path.join(__dirname, 'vision-worker.cjs'), requestTimeoutMs: 20_000 });
  const driver = new BrowserViewAutomationDriver(wc as unknown as AutomationWebContentsLike, matcher, { getCssViewport: () => VIEWPORT });

  win.minimize(); await delay(600);
  const signal = createAutomationAbortController().signal;
  const match = await driver.findImage({ asset: 'ruffle-button.png', threshold: .95, scales: [1], mask: 'none' }, signal);
  if (!match) throw new Error('OpenCV did not find the Ruffle target while minimized');
  await driver.moveTo(match, { x: 0, y: 0 }, signal); await delay(180);
  await driver.click(match, { button: 'left', clickCount: 1, offset: { x: 0, y: 0 } }, signal);
  const point = deviceMatchToCssPoint(match, before.getSize(), VIEWPORT);
  let moved: Electron.NativeImage; let pressed: Electron.NativeImage; let released: Electron.NativeImage;
  wc.debugger.attach('1.3');
  try {
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await delay(60); moved = await capture(wc);
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await delay(60); pressed = await capture(wc);
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    await delay(60); released = await capture(wc);
  } finally {
    if (wc.debugger.isAttached()) wc.debugger.detach();
  }
  const stateChanges = {
    hover: changedPixelRatio(before, moved),
    pressed: changedPixelRatio(before, pressed),
    released: changedPixelRatio(before, released),
  };
  const interactionChanged = Math.max(stateChanges.hover, stateChanges.pressed, stateChanges.released);
  if (interactionChanged <= .001) throw new Error(`Ruffle produced no input-state evidence: ${JSON.stringify(stateChanges)}`);
  if (wc.debugger.isAttached()) throw new Error('debugger remained attached after Ruffle automation');
  const evidence = stateChanges.pressed === interactionChanged ? pressed : stateChanges.hover === interactionChanged ? moved : released;
  fs.writeFileSync(path.join(OUTPUT_DIR, 'm5-ruffle-visual.png'), evidence.toPNG());
  const result = { engine: 'ruffle', contextIsolation: false, plugins: false, minimized: win.isMinimized(), version: info.version, match: { score: match.score, x: match.x, y: match.y, width: match.width, height: match.height, matchMs: match.matchMs }, clicked: true, stateChanges, interactionChanged, debuggerDetached: !wc.debugger.isAttached() };
  fs.writeFileSync(path.join(OUTPUT_DIR, 'm5-ruffle-result.json'), JSON.stringify(result, null, 2));
  console.log('[automation-m5-ruffle] PASS', JSON.stringify(result));
  await matcher.close(); clearTimeout(timeout); win.destroy(); app.exit(0);
}).catch((error) => { clearTimeout(timeout); console.error('[automation-m5-ruffle] FAIL:', error instanceof Error ? error.stack : String(error)); app.exit(1); });
