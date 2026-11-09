// Probe 44 · P2 可行性：BrowserView 的 sender 能否反查所属窗口
//
// P2 要把 IPC 从「全局单例」改成「按 event.sender 路由到窗口」。前提是
// 主进程能从 sender（WebContents）稳定找到它所属的窗口，并且能区分
// 外壳 renderer / 标签页 BrowserView / 用户脚本后台隐藏窗口。
//
// 注：contextIsolation 下页面拿不到 ipcRenderer，因此这里直接在主进程侧
// 用等价的 sender 解析逻辑断言路由结果，而不是真发一次 IPC。
'use strict';

module.exports = {
  id: '44-ipc-sender-routing',
  name: 'P2 IPC sender → window routing',
  needsElectron: true,
  timeoutMs: 45_000,

  async run(ctx) {
    const { BrowserWindow, BrowserView } = ctx.electron;
    const failures = [];
    const check = (name, ok, detail) => { if (!ok) failures.push({ name, detail }); };

    const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { nodeIntegration: false, contextIsolation: true } });
    const view = new BrowserView({ webPreferences: { partition: 'persist:probe-ipc', contextIsolation: true, nodeIntegration: false } });
    // 模拟 userscripts @background 的隐藏窗口
    const hidden = new BrowserWindow({ show: false, width: 200, height: 150, webPreferences: { nodeIntegration: false, contextIsolation: true } });
    win.addBrowserView(view);
    view.setBounds({ x: 0, y: 0, width: 800, height: 560 });

    try {
      await Promise.all([
        win.webContents.loadURL('data:text/html,<html><body>shell</body></html>').catch(() => {}),
        view.webContents.loadURL('data:text/html,<html><body>view</body></html>').catch(() => {}),
        hidden.webContents.loadURL('data:text/html,<html><body>bg</body></html>').catch(() => {}),
      ]);

      const route = (sender) => {
        const fromWc = BrowserWindow.fromWebContents(sender);
        const host = sender.hostWebContents || null;
        return {
          wcId: sender.id,
          fromWebContentsWindowId: fromWc ? fromWc.id : null,
          hostWebContentsId: host ? host.id : null,
          hostMatchesWin: host ? host.id === win.webContents.id : null,
          isShell: sender.id === win.webContents.id,
          isView: sender.id === view.webContents.id,
          isHidden: sender.id === hidden.webContents.id,
        };
      };

      const shellRoute = route(win.webContents);
      const viewRoute = route(view.webContents);
      const hiddenRoute = route(hidden.webContents);

      check('shell sender resolves to its own window', shellRoute.fromWebContentsWindowId === win.id, shellRoute);
      check('view sender attributable to owning window',
        viewRoute.hostMatchesWin === true || viewRoute.fromWebContentsWindowId === win.id, viewRoute);
      check('hidden background window distinguishable from browser windows',
        hiddenRoute.isHidden === true && hiddenRoute.isShell === false && hiddenRoute.isView === false, hiddenRoute);

      const frameInfo = {
        mainFrameSupported: win.webContents.mainFrame !== undefined,
        // Electron 11 没有 WebFrameMain / event.senderFrame（12 才引入），
        // 因此 P2 只能依赖 event.sender（WebContents），不能靠 senderFrame。
        senderFrameSupported: win.webContents.mainFrame !== undefined,
        viewFromWebContents: BrowserWindow.fromWebContents(view.webContents)?.id ?? null,
        shellFromWebContents: BrowserWindow.fromWebContents(win.webContents)?.id ?? null,
      };
      check('electron11: senderFrame 不可用属预期（记录为约束而非失败）',
        frameInfo.senderFrameSupported === false, frameInfo);
      check('BrowserWindow.fromWebContents resolves BrowserView owner',
        frameInfo.viewFromWebContents === win.id, frameInfo);

      return {
        ok: failures.length === 0,
        summary: failures.length === 0
          ? 'sender → window routing resolvable (shell / view / hidden)'
          : `${failures.length} check(s) failed`,
        detail: {
          failures,
          shellRoute,
          viewRoute,
          hiddenRoute,
          frameInfo,
          recommendation: viewRoute.hostMatchesWin === true
            ? 'primary: wc.hostWebContents; fallback: BrowserWindow.fromWebContents'
            : 'must keep an explicit webContents-id → window registry',
        },
      };
    } finally {
      for (const [w, v] of [[win, view]]) {
        try { if (!w.isDestroyed()) w.removeBrowserView(v); } catch { /* ignore */ }
        try { if (!v.webContents.isDestroyed()) v.webContents.destroy(); } catch { /* ignore */ }
        try { if (!w.isDestroyed()) w.destroy(); } catch { /* ignore */ }
      }
      try { if (!hidden.isDestroyed()) hidden.destroy(); } catch { /* ignore */ }
    }
  },
};
