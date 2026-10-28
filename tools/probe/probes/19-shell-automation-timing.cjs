'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { waitFor } = require('../lib/timeout.cjs');

module.exports = {
  id: '19-shell-automation-timing',
  name: 'full app 1100ms workflow and JavaScript timing (opt-in)',
  needsElectron: false,
  timeoutMs: 75000,
  async run(ctx) {
    if (process.env.BAO_PROBE_SHELL_TIMING !== '1') return { ok: true, summary: 'set BAO_PROBE_SHELL_TIMING=1 to launch an isolated full app' };
    const env = { ...process.env, BAO_E2E: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(path.join(ctx.root, 'tests/electron/fixtures/automation-timing.html')));
    });
    let app;
    try {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${server.address().port}/`;
      const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-shell-timing-'));
      const args = [path.join(ctx.root, 'dist/main.js'), `--user-data-dir=${profile}`];
      if (process.platform === 'linux') args.unshift('--no-sandbox');
      app = await require('playwright')._electron.launch({ args, env });
      const shell = await app.firstWindow();
      await shell.waitForSelector('.address-input');
      await shell.waitForSelector('.tab-item');
      await shell.evaluate(() => {
        window.electronAPI.on('tab:updated', (payload) => { if (payload.url?.startsWith('http://127.0.0.1:')) window.__timingTabId = payload.tabId; });
      });
      await shell.locator('.address-input').fill(origin);
      await shell.locator('.address-input').press('Enter');
      await waitFor(() => shell.evaluate(() => Boolean(window.__timingTabId)), { timeoutMs: 10000, intervalMs: 50, label: 'timing fixture navigation' });
      await app.evaluate(({ BrowserWindow }, nativeMove) => {
        const win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('/renderer/index.html'));
        const view = win.getBrowserViews()[0];
        const wc = view.webContents;
        const trace = global.__baoTimingTrace = { commands: [], viewport: [], bounds: [], gaps: [] };
        const send = wc.debugger.sendCommand.bind(wc.debugger);
        wc.debugger.sendCommand = async (method, params) => {
          const started = Date.now();
          try {
            if (nativeMove && method === 'Input.dispatchMouseEvent' && params?.type === 'mouseMoved' && !params.buttons) {
              wc.sendInputEvent({ type: 'mouseMove', x: Math.round(params.x), y: Math.round(params.y) });
              return;
            }
            return await send(method, params);
          }
          finally { if (method.startsWith('Input.')) trace.commands.push({ at: started, method, type: params?.type, ms: Date.now() - started }); }
        };
        const execute = wc.executeJavaScript.bind(wc);
        wc.executeJavaScript = async (expression, ...args) => {
          const started = Date.now();
          const result = await execute(expression, ...args);
          if (expression === '({width:innerWidth,height:innerHeight})') trace.viewport.push({ at: started, ms: Date.now() - started, result });
          return result;
        };
        const bounds = view.setBounds.bind(view);
        view.setBounds = (rect) => { trace.bounds.push({ at: Date.now(), rect }); return bounds(rect); };
        let last = Date.now();
        setInterval(() => { const now = Date.now(); if (now - last > 120) trace.gaps.push({ at: last, ms: now - last }); last = now; }, 50);
      }, process.env.BAO_PROBE_TIMING_NATIVE_MOVE === '1');
      const count = Number(process.env.BAO_PROBE_SHELL_TIMING_COUNT || 10);
      const prepare = await shell.evaluate(async (count) => {
        const api = window.electronAPI.automationV3;
        const nodes = [];
        for (let i = 0; i < count; i++) {
          nodes.push({ id: `click-${i}`, kind: 'action', action: { kind: 'click', target: { locator: { kind: 'coordinate', point: { unit: 'ratio', x: .3, y: .2 } } } } });
          if (i < count - 1) nodes.push({ id: `wait-${i}`, kind: 'wait', durationMs: { kind: 'literal', valueType: 'number', value: 1100 } });
        }
        await api.createPackage('shell-timing', '时序回归测试');
        await api.updateWorkflow('shell-timing', { formatVersion: 3, id: 'shell-timing', name: 'Timing', root: { id: 'root', kind: 'sequence', nodes } });
        await api.upsertScript('shell-timing', 'timing-js', 'Timing JS', `for(let i=0;i<${count};i++){await bao.input.click({locator:{kind:'coordinate',point:{unit:'ratio',x:.3,y:.2}}});if(i<${count - 1})await bao.time.sleep(1100);}`, ['input']);
        await api.upsertScript('shell-timing', 'timing-inputs', 'Input paths', `
          const timings={};
          const target=(x,y)=>({locator:{kind:'coordinate',point:{unit:'ratio',x,y}}});
          async function measure(name,fn){const start=Date.now();await fn();(timings[name]||(timings[name]=[])).push(Date.now()-start);}
          for(let i=0;i<${count};i++){
            await measure('move',()=>bao.input.move(target(.3,.2)));
            await measure('drag80',()=>bao.input.drag({from:target(.3,.2),to:target(.35,.25),durationMs:80}));
            await measure('scroll',()=>bao.input.scroll(0,40));
            await measure('focusClick',()=>bao.input.click(target(.3,.83)));
            await measure('keyPress',()=>bao.input.keyPress('a'));
            await measure('shortcut',()=>bao.input.keyPress('a',['control']));
            await measure('typeBulk',()=>bao.input.typeText('bulk'));
            await measure('typePaced20',()=>bao.input.typeText('xy',20));
            await bao.time.sleep(100);
          }
          await bao.log.info('INPUT_TIMING '+JSON.stringify(timings));
        `, ['input','log']);
        return true;
      }, count);
      if (!prepare) throw new Error('failed to prepare timing package');
      const rows = [];
      for (const state of ['visible', 'minimized']) {
        await app.evaluate(({ BrowserWindow }, minimized) => {
          const win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('/renderer/index.html'));
          if (minimized) win.minimize(); else { win.restore(); win.show(); }
        }, state === 'minimized');
        for (const frontend of (process.env.BAO_PROBE_SHELL_INPUT_PATHS === '1' ? ['timing-inputs'] : ['workflow', 'timing-js'])) {
          await app.evaluate(async ({ BrowserWindow }) => {
            const win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('/renderer/index.html'));
            await win.getBrowserViews()[0].webContents.executeJavaScript('window.timing.clicks = []; window.timing.moves = []; window.timing.inputEvents = [];');
            for (const key of Object.keys(global.__baoTimingTrace)) global.__baoTimingTrace[key] = [];
          });
          await shell.evaluate(async (id) => window.electronAPI.automationV3.start('shell-timing', id, window.__timingTabId), frontend);
          await waitFor(async () => {
            const result = await shell.evaluate(() => window.electronAPI.automationV3.status());
            if (result.state === 'failed') throw new Error(JSON.stringify(result));
            return result.state === 'completed';
          }, { timeoutMs: 20000, intervalMs: 100, label: 'full shell timing run' });
          const observed = await app.evaluate(async ({ BrowserWindow }) => {
            const win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().includes('/renderer/index.html'));
            return { minimized: win.isMinimized(), clicks: await win.getBrowserViews()[0].webContents.executeJavaScript('window.timing.clicks'), pathEvents: await win.getBrowserViews()[0].webContents.executeJavaScript('window.timing.inputEvents'), trace: global.__baoTimingTrace };
          });
          if (frontend === 'timing-inputs') {
            const status = await shell.evaluate(() => window.electronAPI.automationV3.status());
            const record = status.logs.find((entry) => entry.message.startsWith('INPUT_TIMING '));
            const timings = record ? JSON.parse(record.message.slice('INPUT_TIMING '.length)) : {};
            const eventCounts = {};
            for (const event of observed.pathEvents) eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;
            const heldDurations = [];
            let pressed;
            for (const event of observed.pathEvents) {
              if (event.type === 'mousedown') pressed = { at: event.at, moved: false };
              if (event.type === 'mousemove' && event.buttons && pressed) pressed.moved = true;
              if (event.type === 'mouseup') {
                if (pressed?.moved) heldDurations.push(event.at - pressed.at);
                pressed = undefined;
              }
            }
            const row = { state, frontend, minimized: observed.minimized, timings, eventCounts,
              heldDurations,
              trusted: observed.pathEvents.length > 0 && observed.pathEvents.every((event) => event.trusted),
              dragMoves: observed.pathEvents.filter((event) => event.type === 'mousemove' && event.buttons === 1).length,
              slowCommands: observed.trace.commands.filter((item) => item.ms > 100), mainGaps: observed.trace.gaps };
            rows.push(row); console.log('[input-paths] ' + JSON.stringify(row));
            continue;
          }
          const intervals = observed.clicks.slice(1).map((click, index) => click.at - observed.clicks[index].at);
          const row = { state, frontend, minimized: observed.minimized, received: observed.clicks.length, intervals, trusted: observed.clicks.every((click) => click.trusted),
            trustedMoves: observed.clicks.every((click) => click.moveCount > 0 && click.lastMoveTrusted),
            slowCommands: observed.trace.commands.filter((item) => item.ms > 100), slowViewport: observed.trace.viewport.filter((item) => item.ms > 100),
            viewportChecks: observed.trace.viewport.length, bounds: observed.trace.bounds, mainGaps: observed.trace.gaps };
          rows.push(row);
          console.log('[shell-timing] ' + JSON.stringify(row));
        }
      }
      const failures = rows.filter((row) => row.frontend === 'timing-inputs'
        ? !row.trusted || Object.keys(row.timings).length !== 8 || Object.values(row.timings).some((samples) => samples.length !== count || samples.some((ms) => ms > 500)) || row.dragMoves < count || row.heldDurations.length !== count || row.heldDurations.some((ms) => ms < 65 || ms > 200) || !row.eventCounts.input || !row.eventCounts.wheel
        : row.received !== count || !row.trusted || !row.trustedMoves || row.intervals.some((ms) => ms > 1600));
      return { ok: failures.length === 0, summary: `${rows.length} full app scenarios, ${failures.length} delayed or missing input scenarios`, detail: rows };
    } finally {
      if (app) await app.close().catch(() => {});
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
