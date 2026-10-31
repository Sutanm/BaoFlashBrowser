'use strict';
const assert = require('assert');
const path = require('path');
const { execFileSync } = require('child_process');
const { waitFor } = require('../lib/timeout.cjs');

module.exports = {
  id: '24-web-theme', name: 'native theme propagation to BrowserViews', needsElectron: true, timeoutMs: 30000,
  async run(ctx) {
    const { nativeTheme } = require('electron');
    const { BrowserWindow, BrowserView, ipcMain } = ctx.electron;
    const previous = nativeTheme.themeSource;
    const product = path.join(ctx.userData, 'theme-ipc.cjs');
    execFileSync('node', ['-e', `require('esbuild').buildSync({entryPoints:['src/main/ipc/theme.ipc.ts'],outfile:${JSON.stringify(product)},bundle:true,platform:'node',format:'cjs',target:'node12',external:['electron']})`], {
      cwd: ctx.root, windowsHide: true, timeout: 15000,
    });
    require(product).registerThemeIPC();
    const host = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
    const views = [];
    const snapshot = async (view) => view.webContents.executeJavaScript(`({ dark:matchMedia('(prefers-color-scheme: dark)').matches, color:getComputedStyle(document.body).color, changes:window.themeChanges })`);
    const apply = (source) => host.webContents.executeJavaScript(`require('electron').ipcRenderer.invoke('theme:set-source', ${JSON.stringify(source)})`);
    const addView = async (isolation) => {
      const view = new BrowserView({ webPreferences: { contextIsolation: isolation, plugins: isolation, nodeIntegration: false, backgroundThrottling: false, partition: 'persist:probe-theme' } });
      views.push(view);
      host.addBrowserView(view);
      view.setBounds({ x: 0, y: 0, width: 640, height: 480 });
      await view.webContents.loadURL('data:text/html,' + encodeURIComponent('<style>body{color:rgb(10,20,30)}@media(prefers-color-scheme:dark){body{color:rgb(200,210,220)}}</style><body>Theme probe<script>window.themeChanges=0;window.themeQuery=matchMedia("(prefers-color-scheme: dark)");window.themeQuery.addEventListener("change",()=>window.themeChanges++)</script>'));
      return view;
    };
    try {
      await host.loadURL('about:blank');
      host.showInactive();
      await apply('light');
      await addView(true);
      await addView(false);
      for (const source of ['dark', 'light']) {
        await apply(source);
        for (const view of views) {
          await waitFor(async () => (await snapshot(view)).dark === (source === 'dark'), { timeoutMs: 3000, label: `theme ${source}` });
          assert.strictEqual((await snapshot(view)).color, source === 'dark' ? 'rgb(200, 210, 220)' : 'rgb(10, 20, 30)');
          await waitFor(async () => (await snapshot(view)).changes >= (source === 'dark' ? 1 : 2), { timeoutMs: 3000, label: 'matchMedia change' });
        }
      }
      await apply('dark');
      assert.strictEqual((await snapshot(await addView(true))).dark, true, 'new tabs inherit theme');
      await apply('system');
      assert.strictEqual(nativeTheme.themeSource, 'system');
      for (const view of views) {
        await waitFor(async () => (await snapshot(view)).dark === nativeTheme.shouldUseDarkColors, { timeoutMs: 3000, label: 'system preference' });
      }
      let rejected = false;
      try { await apply('invalid'); } catch { rejected = true; }
      assert(rejected, 'invalid source must be rejected');
      assert.strictEqual(nativeTheme.themeSource, 'system');
      return { ok: true, summary: 'light/dark/system, CSS + matchMedia events, both isolation modes and newly opened tabs verified' };
    } finally {
      nativeTheme.themeSource = previous;
      for (const view of views) if (!view.webContents.isDestroyed()) view.webContents.destroy();
      host.destroy();
      ipcMain.removeHandler('theme:set-source');
    }
  },
};
