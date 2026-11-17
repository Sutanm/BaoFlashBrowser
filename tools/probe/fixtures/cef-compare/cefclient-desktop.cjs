'use strict';

const { app, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { wait, waitFor, withTimeout } = require('../../lib/timeout.cjs');

const [modules, output, profiles, cef87, cefModern] = process.argv.slice(2);
app.setPath('userData', fs.mkdtempSync(path.join(profiles, 'capture-')));
const koffi = require(path.join(modules, 'koffi'));
const user32 = koffi.load('user32.dll');
const gdi32 = koffi.load('gdi32.dll');
const Rect = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' });
const Point = koffi.struct('POINT', { x: 'long', y: 'long' });
const getTopWindow = user32.func('void* GetTopWindow(void*)');
const getWindow = user32.func('void* GetWindow(void*, uint32_t)');
const isVisible = user32.func('int IsWindowVisible(void*)');
const getWindowPid = user32.func('GetWindowThreadProcessId', 'uint32_t', ['void*', koffi.out(koffi.pointer('uint32_t'))]);
const getRect = user32.func('GetWindowRect', 'int', ['void*', koffi.out(koffi.pointer(Rect))]);
const setWindowPos = user32.func('int SetWindowPos(void*, void*, int, int, int, int, uint32_t)');
const windowFromPoint = user32.func('WindowFromPoint', 'void*', [Point]);
const getAncestor = user32.func('void* GetAncestor(void*, uint32_t)');
const getDC = user32.func('void* GetDC(void*)');
const releaseDC = user32.func('int ReleaseDC(void*, void*)');
const getPixel = gdi32.func('uint32_t GetPixel(void*, int, int)');

function windowFor(pid) {
  for (let hwnd = getTopWindow(null); hwnd; hwnd = getWindow(hwnd, 2)) {
    const owner = [0];
    getWindowPid(hwnd, owner);
    const bounds = {};
    if (owner[0] === pid && isVisible(hwnd) && getRect(hwnd, bounds) &&
        bounds.right - bounds.left > 320 && bounds.bottom - bounds.top > 260) return hwnd;
  }
  return null;
}

const palette = {
  red: [239, 41, 56],
  green: [39, 198, 112],
  blue: [42, 86, 239],
};

function classify(color) {
  const rgb = [color & 255, (color >>> 8) & 255, (color >>> 16) & 255];
  for (const [name, channels] of Object.entries(palette)) {
    if (channels.every((value, i) => Math.abs(value - rgb[i]) <= 10)) return name;
  }
  return rgb.join(',');
}

async function runCase(name, exe, flags) {
  const profile = fs.mkdtempSync(path.join(profiles, name + '-'));
  const fixture = pathToFileURL(path.join(__dirname, 'cefclient-color-cycle.html')).href;
  const args = [
    '--url=' + fixture, '--cache-path=' + profile, '--root-cache-path=' + profile,
    '--log-file=' + path.join(output, name + '.log'),
    ...flags,
  ];
  const child = spawn(exe, args, { cwd: path.dirname(exe), stdio: 'ignore' });
  const exit = new Promise((resolve) => {
    child.once('exit', (code) => resolve({ code }));
    child.once('error', (error) => resolve({ error: error.message }));
  });
  const counts = {};
  let occluded = 0;
  try {
    const hwnd = await Promise.race([
      waitFor(() => windowFor(child.pid), { timeoutMs: 6500, intervalMs: 50, label: name + ' window' }),
      exit.then((outcome) => { throw new Error(name + ' exited: ' + JSON.stringify(outcome)); }),
    ]);
    const work = screen.getPrimaryDisplay().workArea;
    const point = screen.dipToScreenPoint({ x: work.x + 30, y: work.y + 30 });
    if (!setWindowPos(hwnd, -1n, point.x, point.y, 700, 520, 0x50)) {
      throw new Error('could not show test window');
    }
    await wait(400);
    const bounds = {};
    if (!getRect(hwnd, bounds)) throw new Error('could not read test window bounds');
    const center = {
      x: Math.floor((bounds.left + bounds.right) / 2),
      y: Math.floor((bounds.top + bounds.bottom) / 2),
    };
    const dc = getDC(null);
    if (!dc) throw new Error('could not access desktop pixels');
    try {
      for (let i = 0; i < 24; i++) {
        const hit = windowFromPoint(center);
        if (hit !== hwnd && (!hit || getAncestor(hit, 2) !== hwnd)) {
          occluded++;
        } else {
          const color = classify(getPixel(dc, center.x, center.y));
          counts[color] = (counts[color] || 0) + 1;
        }
        await wait(105);
      }
    } finally {
      releaseDC(null, dc);
    }
    const colors = Object.keys(palette).filter((key) => counts[key] > 0);
    return { counts, occluded, colors, animated: colors.length === 3, flags };
  } catch (error) {
    return { error: error.message, flags };
  } finally {
    child.kill();
    await withTimeout(exit, 3000, name + ' shutdown');
  }
}

async function main() {
  await app.whenReady();
  const offscreen = '--off-screen-rendering-enabled';
  const shared = '--shared-texture-enabled';
  const report = {};
  report.windowed87 = await runCase('87-windowed', cef87, []);
  report.bitmap87 = await runCase('87-osr-bitmap', cef87, [offscreen]);
  report.bitmapGpu87 = await runCase('87-osr-bitmap-gpu', cef87, [offscreen, '--enable-gpu']);
  report.texture87 = await runCase('87-osr-texture', cef87, [offscreen, shared]);
  if (cefModern) {
    report.textureModern = await runCase('modern-osr-texture', cefModern, [offscreen, shared]);
  }
  return report;
}

main().catch((error) => ({ error: error.message })).then((report) => {
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  app.exit();
});
