// Probe: userscript runtime health over a live BrowserView (the probe-ified
// version of the menu-dedupe smoke). Loads a local page with an iframe and
// asserts: main-frame badge, sub-frame badge, command dedupe, command invoke.
// Copy this probe to validate new runtime scenarios without rebuilding the
// BrowserView + fixture skeleton from scratch.
'use strict';

const http = require('http');
const path = require('path');

const { waitFor, wait } = require('../lib/timeout.cjs');

module.exports = {
  id: '11-views',
  name: 'runtime health (BrowserView)',
  needsElectron: true,
  timeoutMs: 90_000,

  async run(ctx) {
    const { app, BrowserView, BrowserWindow, ipcMain } = ctx.electron;
    const mod = require(path.join(ctx.root, 'release', 'tests', 'userscripts-admin-module.cjs'));
    const manager = mod.initUserscriptManager();

    const failures = [];
    const check = (name, ok, detail) => {
      if (!ok) failures.push({ name, detail });
    };

    ipcMain.on('userscript:get-config', (event, payload) => {
      event.returnValue = manager.snapshotFor(event.sender.id, payload?.url ?? '', Boolean(payload?.isMainFrame));
    });
    ipcMain.on('userscript:report', (event, payload) => {
      manager.acceptReport(event.sender.id, payload);
    });
    ipcMain.on('userscript:menu-register', (event, payload) => {
      manager.registerMenuCommand(event.sender.id, payload.scriptId, payload.documentId, payload.title, payload.commandId, Boolean(payload.isMainFrame));
    });
    ipcMain.on('userscript:menu-unregister', (event, payload) => {
      manager.unregisterMenuCommand(event.sender.id, payload.commandId);
    });
    ipcMain.on('userscript:menu-invoked', (event, payload) => {
      manager.acceptReport(event.sender.id, {
        documentId: payload.documentId,
        frameUrl: '',
        isMainFrame: false,
        mode: 'ppapi',
        generation: 1,
        phase: 'command-invoked',
        detail: payload,
        accepted: true,
      });
    });

    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (req.url === '/frame.html') {
        res.end('<!doctype html><html><head><meta charset="utf-8"><title>sub</title></head><body><p>subframe</p></body></html>');
      } else {
        res.end('<!doctype html><html><head><meta charset="utf-8"><title>main</title></head><body><p>main</p><iframe src="/frame.html" width="300" height="200"></iframe></body></html>');
      }
    });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${srv.address().port}/`;

    const preloadPath = path.join(ctx.root, 'release', 'tests', 'userscript-runtime-preload.cjs');
    const host = new BrowserWindow({ show: false, width: 900, height: 700, webPreferences: { nodeIntegration: false, contextIsolation: true, spellcheck: false } });
    const view = new BrowserView({
      webPreferences: {
        preload: preloadPath,
        plugins: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: true,
        spellcheck: false,
        partition: 'persist:probe-views',
      },
    });
    host.addBrowserView(view);
    view.setBounds({ x: 0, y: 0, width: 900, height: 700 });
    manager.registerView(view.webContents.id, { mode: 'ppapi', generation: 1, token: 'probe-views' });

    try {
      await waitFor(
        async () => {
          await view.webContents.loadURL(url).catch(() => {});
          return true;
        },
        { timeoutMs: 20_000, label: 'page load' },
      );
      await waitFor(
        async () => {
          const badge = await view.webContents.executeJavaScript(
            `Boolean(document.getElementById('baoflash-test-badge'))`,
          ).catch(() => false);
          return badge === true;
        },
        { timeoutMs: 20_000, label: 'main-frame badge' },
      );

      const probe = await view.webContents.executeJavaScript(`(() => {
        const game = document.getElementById('game') || document.querySelector('iframe');
        let subBadge = false;
        try {
          subBadge = Boolean(game && game.contentDocument && game.contentDocument.getElementById('baoflash-test-badge'));
        } catch (e) { subBadge = false; }
        return {
          mainBadge: Boolean(document.getElementById('baoflash-test-badge')),
          iframes: document.querySelectorAll('iframe').length,
          subBadge,
        };
      })()`);
      check('main-frame badge', probe.mainBadge === true, probe);
      check('iframe exists', probe.iframes >= 1, probe);
      check('sub-frame badge (iframe script ran)', probe.subBadge === true, probe);

      const commands = manager.commandsFor(view.webContents.id);
      check('command dedupe: exactly 2 (main+iframe register 4)', commands.length === 2, commands.map((c) => c.title));
      check('commands are main-frame ones', commands.every((c) => c.isMainFrame), commands);

      const reset = commands.find((c) => c.title === '重置访问计数');
      check('reset-counter command present', Boolean(reset));
      if (reset) {
        view.webContents.send('userscript:menu-invoke', { commandId: reset.commandId, documentId: reset.documentId });
        const ok = await waitFor(
          async () => {
            const text = await view.webContents.executeJavaScript(
              `document.getElementById('baoflash-test-badge')?.textContent || ''`,
            ).catch(() => '');
            return /访问计数\(持久化\):0\b/.test(text);
          },
          { timeoutMs: 10_000, label: 'command effect (counter reset to 0)' },
        );
        check('command invoke actually ran in page', ok === true);
      }
    } finally {
      try { host.destroy(); } catch { /* ignore */ }
      srv.close();
    }

    return {
      ok: failures.length === 0,
      summary: failures.length === 0 ? 'runtime healthy' : `${failures.length} checks failed`,
      detail: { url, failures },
    };
  },
};
