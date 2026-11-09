// Probe 39 · P1 可行性：多窗口注册表与生命周期
//
// 验证「一进程多窗口」在 Electron 11 是否真的成立，以及我们准备依赖的
// 归属判定手段是否可靠：
//   1. 两个 BrowserWindow 可同时存在，且各自的 BrowserView 独立。
//   2. BrowserWindow.fromWebContents(view.webContents) 能否反查宿主窗口
//      （P1 的 getWindowForWebContents 依赖它；若为 null 必须改用
//       wc.hostWebContents）。
//   3. 关闭其中一个窗口后，另一个仍存活；window-all-closed 只在最后关闭时触发。
//   4. 隐藏窗口（用户脚本 @background 场景）不会被误当作浏览器窗口。
'use strict';

const { wait } = require('../lib/timeout.cjs');

module.exports = {
  id: '39-multi-window',
  name: 'P1 multi-window registry & lifecycle',
  needsElectron: true,
  timeoutMs: 60_000,

  async run(ctx) {
    const { app, BrowserWindow, BrowserView } = ctx.electron;

    const failures = [];
    const check = (name, ok, detail) => { if (!ok) failures.push({ name, detail }); };

    let allClosedCount = 0;
    const onAllClosed = () => { allClosedCount += 1; };
    app.on('window-all-closed', onAllClosed);

    const makeWindow = () => new BrowserWindow({
      show: false,
      width: 640,
      height: 480,
      webPreferences: { nodeIntegration: false, contextIsolation: true, spellcheck: false },
    });

    const winA = makeWindow();
    const winB = makeWindow();
    // 模拟 userscripts @background 的隐藏窗口：它也在 getAllWindows() 里，
    // 但绝不能被当作浏览器窗口。
    const hiddenWin = new BrowserWindow({ show: false, width: 200, height: 120, webPreferences: { nodeIntegration: false } });

    const viewA = new BrowserView({ webPreferences: { partition: 'persist:probe-mw' } });
    const viewB = new BrowserView({ webPreferences: { partition: 'persist:probe-mw' } });

    try {
      winA.addBrowserView(viewA);
      winB.addBrowserView(viewB);
      viewA.setBounds({ x: 0, y: 0, width: 640, height: 440 });
      viewB.setBounds({ x: 0, y: 0, width: 600, height: 400 });

      await Promise.all([
        viewA.webContents.loadURL('data:text/html,<html><body><h1>A</h1></body></html>').catch(() => {}),
        viewB.webContents.loadURL('data:text/html,<html><body><h1>B</h1></body></html>').catch(() => {}),
      ]);

      // 1. 两个窗口 / 两个视图同时存在
      check('two windows alive', !winA.isDestroyed() && !winB.isDestroyed());
      check('each window has exactly one view',
        winA.getBrowserViews().length === 1 && winB.getBrowserViews().length === 1,
        { a: winA.getBrowserViews().length, b: winB.getBrowserViews().length });
      check('views are distinct webContents', viewA.webContents.id !== viewB.webContents.id,
        { a: viewA.webContents.id, b: viewB.webContents.id });

      // 2. 归属反查能力（P1 关键依赖）
      const viaFromWebContents = BrowserWindow.fromWebContents(viewA.webContents);
      const viaHostWebContents = viewA.webContents.hostWebContents;
      const reverse = {
        fromWebContents_A: viaFromWebContents ? viaFromWebContents.id : null,
        fromWebContents_expected: winA.id,
        fromWebContents_matches: Boolean(viaFromWebContents && viaFromWebContents.id === winA.id),
        hostWebContentsId: viaHostWebContents ? viaHostWebContents.id : null,
        hostWebContents_matchesShell: Boolean(viaHostWebContents && viaHostWebContents.id === winA.webContents.id),
        getAllWindowsCount: BrowserWindow.getAllWindows().length,
      };
      check('can resolve owning window from a BrowserView webContents',
        reverse.fromWebContents_matches || reverse.hostWebContents_matchesShell, reverse);

      // 3. 隐藏窗口会被 getAllWindows() 混入 —— 证明不能用它枚举浏览器窗口
      check('getAllWindows includes hidden background windows (so registry is required)',
        reverse.getAllWindowsCount >= 3, reverse);

      // 4. 关闭一个窗口不影响另一个；window-all-closed 尚未触发
      winB.destroy();
      await wait(300);
      check('closing B keeps A alive', !winA.isDestroyed());
      check('window-all-closed not fired while A remains', allClosedCount === 0, { allClosedCount });
      const remainingViewStillWorks = await viewA.webContents.executeJavaScript('document.querySelector("h1")?.textContent || ""')
        .catch((e) => `ERR:${e.message}`);
      check('A view still renders after B closed', remainingViewStillWorks === 'A', { remainingViewStillWorks });

      // 5. 最后关闭时 window-all-closed 才触发
      hiddenWin.destroy();
      winA.destroy();
      await wait(500);
      check('window-all-closed fires after the last window closes', allClosedCount >= 1, { allClosedCount });

      return {
        ok: failures.length === 0,
        summary: failures.length === 0 ? 'multi-window + lifecycle viable' : `${failures.length} check(s) failed`,
        detail: { failures, reverse, allClosedCount },
      };
    } finally {
      app.removeListener('window-all-closed', onAllClosed);
      for (const [w, v] of [[winA, viewA], [winB, viewB]]) {
        try { if (!w.isDestroyed()) w.removeBrowserView(v); } catch { /* ignore */ }
        try { if (!v.webContents.isDestroyed()) v.webContents.destroy(); } catch { /* ignore */ }
        try { if (!w.isDestroyed()) w.destroy(); } catch { /* ignore */ }
      }
      try { if (!hiddenWin.isDestroyed()) hiddenWin.destroy(); } catch { /* ignore */ }
      await wait(50);
    }
  },
};
