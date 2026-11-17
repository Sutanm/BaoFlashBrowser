// Opt-in Windows desktop sampling. The test windows cover the sampled pixels.
'use strict';

const path = require('path');
const { wait } = require('../lib/timeout.cjs');

// Runs in a hidden renderer. Only pixel classifications leave this renderer.
async function sampleDesktop(sourceId, display) {
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxFrameRate: 120 } },
  });
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const state = { frames: 0, samples: [] };
  function readPixel(x, y) {
    const sx = Math.floor((x - display.x) * video.videoWidth / display.width);
    const sy = Math.floor((y - display.y) * video.videoHeight / display.height);
    ctx.drawImage(video, sx, sy, 1, 1, 0, 0, 1, 1);
    const [red, green, blue] = ctx.getImageData(0, 0, 1, 1).data;
    if (Math.max(red, green, blue) <= 24) return 'black';
    if (red > 190 && green > 165 && blue < 115) return 'border';
    if (red < 100 && green > 145 && blue > 60 && blue < 175) return 'interior';
    if (red < 110 && green < 145 && blue > 185) return 'blue';
    return 'other';
  }
  function frame() {
    state.frames++;
    if (state.bounds) {
      const { x, y, width, height } = state.bounds;
      state.samples.push({
        ms: Date.now() - state.started,
        anchor: readPixel(x + 50, y + 90),
        right: readPixel(x + width - 12, y + 90),
        bottom: readPixel(x + 90, y + height - 12),
      });
    }
    video.requestVideoFrameCallback(frame);
  }
  await video.play();
  video.requestVideoFrameCallback(frame);
  window.resizeGutter = state;
}

module.exports = {
  id: '61-resize-gutter',
  name: 'frameless window resize gutter desktop baseline',
  needsElectron: true,
  timeoutMs: 30_000,

  async run({ root, electron }) {
    if (process.platform !== 'win32' || process.env.BAO_PROBE_RESIZE_GUTTER !== '1') {
      return { ok: true, summary: 'Windows only; set BAO_PROBE_RESIZE_GUTTER=1 to sample test window pixels' };
    }

    const { desktopCapturer, screen } = require('electron');
    const { app, BrowserView, BrowserWindow } = electron;
    const display = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const source = sources.find((candidate) => candidate.display_id === String(display.id));
    if (!source) throw new Error('Primary display capture source is unavailable');

    const { x, y, width, height } = display.workArea;
    const large = { x: x + 40, y: y + 40, width: Math.min(960, width - 80), height: Math.min(700, height - 80) };
    const small = { ...large, width: large.width - 220, height: large.height - 160 };
    if (small.width < 280 || small.height < 220) throw new Error('Primary display work area is too small');

    // Bright backing window distinguishes the newly exposed desktop from a black gutter.
    const windowOptions = { show: false, frame: false, webPreferences: { contextIsolation: true } };
    const backing = new BrowserWindow({ ...large, ...windowOptions, backgroundColor: '#d040d0' });
    const host = new BrowserWindow({ ...small, ...windowOptions, backgroundColor: '#f0f0f0' });
    const capture = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, backgroundThrottling: false } });
    const shellOnly = process.env.BAO_PROBE_RESIZE_SHELL_ONLY === '1';
    const view = shellOnly ? null : new BrowserView({
      webPreferences: { contextIsolation: true, partition: 'resize-gutter-probe' },
    });
    const fixture = path.join(root, 'tests', 'electron', 'fixtures', 'resize-gutter.html');
    try {
      if (view) {
        host.setBrowserView(view);
        const [width, height] = host.getContentSize();
        view.setBounds({ x: 0, y: 0, width, height });
        view.setAutoResize({ width: true, height: true });
      }
      await (view ? view.webContents : host.webContents).loadFile(fixture);
      backing.setAlwaysOnTop(true);
      backing.showInactive();
      host.setAlwaysOnTop(true);
      host.show();
      await capture.loadFile(fixture);
      const execute = (script) => capture.webContents.executeJavaScript(script);
      await execute(`(${sampleDesktop})(${JSON.stringify(source.id)}, ${JSON.stringify(display.bounds)})`);

      async function measure(bounds, ms, applyBounds) {
        await execute(`Object.assign(resizeGutter, { bounds: ${JSON.stringify(bounds)}, started: Date.now(), samples: [] }); void 0`);
        if (applyBounds) host.setBounds(bounds);
        await wait(ms);
        return execute('resizeGutter.bounds = null; resizeGutter.samples');
      }

      const control = await measure(small, 350, false);
      if (!control.some(({ anchor, right, bottom }) => anchor === 'interior' && right === 'border' && bottom === 'border')) {
        return { ok: false, summary: 'desktop capture could not verify the stable test pattern', detail: { control } };
      }

      const wide = { ...small, width: large.width };
      const tall = { ...small, height: large.height };
      const transitions = [];
      for (let iteration = 0; iteration < 12; iteration++) {
        for (const [kind, bounds] of [['grow', large], ['shrink', small], ['widen', wide], ['narrow-and-grow', tall], ['reset', small]]) {
          const samples = await measure(bounds, 110, true);
          transitions.push({
            kind,
            frames: samples.length,
            black: samples.filter(({ anchor, right, bottom }) =>
              anchor === 'interior' && (right === 'black' || bottom === 'black')),
            diagnostic: samples.filter(({ anchor, right, bottom }) =>
              anchor === 'blue' && (right === 'blue' || bottom === 'blue')),
          });
        }
      }
      const hits = transitions.filter(({ black }) => black.length);
      const diagnosticHits = transitions.filter(({ diagnostic }) => diagnostic.length);
      const frames = transitions.reduce((total, transition) => total + transition.frames, 0);
      return {
        ok: transitions.every((transition) => transition.frames > 0),
        summary: `${hits.length}/${transitions.length} scripted resizes with black edge pixels (${frames} frames), ${diagnosticHits.length} with diagnostic blue`,
        detail: {
          versions: process.versions,
          shellOnly,
          gpu: app.getGPUFeatureStatus(),
          disableGpu: app.commandLine.hasSwitch('disable-gpu'),
          disableDirectComposition: app.commandLine.hasSwitch('disable-direct-composition'),
          controlFrames: control.length,
          transitions,
        },
      };
    } finally {
      capture.destroy();
      host.destroy();
      backing.destroy();
    }
  },
};
