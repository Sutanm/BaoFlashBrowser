'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { randomUUID } = require('crypto');
const { wait, waitFor, withTimeout } = require('../../lib/timeout.cjs');

const [workerExe, plugin, controlPath, gamePath, profile, output, modules] = process.argv.slice(2);
app.setPath('userData', fs.mkdtempSync(path.join(profile, 'shell-')));
const koffi = require(path.join(modules, 'koffi'));
const kernel = koffi.load('kernel32.dll');
const open = kernel.func('void* OpenFileMappingW(uint32_t, int, str16)');
const map = kernel.func('void* MapViewOfFile(void*, uint32_t, uint32_t, uint32_t, size_t)');
const unmap = kernel.func('int UnmapViewOfFile(void*)');
const close = kernel.func('int CloseHandle(void*)');

const headerBytes = 4;
const gameSampleMs = Math.min(25_000, Math.max(1000, Number(process.env.BAO_CEF_FRAME_SAMPLE_MS) || 6000));
const pollOnly = process.env.BAO_CEF_FRAME_POLL_ONLY === '1';
const notify = !pollOnly && process.env.BAO_CEF_FRAME_NOTIFY !== '0';
const report = { electron: process.versions.electron, chrome: process.versions.chrome,
  frameScheduling: notify ? 'notify-and-ack' : pollOnly ? 'poll-only' : 'poll-and-ack' };
let win;
let current;

async function openWorker(label, url, exercise) {
  const dir = path.join(output, label);
  fs.mkdirSync(dir);
  const userData = fs.mkdtempSync(path.join(profile, 'worker-'));
  const name = 'Local\\BaoCefLive-' + randomUUID();
  const isGame = label === 'game';
  const [width, height] = isGame ? [640, 480] : [550, 420];
  const frameBytes = width * height * 4;
  const child = spawn(workerExe, [plugin, url, userData, dir, isGame ? 'live-game' : 'live', name], {
    windowsHide: true, stdio: ['pipe', notify ? 'pipe' : 'ignore', 'ignore'],
  });
  const exited = new Promise((resolve) => {
    child.once('exit', (code) => resolve({ code }));
    child.once('error', (error) => resolve({ error: error.message }));
  });
  child.stdin.on('error', () => {});
  const sink = { child, samples: [], inFlight: false };
  child.stdout?.on('data', () => sink.pump?.());
  let handle;
  let pointer;
  let timer;
  try {
    handle = await Promise.race([
      waitFor(() => open(4, 0, name), { timeoutMs: 9000, intervalMs: 10, label: label + ' mapping' }),
      exited.then((result) => { throw new Error(label + ' worker exited: ' + JSON.stringify(result)); }),
    ]);
    pointer = map(handle, 4, 0, 0, frameBytes + headerBytes);
    assert(pointer, 'MapViewOfFile failed');
    current = sink;
    let last = 0;
    sink.pump = () => {
      if (sink.inFlight || win.isDestroyed()) return;
      const sequence = koffi.decode(pointer, 'uint32_t');
      if (sequence === last || (sequence & 1)) return;
      const readStart = performance.now();
      const pixels = koffi.decode(pointer + BigInt(headerBytes), 'uint8_t', frameBytes);
      if (sequence !== koffi.decode(pointer, 'uint32_t')) return;
      last = sequence;
      const sendStart = performance.now();
      sink.inFlight = { sequence, sendStart, readMs: sendStart - readStart };
      win.webContents.send('cef-live-frame', sequence, width, height, pixels);
      sink.inFlight.sendMs = performance.now() - sendStart;
    };
    if (notify) sink.pump();
    else timer = setInterval(sink.pump, 3);
    await waitFor(() => sink.samples.length, { timeoutMs: 9000, label: label + ' first frame' });
    report[label] = await exercise(sink.samples, dir);
  } catch (error) {
    report[label] = { error: error.message };
  } finally {
    clearInterval(timer);
    current = null;
    sink.pump = null;
    if (pointer) unmap(pointer);
    if (handle) close(handle);
    child.stdin.end('quit\n');
    const outcome = await withTimeout(exited, 5000, label + ' worker close').catch(() => {
      child.kill();
      return { error: 'worker shutdown timed out' };
    });
    report[label].workerExit = outcome;
    const workerReport = path.join(dir, 'worker.json');
    if (fs.existsSync(workerReport)) report[label].worker = JSON.parse(fs.readFileSync(workerReport, 'utf8'));
  }
}

function cdp(method, params) {
  return win.webContents.debugger.sendCommand('Input.' + method, params);
}

