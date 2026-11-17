'use strict';

const { app, BrowserWindow, nativeImage } = require('electron');
const assert = require('assert/strict');
const { spawn } = require('child_process');
const { once } = require('events');
const fs = require('fs');
const net = require('net');
const { randomUUID } = require('crypto');
const path = require('path');
const readline = require('readline');
const { wait, waitFor, withTimeout } = require('../lib/timeout.cjs');

const [legacy, modules, profile, output] = process.argv.slice(2);
app.setPath('userData', fs.mkdtempSync(path.join(profile, 'modern-')));
const koffi = require(path.join(modules, 'koffi'));
const user32 = koffi.load('user32.dll');
const Point = koffi.struct('POINT', { x: 'long', y: 'long' });
const lastError = koffi.load('kernel32.dll').func('uint32_t GetLastError()');
const getStyle = user32.func('intptr_t GetWindowLongPtrW(void*, int)');
const setStyle = user32.func('intptr_t SetWindowLongPtrW(void*, int, intptr_t)');
const setParent = user32.func('void* SetParent(void*, void*)');
const getParent = user32.func('void* GetParent(void*)');
const show = user32.func('bool ShowWindow(void*, int)');
const move = user32.func('bool SetWindowPos(void*, void*, int, int, int, int, uint32_t)');
const visible = user32.func('bool IsWindowVisible(void*)');
const getDpi = user32.func('uint32_t GetDpiForWindow(void*)');
const clientToScreen = user32.func('ClientToScreen', 'bool', ['void*', koffi.inout(koffi.pointer(Point))]);
const windowAt = user32.func('WindowFromPoint', 'void*', [Point]);
const isChild = user32.func('bool IsChild(void*, void*)');
const getCursor = user32.func('GetCursorPos', 'bool', [koffi.out(koffi.pointer(Point))]);
const setCursor = user32.func('bool SetCursorPos(int, int)');
const mouse = user32.func('void mouse_event(uint32_t, uint32_t, uint32_t, uint32_t, uintptr_t)');

const report = { ok: false, modern: { electron: process.versions.electron, chrome: process.versions.chrome } };
let worker;
let shell;

async function launchWorker(mode = 'native') {
  // Electron 11 on Windows closes the inherited stdin stream at startup.
  const pipe = '\\\\.\\pipe\\bao-dual-kernel-' + randomUUID();
  const server = net.createServer();
  server.listen(pipe);
  await once(server, 'listening');
  const connected = once(server, 'connection');
  const child = spawn(legacy, [
    path.join(__dirname, 'dual-kernel-flash.cjs'),
    fs.mkdtempSync(path.join(profile, 'flash-')), output, pipe, mode,
  ], { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
  const stopped = new Promise((resolve) => {
    child.once('exit', resolve);
    child.once('error', resolve);
  });
  child.stdout.on('data', (data) => { stderr = (stderr + data).slice(-4000); });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-4000); });
  let socket;
  try {
    [socket] = await withTimeout(Promise.race([
      connected,
      stopped.then(() => { throw new Error('Flash worker exited before connecting: ' + stderr); }),
    ]), 10_000, 'Flash worker connect');
  } catch (error) {
    child.kill();
    throw error;
  } finally {
    server.close();
  }
  socket.on('error', () => {});
  const lines = readline.createInterface({ input: socket })[Symbol.asyncIterator]();
  let id = 0;
  async function receive(expected) {
    const readMessage = async () => {
      for (;;) {
        const line = await lines.next();
        if (line.done || line.value.startsWith('BAO ')) return line;
      }
    };
    const { value, done } = await withTimeout(readMessage(), 10_000, 'Flash worker response');
    if (done) throw new Error('Flash worker exited: ' + stderr);
    const response = JSON.parse(value.slice(4));
    assert.equal(response.id, expected);
    if (response.error) throw new Error(response.error);
    return response.value;
  }
  return {
    child, stopped, socket, diagnostics: () => ({ exitCode: child.exitCode, signal: child.signalCode, stderr }),
    ready: () => receive(0),
    request(operation, name) {
      socket.write(JSON.stringify({ id: ++id, operation, name }) + '\n');
      return receive(id);
    },
  };
}

