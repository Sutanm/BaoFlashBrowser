// Production preload, with userscripts disabled: UI must still work without resizing the game.
'use strict';
const http = require('http');
const path = require('path');
const assert = require('assert');
const { waitFor } = require('../lib/timeout.cjs');
module.exports = {
  id: '23-native-automation-assistant', name: 'native floating automation without userscripts', needsElectron: true, timeoutMs: 45000,
  async run(ctx) {
    const { BrowserWindow, BrowserView, ipcMain } = ctx.electron;
    const config = (event) => { event.returnValue = { ok: true, mode: 'ppapi', generation: 1, scripts: [], values: {}, resources: {} }; };
    const ruffle = (event) => { event.returnValue = { enabled: false }; };
    ipcMain.on('userscript:get-config', config);
    ipcMain.on('get-ruffle-mode', ruffle);
    let lists = 0, statuses = 0;
    ipcMain.handle('automation-assistant:list', () => { lists++; return []; });
    ipcMain.handle('automation-assistant:status', () => { statuses++; return { state: 'idle', executedSteps: 0, logs: [] }; });
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': "script-src 'self'" });
      res.end('<!doctype html><html><body><canvas width="640" height="480"></canvas></body></html>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const host = new BrowserWindow({ show: false });
    try {
      for (const isolation of [true, false]) {
        const view = new BrowserView({ webPreferences: { preload: path.join(ctx.root, 'dist/webview-preload.js'), contextIsolation: isolation, plugins: isolation, nodeIntegration: false, partition: 'persist:probe-native-assistant' } });
        view.webContents.on('preload-error', (_e, _p, error) => console.error('native preload:', error));
        view.webContents.on('console-message', (_e, level, message) => { if (level >= 2) console.error('native console:', message); });
        host.addBrowserView(view); view.setBounds({ x: 0, y: 0, width: 900, height: 650 });
        try {
          await view.webContents.loadURL(`http://127.0.0.1:${server.address().port}/`);
          await waitFor(() => view.webContents.executeJavaScript("Boolean(document.querySelector('#bao-automation-frame-assistant .bao-orb'))"), { timeoutMs: 8000, label: `native orb isolation=${isolation}` });
          const before = await view.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})');
          view.webContents.send('automation-assistant:show');
          await waitFor(() => view.webContents.executeJavaScript("document.getElementById('bao-automation-frame-assistant').classList.contains('bao-open')"), { timeoutMs: 3000, label: 'open native assistant' });
          assert.deepStrictEqual(await view.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})'), before);
          assert.deepStrictEqual(view.getBounds(), { x: 0, y: 0, width: 900, height: 650 });
        } finally { view.webContents.destroy(); }
      }
      assert(lists > 0 && statuses > 0, 'native transport not used');
      return { ok: true, summary: 'PPAPI + Ruffle isolation modes: native UI and IPC, unchanged game viewport, userscripts disabled' };
    } finally {
      host.destroy(); server.close();
      ipcMain.removeListener('userscript:get-config', config); ipcMain.removeListener('get-ruffle-mode', ruffle);
      ipcMain.removeHandler('automation-assistant:list'); ipcMain.removeHandler('automation-assistant:status');
    }
  },
};