async function mouse(type, x, y) {
  const options = { type, x, y: y + 64 };
  if (type !== 'mouseMoved') Object.assign(options, { button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  await cdp('dispatchMouseEvent', options);
}

async function key(type, code, keyValue, virtualCode) {
  await cdp('dispatchKeyEvent', { type, code, key: keyValue, windowsVirtualKeyCode: virtualCode });
}

async function screenshot(dir, name) {
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(dir, name + '.png'), image.toPNG());
}

async function composeChinese() {
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('textarea');
    input.value = '';
    input.focus();
  })()`);
  const text = '\u4e2d\u6587';
  await cdp('imeSetComposition', { text, selectionStart: 2, selectionEnd: 2 });
  await wait(180);
  await cdp('insertText', { text });
  await wait(450);
}
async function control(samples, dir) {
  const hover = 10092288;
  const pressed = 16711833;
  await wait(1200);
  await mouse('mouseMoved', 250, 210);
  const waitColor = (color) => waitFor(() => samples.at(-1)?.color === color && samples.at(-1), {
    timeoutMs: 1500, intervalMs: 5, label: 'PPAPI button color ' + color,
  });
  await waitColor(hover);
  const latencyMs = [];
  for (let i = 0; i < 10; i++) {
    const start = performance.now();
    await mouse('mousePressed', 250, 210);
    const drawn = await waitColor(pressed);
    latencyMs.push(Math.round(drawn.time - start));
    if (i === 0) await screenshot(dir, 'button-pressed');
    await mouse('mouseReleased', 250, 210);
    await waitColor(hover);
  }
  await mouse('mousePressed', 85, 400);
  await mouse('mouseReleased', 85, 400);
  await composeChinese();
  await screenshot(dir, 'html-ime');
  await mouse('mousePressed', 52, 348);
  await mouse('mouseReleased', 52, 348);
  await screenshot(dir, 'flash-ime-before');
  await composeChinese();
  // Blur the old document's SWF to distinguish committed glyphs from preedit.
  await mouse('mousePressed', 525, 400);
  await mouse('mouseReleased', 525, 400);
  await wait(200);
  await screenshot(dir, 'flash-ime-after');
  return { latencyMs };
}

function summarizeFrames(frames) {
  const stats = {};
  for (const field of ['readMs', 'sendMs', 'roundTripMs', 'convertMs', 'drawMs', 'rendererMs']) {
    const values = frames.map((frame) => frame[field]).sort((a, b) => a - b);
    if (!values.length) continue;
    const at = (p) => Math.round(values[Math.ceil(values.length * p) - 1] * 100) / 100;
    stats[field] = { median: at(0.5), p95: at(0.95) };
  }
  return stats;
}

async function game(samples, dir) {
  await waitFor(() => samples.at(-1)?.shipX != null, { timeoutMs: 6000, label: 'visible player ship' });
  await mouse('mouseMoved', 275, 210);
  await mouse('mousePressed', 275, 210);
  await mouse('mouseReleased', 275, 210);
  await wait(250);
  const before = samples.at(-1).shipX;
  await screenshot(dir, 'before-right');
  const start = performance.now();
  await key('rawKeyDown', 'ArrowRight', 'ArrowRight', 39);
  const moved = await waitFor(() => samples.find((frame) => frame.time >= start && frame.shipX > before + 8), {
    timeoutMs: 1500, intervalMs: 5, label: 'right arrow moved the PPAPI ship',
  });
  await wait(300);
  await key('keyUp', 'ArrowRight', 'ArrowRight', 39);
  await wait(150);
  const after = samples.at(-1).shipX;
  await screenshot(dir, 'after-right');
  await key('rawKeyDown', 'Space', ' ', 32);
  await wait(150);
  await key('keyUp', 'Space', ' ', 32);
  const measureStart = performance.now();
  await wait(gameSampleMs);
  const duration = (performance.now() - measureStart) / 1000;
  const drawn = samples.filter((frame) => frame.time >= measureStart);
  await screenshot(dir, 'gameplay-end');
  return {
    shipBeforeX: before,
    shipAfterX: after,
    shipResponseMs: Math.round(moved.time - start),
    durationSeconds: Math.round(duration * 100) / 100,
    drawn: drawn.length,
    drawnFps: Math.round(drawn.length / duration * 10) / 10,
    published: drawn.length > 1 ? (drawn.at(-1).sequence - drawn[0].sequence) / 2 + 1 : drawn.length,
    distinctFrames: new Set(drawn.map((frame) => frame.hash)).size,
    stages: summarizeFrames(drawn),
  };
}

async function main() {
  await app.whenReady();
  win = new BrowserWindow({
    width: 660, height: 565, useContentSize: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'live-preload.cjs'), backgroundThrottling: false },
  });
  ipcMain.on('cef-live-input', (event, kind, type, ...args) => {
    if (!current || event.sender !== win.webContents) return;
    if (kind === 'ime') (report.imeEvents ||= []).push({ type, units: args.length });
    current.child.stdin.write([kind, type, ...args].join(' ') + '\n');
  });
  ipcMain.on('cef-live-drawn', (event, sequence, color, hash, shipX, timing) => {
    if (!current || event.sender !== win.webContents || current.inFlight?.sequence !== sequence) return;
    const { readMs, sendMs, sendStart } = current.inFlight;
    const time = performance.now();
    current.samples.push({ sequence, color, hash, shipX, time, ...timing,
      readMs, sendMs, roundTripMs: time - sendStart });
    current.inFlight = false;
    if (!pollOnly) current.pump();
  });
  await win.loadFile(path.join(__dirname, 'live-shell.html'));
  win.show();
  win.webContents.debugger.attach('1.3');
  try {
    await openWorker('control', pathToFileURL(controlPath).href, control);
    await openWorker('game', pathToFileURL(gamePath).href, game);
  } finally {
    win.webContents.debugger.detach();
  }
}

main().catch((error) => { report.error = error.message; }).finally(() => {
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  app.exit();
});