function pixelsChanged(before, after) {
  const bitmap = (name) => nativeImage.createFromPath(path.join(output, name + '.png')).toBitmap();
  const a = bitmap(before);
  const b = bitmap(after);
  assert(a.length > 0 && a.length === b.length);
  let changed = 0;
  for (let i = 0; i < a.length; i += 4) {
    const delta = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (delta >= 24) changed++;
  }
  return changed / (a.length / 4);
}

async function main() {
  await app.whenReady();
  shell = new BrowserWindow({ show: false, width: 740, height: 600, frame: false, backgroundColor: '#e6eff7' });
  await shell.loadURL('data:text/html,' + encodeURIComponent(`
    <title>Bao dual kernel probe</title>
    <style>body { background:#e6eff7; font:18px system-ui; }
    main:has(span) { background-color: rgb(23, 111, 55); color:white; }</style>
    <header>Modern Chromium | Native Flash</header>
    <main><span>Modern CSS :has() test</span></main>`));
  const modernCss = () => shell.webContents.executeJavaScript("getComputedStyle(document.querySelector('main')).backgroundColor");
  assert.equal(await modernCss(), 'rgb(23, 111, 55)');
  report.modernCss = true;
  shell.show();
  shell.focus();
  const parent = shell.getNativeWindowHandle().readBigUInt64LE();
  const dpi = getDpi(parent);
  report.shellVisible = visible(parent);
  const physical = (dip) => Math.round(dip * dpi / 96);
  const header = physical(60);
  let hwnd;
  function position(width = 550, height = 420) {
    assert(move(hwnd, null, 0, header, physical(width), physical(height), 0x0034), 'SetWindowPos failed');
  }
  async function attach() {
    worker = await launchWorker();
    const { hwnd: handle, versions } = await worker.ready();
    report.legacy = versions;
    hwnd = BigInt(handle);
    // SetParent leaves WS_POPUP/WS_CHILD unchanged.
    const oldStyle = BigInt.asUintN(32, BigInt(getStyle(hwnd, -16)));
    setStyle(hwnd, -16, BigInt.asIntN(32, (oldStyle & ~0x80000000n) | 0x40000000n));
    const previousParent = setParent(hwnd, parent);
    const win32Error = lastError();
    report.attach = { oldStyle: oldStyle.toString(16), style: BigInt.asUintN(32, BigInt(getStyle(hwnd, -16))).toString(16),
      previousParent: String(previousParent), win32Error, shellDpi: dpi, flashDpi: getDpi(hwnd) };
    report.attach.parent = String(getParent(hwnd));
    if (getParent(hwnd) !== parent) {
      await wait(300);
      report.attach.worker = worker.diagnostics();
      await worker.request('state');
      throw new Error('SetParent failed');
    }
    position();
    await worker.request('show');
    show(hwnd, 4);
    report.showStyle = BigInt.asUintN(32, BigInt(getStyle(hwnd, -16))).toString(16);
    await waitFor(() => visible(hwnd), { timeoutMs: 2000, label: 'Flash child visible' });
  }
  await attach();
  await wait(700);
  const initial = await worker.request('state');
  assert(initial.flash && !initial.has, JSON.stringify(initial));
  assert.equal(report.legacy.electron, '11.5.0');
  report.flashViewport = initial;
  report.dpi = { shell: dpi, flash: getDpi(hwnd) };

  const cursor = {};
  assert(getCursor(cursor), 'GetCursorPos failed');
  const target = { x: physical(250), y: physical(210) };
  assert(clientToScreen(hwnd, target), 'ClientToScreen failed');
  function assertFlashHit() {
    const hit = windowAt(target);
    assert(hit === hwnd || isChild(hwnd, hit), 'Flash is obscured at click point');
  }
  assertFlashHit();
  let pressed = false;
  try {
    await worker.request('capture', 'before');
    assert(setCursor(target.x, target.y), 'SetCursorPos failed');
    await wait(160);
    await worker.request('capture', 'hover');
    assertFlashHit();
    mouse(0x0002, 0, 0, 0, 0);
    pressed = true;
    await wait(160);
    await worker.request('capture', 'pressed');
    mouse(0x0004, 0, 0, 0, 0);
    pressed = false;
    await wait(160);
    await worker.request('capture', 'released');
  } finally {
    if (pressed) mouse(0x0004, 0, 0, 0, 0);
    setCursor(cursor.x, cursor.y);
  }
  report.hoverChanged = pixelsChanged('before', 'hover');
  report.pressChanged = pixelsChanged('hover', 'pressed');
  report.releaseChanged = pixelsChanged('pressed', 'released');
  assert(report.pressChanged > 0.01 && report.releaseChanged > 0.01, 'native click did not change PPAPI pixels');

  for (let i = 0; i < 20; i++) {
    show(hwnd, 0);
    await waitFor(() => !visible(hwnd), { timeoutMs: 1000, intervalMs: 10, label: 'Flash child hidden' });
    show(hwnd, 4);
    await waitFor(() => visible(hwnd), { timeoutMs: 1000, intervalMs: 10, label: 'Flash child restored' });
  }
  report.switches = 20;
  for (let i = 0; i < 12; i++) {
    shell.setSize(740 + i * 6, 600 + i * 4);
    position(550 + i * 6, 420 + i * 4);
    await wait(16);
  }
  await wait(250);
  report.resized = await worker.request('state');
  assert(report.resized.width > initial.width && report.resized.height > initial.height, 'Flash viewport did not resize');

  worker.child.kill();
  await withTimeout(worker.stopped, 5_000, 'Flash child exit');
  assert.equal(await modernCss(), 'rgb(23, 111, 55)');
  await attach();
  await wait(500);
  assert((await worker.request('state')).flash);
  report.restarted = true;
  report.ok = true;
}

