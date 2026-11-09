// Probe 51 · P7 真实 TabManager 跨窗口迁移（替代 probe 40 的裸 BrowserView 验证）
//
// 用生产 tabs.ts（esbuild 打包，只替换 window / session-manager / ui-language
// 三个外部依赖）验证：
//   1. 迁移后 webContents.id 与 pid 不变，文档未重载
//   2. 全局索引归属切换到目标窗口，源实例不再持有该标签
//   3. 迁移后标题事件投递到新窗口（新实例监听器生效、旧实例不双发）
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { wait, waitFor } = require('../lib/timeout.cjs');

module.exports = {
  id: '51-tab-transfer',
  name: 'P7 real TabManager cross-window transfer',
  needsElectron: true,
  timeoutMs: 90_000,

  async run(ctx) {
    const { BrowserWindow } = ctx.electron;
    const esbuild = require(path.join(ctx.root, 'node_modules', 'esbuild'));
    const outfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bao-transfer-')), 'tabs.cjs');

    await esbuild.build({
      stdin: {
        contents: "export * from './src/main/modules/tabs';",
        resolveDir: ctx.root,
        loader: 'ts',
      },
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node12',
      external: ['electron', 'electron-log'],
      alias: { '@shared': path.join(ctx.root, 'src/shared') },
      plugins: [{
        name: 'transfer-stubs',
        setup(build) {
          build.onLoad({ filter: /[\\/]modules[\\/](window|session-manager|ui-language)\.ts$/ }, (args) => {
            const name = path.basename(args.path);
            const contents = name === 'window.ts'
              ? 'export const getMainWindow = () => globalThis.__baoProbeMainWindow ?? null;'
              : name === 'ui-language.ts'
                ? 'export const uiText = (zh) => zh;'
                : 'export const setupSessionOnce = () => {};';
            return { contents, loader: 'ts' };
          });
        },
      }],
    });

    const Module = require('module');
    const bundled = new Module(outfile, module);
    bundled.filename = outfile;
    bundled.paths = Module._nodeModulePaths(ctx.root);
    bundled._compile(fs.readFileSync(outfile, 'utf8'), outfile);
    const tabs = bundled.exports;

    const winA = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { nodeIntegration: false, contextIsolation: true } });
    const winB = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { nodeIntegration: false, contextIsolation: true } });
    global.__baoProbeMainWindow = winA;
    const failures = [];
    const check = (name, ok, detail) => { if (!ok) failures.push({ name, detail }); };

    let view = null;
    try {
      const managerA = tabs.createTabManager(winA, path.join(ctx.root, 'dist', 'webview-preload.js'));
      const managerB = tabs.createTabManager(winB, path.join(ctx.root, 'dist', 'webview-preload.js'));
      managerA.create('transfer-probe', 'data:text/html,<title>before</title><h1>transfer</h1><script>window.__kept="1"</script>');
      view = winA.getBrowserViews()[0];
      check('source window owns the view', Boolean(view), { aViews: winA.getBrowserViews().length });
      if (!view) throw new Error('view not created');
      const wc = view.webContents;
      await waitFor(async () => (await wc.executeJavaScript('window.__kept || ""').catch(() => '')) === '1', { timeoutMs: 10_000, label: 'marker ready' });

      let navigations = 0;
      wc.on('did-navigate', () => { navigations += 1; });
      const before = { wcId: wc.id, pid: wc.getOSProcessId(), navigations };

      const moved = tabs.transferTabBetweenWindows('transfer-probe', winB);
      check('transferTabBetweenWindows returned true', moved === true, { moved });
      await wait(300);

      const after = { wcId: wc.id, pid: wc.getOSProcessId(), navigations };
      check('webContents.id stable', before.wcId === after.wcId, { before, after });
      check('pid stable', before.pid === after.pid, { before, after });
      check('document not reloaded', (await wc.executeJavaScript('window.__kept || ""').catch(() => 'ERR')) === '1', {});
      check('no extra navigation', after.navigations === before.navigations, { before, after });
      check('view moved to target window', winB.getBrowserViews().length === 1 && winA.getBrowserViews().length === 0,
        { a: winA.getBrowserViews().length, b: winB.getBrowserViews().length });
      check('global index points at target manager', tabs.getTabManagerForTabId('transfer-probe') === managerB,
        { ownerIsB: tabs.getTabManagerForTabId('transfer-probe') === managerB });
      check('source manager no longer owns the tab', managerA.getTabCount() === 0, { aCount: managerA.getTabCount() });

      // 迁移后标题事件必须到新窗口（tabs.send → win.setTitle）。
      await wc.executeJavaScript('document.title = "after-transfer"').catch(() => {});
      await waitFor(() => winB.getTitle().includes('after-transfer'), { timeoutMs: 5_000, label: 'title routed to B' })
        .catch(() => { /* 断言在下一行给出 */ });
      check('title event routed to new window', winB.getTitle().includes('after-transfer'), { bTitle: winB.getTitle() });
      check('old window title untouched', !winA.getTitle().includes('after-transfer'), { aTitle: winA.getTitle() });

      return {
        ok: failures.length === 0,
        summary: failures.length === 0
          ? 'real TabManager transfer: wc preserved, index moved, events routed'
          : `${failures.length} check(s) failed`,
        detail: { failures, before, after, titleA: winA.getTitle(), titleB: winB.getTitle() },
      };
    } finally {
      global.__baoProbeMainWindow = undefined;
      try { tabs.disposeTabManager(winA, winA.id); } catch { /* ignore */ }
      try { tabs.disposeTabManager(winB, winB.id); } catch { /* ignore */ }
      for (const w of [winA, winB]) { try { if (!w.isDestroyed()) w.destroy(); } catch { /* ignore */ } }
      try { fs.rmSync(path.dirname(outfile), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  },
};
