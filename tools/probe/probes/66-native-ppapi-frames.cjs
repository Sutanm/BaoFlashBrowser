'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { wait, waitFor, withTimeout } = require('../lib/timeout.cjs');

function fingerprint(bytes, width, height, region, bgra) {
  let hash = 0;
  let colored = 0;
  for (let y = 0; y < 120; y++) {
    const sy = region.y + Math.floor((y + 0.5) * region.height / 120);
    for (let x = 0; x < 160; x++) {
      const sx = region.x + Math.floor((x + 0.5) * region.width / 160);
      if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue;
      const p = (sy * width + sx) * 4;
      const color = ((bytes[p + (bgra ? 2 : 0)] > 128) << 2) |
        ((bytes[p + 1] > 128) << 1) | (bytes[p + (bgra ? 0 : 2)] > 128);
      if (color !== 0 && color !== 7) colored++;
      hash = Math.imul(hash ^ color, 16777619);
    }
  }
  return { hash, colored };
}

// Executed in the isolated probe host's hidden renderer, not in the app under test.
async function startDesktop(sourceId, screenBounds, fingerprint) {
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxFrameRate: 120 } },
  });
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 120;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  const state = { mode: null, rect: null, rows: [], dimensions: null };
  window.baoDesktopFrames = state;
  function frame() {
    if (state.mode) {
      const { x, y, width, height } = state.rect;
      const scaleX = video.videoWidth / screenBounds.width;
      const scaleY = video.videoHeight / screenBounds.height;
      ctx.drawImage(video, (x - screenBounds.x) * scaleX, (y - screenBounds.y) * scaleY,
        width * scaleX, height * scaleY, 0, 0, 160, 120);
      const bytes = ctx.getImageData(0, 0, 160, 120).data;
      let sample;
      if (state.mode === 'counter') {
        let id = 0;
        for (let bit = 0; bit < 8; bit++) {
          if (bytes[(12 * 160 + 8 + 8 * bit) * 4] > 128) id |= 1 << bit;
        }
        sample = { id };
      } else {
        sample = fingerprint(bytes, 160, 120, { x: 0, y: 0, width: 160, height: 120 }, false);
      }
      state.rows.push({ at: Date.now(), ...sample });
    }
    video.requestVideoFrameCallback(frame);
  }
  await video.play();
  state.dimensions = [video.videoWidth, video.videoHeight];
  state.image = () => canvas.toDataURL('image/png');
  state.stop = () => video.srcObject.getTracks().forEach((track) => track.stop());
  video.requestVideoFrameCallback(frame);
}

function summarize(rows) {
  const changes = rows.filter((row, i) => i === 0 || row.hash !== rows[i - 1].hash);
  const gaps = changes.slice(1).map((row, i) => row.at - changes[i].at).sort((a, b) => a - b);
  const span = (rows.at(-1)?.at - rows[0]?.at) / 1000;
  const perSecond = (count) => span > 0 ? Number(((count - 1) / span).toFixed(2)) : null;
  return {
    samples: rows.length, gameSamples: rows.filter((row) => row.colored > 300).length,
    changes: changes.length, sampleFps: perSecond(rows.length), changedFps: perSecond(changes.length),
    p95ChangeGapMs: gaps[Math.ceil(gaps.length * 0.95) - 1],
    longestChangeGapMs: gaps.at(-1),
  };
}