async function tryOffscreen() {
  if (!shell || shell.isDestroyed()) return;
  await stopWorker();
  shell.focus();
  report.offscreen = {};
  try {
    worker = await launchWorker('offscreen');
    await worker.ready();
    shell.show();
    shell.focus();
    await wait(600);
    report.offscreen.flashRegistered = (await worker.request('state')).flash;
    report.offscreen.before = await worker.request('frameState');
    await worker.request('capture', 'offscreen-before');
    await worker.request('input', 'mouseMove');
    await wait(160);
    await worker.request('capture', 'offscreen-hover');
    await worker.request('input', 'mouseDown');
    await wait(160);
    await worker.request('capture', 'offscreen-pressed');
    await worker.request('input', 'mouseUp');
    await wait(160);
    await worker.request('capture', 'offscreen-released');
    report.offscreen.after = await worker.request('frameState');
    report.offscreen.shellFocusedDuringClick = shell.isFocused();
    report.offscreen.pressChanged = pixelsChanged('offscreen-hover', 'offscreen-pressed');
    report.offscreen.releaseChanged = pixelsChanged('offscreen-pressed', 'offscreen-released');
    report.offscreen.keyboard = await worker.request('keyboard');
    report.offscreen.shellFocusedAfterKeyboard = shell.isFocused();
  } catch (error) {
    report.offscreen.error = error.message;
  }
}

async function stopWorker() {
  if (!worker) return;
  const active = worker;
  worker = null;
  active.socket.end();
  await withTimeout(active.stopped, 2_000, 'Flash worker shutdown').catch(() => active.child.kill());
}

main().catch((error) => { report.ok = false; report.error = error.message; })
  .then(tryOffscreen)
  .catch((error) => { report.offscreen = { error: error.message }; })
  .finally(async () => {
    await stopWorker();
    if (shell && !shell.isDestroyed()) shell.destroy();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(JSON.stringify(report) + '\n', () => app.exit());
  });
