// Probe 40 · P3/P7 可行性：BrowserView 跨窗口迁移
//
// 这是整个多窗口改造里技术风险最高的一步。tear-off 要求「把标签搬到另一个窗口
// 且页面不重载」。在 Electron 11 里唯一可行的做法是：
//     removeBrowserView(view) → 另一个窗口 addBrowserView(view)
//
// 本 probe 断言迁移后的关键不变量：
//   1. webContents.id 不变（不重建渲染进程）
//   2. 页面不重新加载（同一 document 内的 JS 状态保留）
//   3. 原监听器仍然收到事件（事件绑定在 wc 上，不随宿主窗口丢失）
//   4. 新窗口能正确 setBounds 并渲染
//   5. hostWebContents 跟随变化（P3 的窗口归属反查依赖它）
'use strict';

const { wait, waitFor } = require('../lib/timeout.cjs');

module.exports = {
  id: '40-view-migration',
  name: 'P3/P7 BrowserView cross-window migration',
  needsElectron: true,
  timeoutMs: 60_000,

  async run(ctx) {
    const { BrowserWindow, BrowserView } = ctx.electron;

    const failures = [];
    const check = (name, ok, detail) => { if (!ok) failures.push({ name, detail }); };

    const winA = new BrowserWindow({ show: false, width: 700, height: 500, webPreferences: { nodeIntegration: false, contextIsolation: true } });
    const winB = new BrowserWindow({ show: false, width: 700, height: 500, webPreferences: { nodeIntegration: false, contextIsolation: true } });
    const view = new BrowserView({
      webPreferences: { partition: 'persist:probe-migrate', contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });

    const events = { loadingStarted: 0, didNavigate: 0 };
    let navigationCount = 0;
    const onLoading = () => { events.loadingStarted += 1; navigationCount += 1; };
    const onNavigate = () => { events.didNavigate += 1; };
    view.webContents.on('did-start-loading', onLoading);
    view.webContents.on('did-navigate', onNavigate);

    try {
      winA.addBrowserView(view);
      view.setBounds({ x: 0, y: 0, width: 700, height: 460 });

      // 页面里放一个不会被导航重置的标记，用来证明迁移没有重新加载文档。
      const html = 'data:text/html,<html><body><h1>before</h1><script>window.__migrateMarker = "kept";</script></body></html>';
      await view.webContents.loadURL(html).catch(() => {});
      await waitFor(async () => (await view.webContents.executeJavaScript('window.__migrateMarker || ""').catch(() => '')) === 'kept',
        { timeoutMs: 10_000, label: 'initial marker set' });

      const before = {
        wcId: view.webContents.id,
        pid: view.webContents.getOSProcessId(),
        navigationCount,
        hostWcId: view.webContents.hostWebContents ? view.webContents.hostWebContents.id : null,
        fromWebContentsWindowId: (() => {
          const w = require('electron').BrowserWindow.fromWebContents(view.webContents);
          return w ? w.id : null;
        })(),
      };

      // ---- 迁移：A 移除 → B 挂载 ----
      winA.removeBrowserView(view);
      await wait(100);
      check('view detached from A', winA.getBrowserViews().length === 0, { aViews: winA.getBrowserViews().length });
      check('webContents alive while detached', !view.webContents.isDestroyed());

      winB.addBrowserView(view);
      view.setBounds({ x: 0, y: 0, width: 700, height: 460 });
      await wait(400);

      const after = {
        wcId: view.webContents.id,
        pid: view.webContents.getOSProcessId(),
        navigationCount,
        hostWcId: view.webContents.hostWebContents ? view.webContents.hostWebContents.id : null,
        fromWebContentsWindowId: (() => {
          const w = require('electron').BrowserWindow.fromWebContents(view.webContents);
          return w ? w.id : null;
        })(),
        bViews: winB.getBrowserViews().length,
      };

      // 1. 渲染进程身份不变
      check('webContents.id stable across migration', before.wcId === after.wcId, { before, after });
      check('OS process id stable across migration', before.pid === after.pid, { beforePid: before.pid, afterPid: after.pid });

      // 2. 文档没有重新加载（marker 还在，且没有新的导航）
      const markerAfter = await view.webContents.executeJavaScript('window.__migrateMarker || ""').catch((e) => `ERR:${e.message}`);
      check('page document NOT reloaded (marker preserved)', markerAfter === 'kept', { markerAfter });
      check('no extra navigation during migration', after.navigationCount === before.navigationCount,
        { before: before.navigationCount, after: after.navigationCount });

      // 3. 监听器仍然有效：主动导航一次，确认事件仍触发
      await view.webContents.loadURL('data:text/html,<html><body><h1>after</h1></body></html>').catch(() => {});
      await waitFor(async () => after.navigationCount < navigationCount, { timeoutMs: 10_000, label: 'listener fired after migration' });
      check('wc listeners survive migration', navigationCount > after.navigationCount,
        { navigationCount, didNavigate: events.didNavigate });

      // 4. 新窗口能正常渲染
      const rendered = await view.webContents.executeJavaScript('document.querySelector("h1")?.textContent || ""').catch((e) => `ERR:${e.message}`);
      check('renders in new window', rendered === 'after', { rendered });
      check('new window has the view', after.bViews === 1, { bViews: after.bViews });

      // 5. 宿主反查跟随迁移
      check('hostWebContents follows migration (or fromWebContents resolves new window)',
        (after.hostWcId !== null && after.hostWcId === winB.webContents.id) || after.fromWebContentsWindowId === winB.id,
        { beforeHostWcId: before.hostWcId, afterHostWcId: after.hostWcId, expectedB: winB.webContents.id, afterFromWebContents: after.fromWebContentsWindowId });

      return {
        ok: failures.length === 0,
        summary: failures.length === 0
          ? 'migration viable: wc preserved, no reload, listeners intact'
          : `${failures.length} check(s) failed`,
        detail: { failures, before, after, events, markerAfter, rendered },
      };
    } finally {
      view.webContents.removeListener('did-start-loading', onLoading);
      view.webContents.removeListener('did-navigate', onNavigate);
      for (const w of [winA, winB]) {
        try { if (!w.isDestroyed()) w.removeBrowserView(view); } catch { /* ignore */ }
      }
      try { if (!view.webContents.isDestroyed()) view.webContents.destroy(); } catch { /* ignore */ }
      for (const w of [winA, winB]) {
        try { if (!w.isDestroyed()) w.destroy(); } catch { /* ignore */ }
      }
    }
  },
};