module.exports = {
  id: '66-native-ppapi-frames',
  name: 'Bao full-app PPAPI presentation and desktop frame baseline',
  needsElectron: true,
  timeoutMs: 85_000,

  async run({ root, userData, electron }) {
    const game = process.env.BAO_CEF_GAME_SWF;
    if (process.platform !== 'win32' || process.env.BAO_PROBE_NATIVE_FRAMES !== '1' || !game) {
      return { ok: true, summary: 'opt-in Windows desktop (BAO_PROBE_NATIVE_FRAMES=1 and BAO_CEF_GAME_SWF)' };
    }
    if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Run this probe host under modern Electron (the app under test still uses Electron 11).');
    const { desktopCapturer, screen } = require('electron');
    const display = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const source = sources.find((candidate) => candidate.display_id === String(display.id));
    if (!source) throw new Error('Primary display capture source is unavailable');

    const release = path.join(root, 'release');
    fs.mkdirSync(release, { recursive: true });
    const output = fs.mkdtempSync(path.join(release, 'native-ppapi-'));
    const profile = fs.mkdtempSync(path.join(userData, 'full-app-'));
    const gameFile = path.join(userData, 'flx-invaders.swf');
    const gamePage = path.join(userData, 'game.html');
    const subscriptionPage = path.join(userData, 'game-subscription.html');
    const calibrationPage = path.join(userData, 'calibration.html');
    fs.copyFileSync(game, gameFile);
    const css = '<!doctype html><meta charset="utf-8"><style>body{margin:0}embed{display:block}</style>';
    const gameHtml = css +
      '<embed src="flx-invaders.swf" type="application/x-shockwave-flash" width="640" height="480">';
    fs.writeFileSync(gamePage, gameHtml);
    fs.writeFileSync(subscriptionPage, gameHtml);
    fs.writeFileSync(calibrationPage, css + `
      <canvas width="640" height="480" style="background:black"></canvas><script>
      const ctx = document.querySelector('canvas').getContext('2d');
      let id = 0;
      window.baoStartCounter = () => setInterval(() => {
        id = (id + 1) & 255;
        for (let bit = 0; bit < 8; bit++) {
          ctx.fillStyle = id & (1 << bit) ? 'white' : 'black';
          ctx.fillRect(20 + 32 * bit, 36, 24, 24);
        }
      }, 1000 / 30);
      </script>`);
    const env = { ...process.env, BAO_E2E: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    const capture = new electron.BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
    let app;
    try {
      app = await require('playwright')._electron.launch({
        executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
        args: [path.join(root, 'dist', 'main.js'), '--user-data-dir=' + profile], env, timeout: 12_000,
      });
      const shell = await app.firstWindow({ timeout: 12_000 });
      await shell.locator('#first-run-language, .topbar-tabbar').first().waitFor({ timeout: 10_000 });
      if (await shell.locator('#first-run-language').isVisible()) {
        await shell.locator('.first-run-dialog button[type="submit"]').click({ timeout: 4000 });
        await shell.locator('#first-run-vault-skip').click({ timeout: 4000 });
      }
      const appBounds = {
        x: display.workArea.x + 25, y: display.workArea.y + 25,
        width: Math.min(900, display.workArea.width - 50),
        height: Math.min(720, display.workArea.height - 50),
      };
      await app.evaluate(({ BrowserWindow }, bounds) => {
        const win = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('/renderer/index.html'));
        win.setBounds(bounds);
        win.setAlwaysOnTop(true);
        win.show();
      }, appBounds);
      await capture.loadFile(calibrationPage);
      const desktop = (script) => capture.webContents.executeJavaScript(script);
      await withTimeout(desktop(`(${startDesktop})(${JSON.stringify(source.id)},${JSON.stringify(display.bounds)},${fingerprint})`),
        8000, 'desktop capture startup');

      async function navigate(file) {
        const url = pathToFileURL(file).href;
        await shell.locator('.address-input').fill(url, { timeout: 5000 });
        await shell.locator('.address-input').press('Enter', { timeout: 5000 });
        return waitFor(() => app.evaluate(({ BrowserWindow }, target) => {
          const win = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('/renderer/index.html'));
          const view = win.getBrowserViews().find((view) => view.webContents.getURL() === target);
          if (!view || view.webContents.isLoading()) return null;
          const rect = view.getBounds();
          if (rect.width < 640 || rect.height < 480) return null;
          const content = win.getContentBounds();
          return { id: view.webContents.id, x: content.x + rect.x, y: content.y + rect.y,
            width: 640, height: 480, viewWidth: rect.width, viewHeight: rect.height };
        }, url), { timeoutMs: 8000, intervalMs: 50, label: 'full app BrowserView navigation and bounds' });
      }

      async function desktopMeasure(rect, mode, duration) {
        await desktop(`Object.assign(baoDesktopFrames, { rect: ${JSON.stringify(rect)}, mode: ${JSON.stringify(mode)}, rows: [] }); void 0`);
        await wait(duration);
        return desktop('baoDesktopFrames.mode = null; baoDesktopFrames.rows');
      }

      const counterView = await navigate(calibrationPage);
      await wait(250);
      await app.evaluate(({ webContents }, id) => webContents.fromId(id).executeJavaScript('window.baoStartCounter(); void 0'), counterView.id);
      const calibrationRows = await desktopMeasure(counterView, 'counter', 5000);
      const observedIds = [...new Set(calibrationRows.map((row) => row.id).filter((id) => id > 0 && id < 255))];
      const counterSpan = observedIds.length ? Math.max(...observedIds) - Math.min(...observedIds) + 1 : 0;
      const calibration = { samples: calibrationRows.length, observed: observedIds.length, idSpan: counterSpan,
        missed: counterSpan - observedIds.length };

      const view = await navigate(gamePage);
      const info = await app.evaluate(async ({ webContents }, id) => {
        const wc = webContents.fromId(id);
        return { electron: process.versions.electron, chrome: process.versions.chrome,
          plugins: await wc.executeJavaScript('Array.from(navigator.plugins).map(p => p.name)'),
          runtime: await wc.executeJavaScript('({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })'),
        };
      }, view.id);
      await wait(1300);
      const visibleRows = await desktopMeasure(view, 'game', 20_000);
      const captureImage = await desktop('baoDesktopFrames.image()');
      fs.writeFileSync(path.join(output, 'game-desktop.png'), Buffer.from(captureImage.split(',')[1], 'base64'));

      const subscriptionView = await navigate(subscriptionPage);
      await wait(1300);
      await app.evaluate(({ webContents }, args) => {
        const wc = webContents.fromId(args.id);
        const hash = eval('(' + args.fingerprint + ')');
        global.baoNativeFrames = [];
        wc.beginFrameSubscription(false, (image) => {
          const { width, height } = image.getSize();
          const bytes = image.toBitmap();
          if (bytes.length !== width * height * 4) return;
          const region = { x: 0, y: 0, width: Math.round(640 * width / args.viewWidth),
            height: Math.round(480 * height / args.viewHeight) };
          global.baoNativeFrames.push({ at: Date.now(), ...hash(bytes, width, height, region, true) });
        });
      }, { ...subscriptionView, fingerprint: String(fingerprint) });
      let simultaneous;
      let subscribed;
      try {
        simultaneous = await desktopMeasure(subscriptionView, 'game', 20_000);
      } finally {
        subscribed = await app.evaluate(({ webContents }, id) => {
          webContents.fromId(id).endFrameSubscription();
          return global.baoNativeFrames;
        }, subscriptionView.id);
      }
      const dimension = await desktop('baoDesktopFrames.dimensions');
      const first = Math.max(simultaneous[0]?.at || 0, subscribed[0]?.at || 0);
      const last = Math.min(simultaneous.at(-1)?.at || 0, subscribed.at(-1)?.at || 0);
      const inOverlap = (row) => row.at >= first && row.at <= last;
      const report = { info, view, dimension, calibration, visibleOnly: summarize(visibleRows),
        desktopAndSubscription: summarize(simultaneous.filter(inOverlap)),
        browserView: summarize(subscribed.filter(inOverlap)) };
      fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
      fs.writeFileSync(path.join(output, 'samples.json'), JSON.stringify({ calibrationRows, visibleRows, simultaneous, subscribed }));
      const ok = info.plugins.includes('Shockwave Flash') && calibration.observed > 100 &&
        report.visibleOnly.gameSamples > 300 && report.browserView.gameSamples > 300;
      return { ok, summary: `desktop ${report.visibleOnly.changedFps} FPS, BrowserView ${report.browserView.changedFps} FPS, calibration missed ${calibration.missed}`,
        detail: { output, ...report } };
    } finally {
      if (!capture.isDestroyed()) capture.destroy();
      if (app) await app.close().catch(() => {});
    }
  },
};
