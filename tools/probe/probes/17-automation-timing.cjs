'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { performance } = require('perf_hooks');
const { wait, withTimeout } = require('../lib/timeout.cjs');

module.exports = {
  id: '17-automation-timing',
  name: '1100ms input and capture timing (opt-in)',
  needsElectron: true,
  timeoutMs: 120000,
  async run(ctx) {
    if (process.env.BAO_PROBE_TIMING !== '1') return { ok: true, summary: 'set BAO_PROBE_TIMING=1 to measure visible/hidden/minimized input' };
    const { BrowserWindow, BrowserView, ipcMain } = ctx.electron;
    const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bao-timing-')), 'timing.cjs');
    await require('esbuild').build({
      stdin: { contents: "export { BrowserViewInputService } from './src/main/modules/automation/browserview-input-service'; export { BrowserViewCaptureService } from './src/main/modules/automation/browserview-capture-service'; export { createAutomationAbortController } from './src/shared/automation/abort-controller'; export { BrowserViewAutomationCoreSession } from './src/main/modules/automation/browserview-core-session'; export { tabManager } from './src/main/modules/tabs'; export { OpenCvWorkerMatcher } from './src/main/modules/automation/vision-worker-matcher'; export { NativeImageTemplateProvider } from './src/main/modules/automation/native-image-template-provider';", resolveDir: ctx.root, loader: 'ts' },
      outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node12',
      external: ['electron', 'electron-log', 'electron-store'], alias: { '@shared': path.join(ctx.root, 'src/shared') },
      plugins: [{ name: 'timing-host', setup(build) {
        build.onLoad({ filter: /[\\/]modules[\\/]window\.ts$/ }, () => ({ contents: 'export const getMainWindow=()=>globalThis.__baoTimingWindow;', loader: 'ts' }));
      } }],
    });
    const Module = require('module');
    const bundled = new Module(outfile, module);
    bundled.filename = outfile; bundled.paths = Module._nodeModulePaths(ctx.root);
    bundled._compile(fs.readFileSync(outfile, 'utf8'), outfile);
    const { BrowserViewInputService, BrowserViewCaptureService, createAutomationAbortController, BrowserViewAutomationCoreSession, tabManager, OpenCvWorkerMatcher, NativeImageTemplateProvider } = bundled.exports;
    fs.copyFileSync(path.join(ctx.root, 'dist/javascript-sandbox-preload.js'), path.join(path.dirname(outfile), 'javascript-sandbox-preload.js'));
    // Mirror document-start production preload channels without user services.
    const channels = {
      'get-ruffle-mode': (event) => { event.returnValue = { enabled: false, source: 'bundled', js: '', bundle: null }; },
      'userscript:get-config': (event) => { event.returnValue = { ok: true, scripts: [], values: {} }; },
    };
    for (const [name, handler] of Object.entries(channels)) ipcMain.on(name, handler);
    const win = new BrowserWindow({ show: true, width: 800, height: 600, webPreferences: { nodeIntegration: false, contextIsolation: true,
      backgroundThrottling: process.env.BAO_PROBE_TIMING_HOST_UNTHROTTLED !== '1',
    } });
    global.__baoTimingWindow = win;
    const runtimeKind = process.env.BAO_PROBE_TIMING_RUNTIME;
    const fullRuntime = runtimeKind === '1' || runtimeKind === 'javascript';
    let view;
    if (fullRuntime) {
      tabManager.setPreload(path.join(ctx.root, 'dist/webview-preload.js'));
      tabManager.setBounds(0, 0, 720, 480);
      tabManager.create('timing', require('url').pathToFileURL(path.join(ctx.root, 'tests/electron/fixtures/automation-timing.html')).href);
      tabManager.activate('timing');
      view = win.getBrowserViews()[0];
    } else view = new BrowserView({ webPreferences: {
      preload: path.join(ctx.root, 'dist/webview-preload.js'), contextIsolation: true,
      plugins: true, nodeIntegration: false, backgroundThrottling: false,
      partition: `timing-probe-${Date.now()}`,
    } });
    const wc = view.webContents;
    if (!fullRuntime) win.addBrowserView(view);
    view.setBounds({ x: 0, y: 0, width: 720, height: 480 });
    const signal = createAutomationAbortController().signal;
    const commands = [];
    const sendCommand = wc.debugger.sendCommand.bind(wc.debugger);
    const debuggerProxy = {
      isAttached: () => wc.debugger.isAttached(),
      attach: (version) => wc.debugger.attach(version),
      detach: () => wc.debugger.detach(),
      sendCommand: async (method, params) => {
        const started = performance.now();
        try { return await sendCommand(method, params); }
        finally { commands.push({ method, type: params?.type, ms: performance.now() - started }); }
      },
    };
    if (fullRuntime) wc.debugger.sendCommand = debuggerProxy.sendCommand;
    const input = new BrowserViewInputService({ id: wc.id, isDestroyed: () => wc.isDestroyed(), debugger: debuggerProxy,
      sendInputEvent: process.env.BAO_PROBE_TIMING_CDP_HOVER === '1' ? undefined : (event) => wc.sendInputEvent(event),
    }, {
      assertCurrent: () => { if (wc.isDestroyed()) throw new Error('view destroyed'); },
      toDisplayPoint: (point) => point, displayScale: () => ({ x: 1, y: 1 }), sleep: wait,
    });
    const capture = new BrowserViewCaptureService(wc, { frameGeometry: () => undefined });
    const rows = [];
    try {
      await wc.loadFile(path.join(ctx.root, 'tests/electron/fixtures/automation-timing.html'));
      const imageTarget = process.env.BAO_PROBE_TIMING_IMAGE === '1';
      const marker = imageTarget ? (await wc.capturePage({ x: 160, y: 90, width: 64, height: 64 })).toPNG() : undefined;
      for (const state of (process.env.BAO_PROBE_TIMING_STATES || 'visible,minimized').split(',')) {
        if (state === 'visible') win.show();
        if (state === 'hidden') win.hide();
        if (state === 'minimized') { win.show(); win.minimize(); }
        await wait(300);
        for (const captureEach of (fullRuntime ? [false] : [false, true])) {
          const keepFrames = process.env.BAO_PROBE_TIMING_KEEP_FRAMES === '1';
          if (keepFrames) wc.incrementCapturerCount();
          try {
          await wc.executeJavaScript('window.timing.clicks = []; window.timing.timers = []; window.timing.frames = 0;');
          commands.length = 0;
          const operations = [];
          if (fullRuntime) {
            const handle = tabManager.beginAutomation('timing', { mode: 'fixed', width: 720, height: 480 });
            await handle.ready;
            const nodes = [];
            const locator = imageTarget ? { kind: 'image', asset: 'marker.png', method: 'template', threshold: .9, mask: 'none' }
              : { kind: 'coordinate', point: { unit: 'logical', x: 200, y: 120 } };
            for (let index = 0; index < 4; index++) {
              nodes.push({ id: `click-${index}`, kind: 'action', action: { kind: 'click', target: { locator } } });
              if (index < 3) nodes.push({ id: `wait-${index}`, kind: 'wait', durationMs: { kind: 'literal', valueType: 'number', value: 1100 } });
            }
            const source = {
              manifest: { format: 'baoauto', formatVersion: 3, id: 'timing', name: 'Timing', frontends: { workflow: 'workflow.json', scripts: [], mainEntryId: 'workflow' }, features: [], integrity: {} },
              workflow: { formatVersion: 3, id: 'timing', name: 'Timing', root: { id: 'root', kind: 'sequence', nodes } },
              scripts: new Map(), assets: new Map(), profiles: new Map(),
            };
            if (runtimeKind === 'javascript') {
              source.manifest.frontends.scripts = [{ id: 'timing-js', path: 'scripts/timing.js', language: 'javascript', permissions: ['input'] }];
              source.scripts.set('scripts/timing.js', `for(let i=0;i<4;i++){await bao.input.click({locator:${JSON.stringify(locator)}});if(i<3)await bao.time.sleep(1100);}`);
            }
            const waitForViewport = handle.waitForViewport.bind(handle);
            const measuredHandle = { ...handle, waitForViewport: async () => {
              const started = performance.now();
              await waitForViewport(); operations.push({ viewportMs: performance.now() - started });
            } };
            const matcher = imageTarget ? new OpenCvWorkerMatcher(new NativeImageTemplateProvider({ load: async () => ({ bytes: marker, cacheKey: 'timing-marker' }) }), { workerPath: path.join(ctx.root, 'dist/vision-worker.cjs') }) : { close: async () => {} };
            const findCandidates = imageTarget && matcher.findManyCandidates.bind(matcher);
            if (imageTarget) matcher.findManyCandidates = async (...args) => {
              const started = performance.now();
              try { return await findCandidates(...args); }
              finally { operations.push({ matchMs: performance.now() - started }); }
            };
            const session = new BrowserViewAutomationCoreSession(measuredHandle, source, undefined, undefined, undefined,
              { matcher, ocrEngine: { recognize: async () => [] } });
            try {
              const result = await (runtimeKind === 'javascript' ? session.startJavaScript('timing-js', ['input']) : session.startWorkflow()).completion;
              if (result.status !== 'completed') throw new Error(`${result.error?.message || result.reason || 'run failed'} ${JSON.stringify(result)}`);
            } finally { await session.close(); await matcher.close(); }
          } else {
          for (let index = 0; index < 4; index++) {
            const started = performance.now();
            let captureMs = 0;
            if (captureEach) {
              const frame = await capture.capture({ logicalViewportSize: { width: 720, height: 480 } });
              captureMs = frame.captureMs;
            }
            const inputStarted = performance.now();
            await withTimeout(input.click({ x: 200, y: 120 }, 'left', 1, signal), 10000, 'timing click');
            operations.push({ captureMs, inputMs: performance.now() - inputStarted, operationMs: performance.now() - started });
            if (index < 3) await wait(1100);
          }
          }
          const observed = await wc.executeJavaScript('JSON.parse(JSON.stringify(window.timing))');
          const intervals = observed.clicks.slice(1).map((click, index) => click.at - observed.clicks[index].at);
          const timerIntervals = observed.timers.slice(1).map((tick, index) => tick - observed.timers[index]);
          const row = { state, minimized: win.isMinimized(), runtimeKind, imageTarget, fullRuntime, captureEach, keepFrames, intervals, operations, commands: [...commands],
            received: observed.clicks.length, trusted: observed.clicks.every((click) => click.trusted),
            visibility: observed.clicks[0]?.visibility, timerMaxMs: Math.max(0, ...timerIntervals), frames: observed.frames };
          rows.push(row);
          console.log('[timing] ' + JSON.stringify(row));
          } catch (error) {
            const row = { state, captureEach, keepFrames, error: error.message };
            rows.push(row);
            console.log('[timing] ' + JSON.stringify(row));
          } finally {
            if (keepFrames && !wc.isDestroyed()) wc.decrementCapturerCount();
          }
        }
      }
      const failures = rows.filter((row) => row.error || row.received !== 4 || !row.trusted || row.intervals.some((ms) => ms > 1600));
      return { ok: failures.length === 0, summary: `${rows.length} scenarios, ${failures.length} delayed or missing input scenarios`, detail: rows };
    } finally {
      if (fullRuntime) tabManager.destroyAll();
      if (!wc.isDestroyed()) wc.destroy();
      if (!win.isDestroyed()) win.destroy();
      for (const [name, handler] of Object.entries(channels)) ipcMain.removeListener(name, handler);
      delete global.__baoTimingWindow;
    }
  },
};
