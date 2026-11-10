'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

module.exports = {
  id: '60-devtools-target-identity',
  name: 'DevTools distinguishes identical shell and page URLs',
  needsElectron: true,
  timeoutMs: 15_000,
  async run(ctx) {
    const { BrowserWindow, BrowserView, app } = ctx.electron;
    const esbuild = require(path.join(ctx.root, 'node_modules', 'esbuild'));
    const result = await esbuild.build({
      stdin: {
        contents: "export * from './src/main/modules/devtoolbox-target-resolve';",
        resolveDir: ctx.root,
      },
      bundle: true,
      write: false,
      platform: 'node',
      external: ['electron', 'electron-log'],
      alias: { '@shared': path.join(ctx.root, 'src/shared') },
      plugins: [{
        name: 'probe-window-registry',
        setup(build) {
          build.onLoad({ filter: /[\\/]modules[\\/](tabs|window|devtoolbox-frontend-server)\.ts$/ }, ({ path: file }) => ({
            loader: 'js',
            contents: path.basename(file) === 'tabs.ts'
              ? 'export const getTabManagerForWindow = id => globalThis.__baoTargetProbe.get(id)?.tabs; export const tabManager = {};'
              : path.basename(file) === 'window.ts'
                ? 'export const getWindowById = id => globalThis.__baoTargetProbe.get(id)?.win; export const getFocusedRegisteredWindow = () => null;'
                : 'export const ensureFrontendServer = () => null, getDevToolsFrontendDir = () => "", useBridge = () => true, useLegacyHttp = () => false;',
          }));
        },
      }],
    });
    const compiled = { exports: {} };
    new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, compiled, compiled.exports);
    const url = 'data:text/html,<title>identical</title>';
    const owners = new Map();
    globalThis.__baoTargetProbe = owners;
    const port = Number(fs.readFileSync(path.join(app.getPath('userData'), 'DevToolsActivePort'), 'utf8').split('\n')[0]);

    try {
      for (let i = 0; i < 2; i += 1) {
        const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
        const view = new BrowserView({ webPreferences: { contextIsolation: true } });
        win.addBrowserView(view);
        owners.set(win.id, { win, view, tabs: { getWebContents: id => id === 'tab-' + i ? view.webContents : null } });
        await Promise.all([win.loadURL(url), view.webContents.loadURL(url)]);
      }
      const ids = [...owners.keys()];
      const firstView = owners.get(ids[0]).view.webContents;
      firstView.debugger.attach('1.3'); // Simulate a capture client already using the debugger.
      const { resolveTargetId, pickTargetForTab } = compiled.exports;
      const resolved = await Promise.all([
        ...ids.map(id => resolveTargetId('shell', null, id)),
        ...ids.map((id, i) => pickTargetForTab('tab-' + i, id)),
      ]);
      const advertised = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/json/list' }, (response) => {
          let body = '';
          response.on('data', chunk => { body += chunk; });
          response.on('end', () => {
            try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
          });
        }).on('error', reject);
      });
      const wrongOwner = await pickTargetForTab('tab-0', ids[1]);
      const ok = resolved.every(id => id && advertised.some(target => target.id === id))
        && new Set(resolved).size === 4 && wrongOwner === null && firstView.debugger.isAttached();
      return { ok, summary: ok ? 'four distinct, advertised targets; existing debugger retained' : 'target identity mismatch', detail: { resolved, wrongOwner } };
    } finally {
      for (const { win, view } of owners.values()) {
        if (view.webContents.debugger.isAttached()) view.webContents.debugger.detach();
        win.destroy();
      }
      delete globalThis.__baoTargetProbe;
    }
  },
};
