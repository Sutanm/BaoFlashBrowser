// Probe 38 · Electron 11 API 可用性基线（多窗口改造的硬前提）
//
// 目的：动手前确认本项目锁定的 Electron 11.5.0 实际提供哪些 API。
// 多窗口方案依赖的能力逐个检查，缺失项直接判定对应阶段不可行。
//
// 关键预期（来自官方版本历史）：
//   - `setWindowOpenHandler` 是 Electron 12 引入的，Electron 11 必须继续用
//     `new-window` 事件（与 tabs.ts 现有实现一致）。
//   - WebContentsView / contentView 体系是 Electron 30 才有的，此处应为不存在。
'use strict';

module.exports = {
  id: '38-electron11-api',
  name: 'Electron 11 API surface (multi-window prerequisites)',
  needsElectron: true,
  timeoutMs: 20_000,

  async run(ctx) {
    const { app, BrowserWindow, BrowserView } = ctx.electron;
    const versions = process.versions;
    const electronMajor = String(versions.electron || '').split('.')[0];

    const win = new BrowserWindow({ show: false, width: 400, height: 300 });
    const wc = win.webContents;
    const view = new BrowserView({ webPreferences: { partition: 'persist:probe-api' } });
    win.addBrowserView(view);
    const viewWc = view.webContents;

    try {
      // 多窗口强依赖的 API。缺任何一项，对应阶段就必须换方案。
      const required = [
        ['BrowserWindow.fromWebContents', typeof BrowserWindow.fromWebContents === 'function'],
        ['win.addBrowserView', typeof win.addBrowserView === 'function'],
        ['win.removeBrowserView', typeof win.removeBrowserView === 'function'],
        ['win.getBrowserViews', typeof win.getBrowserViews === 'function'],
        ['win.getBounds', typeof win.getBounds === 'function'],
        ['win.setBounds', typeof win.setBounds === 'function'],
        ['win.getNativeWindowHandle', typeof win.getNativeWindowHandle === 'function'],
        ['win.isDestroyed', typeof win.isDestroyed === 'function'],
        ['BrowserView.setBounds', typeof view.setBounds === 'function'],
        ['BrowserView.setAutoResize', typeof view.setAutoResize === 'function'],
        ['app.requestSingleInstanceLock', typeof app.requestSingleInstanceLock === 'function'],
        ['screen.getCursorScreenPoint', (() => { try { return typeof require('electron').screen.getCursorScreenPoint === 'function'; } catch { return false; } })()],
        ['screen.getDisplayMatching', (() => { try { return typeof require('electron').screen.getDisplayMatching === 'function'; } catch { return false; } })()],
        ['wc.getOSProcessId', typeof viewWc.getOSProcessId === 'function'],
        ['wc.debugger.attach', typeof viewWc.debugger?.attach === 'function'],
        ['wc.sendInputEvent', typeof viewWc.sendInputEvent === 'function'],
        ['wc.isDestroyed', typeof viewWc.isDestroyed === 'function'],
        ['wc.hostWebContents', 'hostWebContents' in viewWc],
        ['wc.executeJavaScript', typeof viewWc.executeJavaScript === 'function'],
        ['wc.capturePage', typeof viewWc.capturePage === 'function'],
      ];

      // 这些是更高版本才有；本项目实现必须绕开。
      const mustBeAbsent = [
        ['wc.setWindowOpenHandler (Electron 12+)', typeof viewWc.setWindowOpenHandler === 'undefined'],
        ['win.contentView / WebContentsView (Electron 30+)', win.contentView === undefined],
      ];

      // BrowserView.setAutoResize 的 x/y 在 Electron 11 是否被接受（不抛错不代表生效）。
      let autoResizeAcceptsXY = null;
      try {
        view.setAutoResize({ width: true, height: true, x: true, y: true });
        autoResizeAcceptsXY = 'no throw';
      } catch (error) {
        autoResizeAcceptsXY = `throw: ${error instanceof Error ? error.message : String(error)}`;
      }

      const hostWc = {
        shellWcId: wc.id,
        viewWcId: viewWc.id,
        hostWebContentsId: viewWc.hostWebContents ? viewWc.hostWebContents.id : null,
        hostIsShell: viewWc.hostWebContents ? viewWc.hostWebContents.id === wc.id : null,
        // 关键：BrowserView 的 wc 能否反查出宿主窗口
        fromWebContents_viewReturnsWindow: BrowserWindow.fromWebContents(viewWc) !== null,
        fromWebContents_shellReturnsWindow: BrowserWindow.fromWebContents(wc) !== null,
      };

      const missing = required.filter(([, ok]) => !ok).map(([name]) => name);
      const unexpected = mustBeAbsent.filter(([, ok]) => !ok).map(([name]) => name);

      const ok = electronMajor === '11' && missing.length === 0 && unexpected.length === 0;
      return {
        ok,
        summary: ok
          ? `Electron ${versions.electron} · ${required.length} APIs present`
          : `electron=${versions.electron} missing=[${missing.join(', ')}] unexpected=[${unexpected.join(', ')}]`,
        detail: {
          versions: { electron: versions.electron, chrome: versions.chrome, node: versions.node },
          required,
          mustBeAbsent,
          autoResizeAcceptsXY,
          hostWc,
        },
      };
    } finally {
      try { win.removeBrowserView(view); } catch { /* ignore */ }
      try { if (!viewWc.isDestroyed()) viewWc.destroy(); } catch { /* ignore */ }
      try { if (!win.isDestroyed()) win.destroy(); } catch { /* ignore */ }
    }
  },
};
