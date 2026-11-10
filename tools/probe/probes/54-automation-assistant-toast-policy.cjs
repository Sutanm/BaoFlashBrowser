// Probe 54 — 成功类动作不再弹通知（复制=按钮就地反馈），错误仍然要提示。
//
// 2026-11 用户反馈：点个复制按钮、选个游戏画面都往地址栏弹一条通知，太乱。
// 收敛后的策略：只有错误/警告走地址栏，成功类由界面自身表达；复制改成按钮闪一下「已复制」。
// 本探针用真实 production preload + 桩 IPC 数 toast 调用次数来守住这条策略。
'use strict';

const http = require('http');
const path = require('path');
const assert = require('assert');
const { waitFor, wait } = require('../lib/timeout.cjs');

const PACKAGE = { packageId: 'pkg-a', name: '斗地主', mainEntryId: 'workflow', assets: [], profiles: [], frontends: [] };
const SURFACE = { id: 'surface-1', kind: 'canvas', label: 'Game canvas', rect: { x: 0, y: 0, width: 640, height: 480 }, score: 9 };

module.exports = {
  id: '54-automation-assistant-toast-policy',
  name: 'no success toasts: copies flash in place, errors still toast',
  needsElectron: true,
  timeoutMs: 60000,
  async run(ctx) {
    const { BrowserWindow, BrowserView, ipcMain } = ctx.electron;
    const config = (event) => { event.returnValue = { ok: true, mode: 'ppapi', generation: 1, scripts: [], values: {}, resources: {} }; };
    const ruffle = (event) => { event.returnValue = { enabled: false }; };
    const toasts = [];
    ipcMain.on('userscript:get-config', config);
    ipcMain.on('get-ruffle-mode', ruffle);
    ipcMain.handle('ui:get-language', () => 'zh-CN');
    ipcMain.handle('automation-assistant:list', () => [PACKAGE]);
    ipcMain.handle('automation-assistant:status', () => ({
      state: 'idle', executedSteps: 0,
      logs: [{ timestamp: Date.now() - 2000, level: 'info', message: '第一行' }, { timestamp: Date.now() - 1000, level: 'success', message: '第二行' }],
    }));
    ipcMain.handle('automation-assistant:toast', (_event, payload) => { toasts.push(payload); return { success: true }; });
    ipcMain.handle('automation-assistant:logs-list', () => []);
    ipcMain.handle('automation-assistant:logs-read', () => []);
    // 主进程 surfaces 端点直接返回候选数组（assistant api 会缓存成 listPackages 的 bound）
    ipcMain.handle('automation-assistant:surfaces', () => [SURFACE]);
    // 捕获失败：用来确认"错误仍然会提示"没有被一起静音。
    ipcMain.handle('automation-assistant:capture', () => { throw new Error('capture failed on purpose'); });

    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html><body><canvas width="640" height="480"></canvas></body></html>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const host = new BrowserWindow({ show: false });
    let view;
    try {
      view = new BrowserView({ webPreferences: { preload: path.join(ctx.root, 'dist/webview-preload.js'), contextIsolation: true, nodeIntegration: false, partition: 'persist:probe-toast-policy' } });
      view.webContents.on('preload-error', (_e, _p, error) => console.error('native preload:', error));
      host.addBrowserView(view);
      view.setBounds({ x: 0, y: 0, width: 900, height: 650 });
      await view.webContents.loadURL(`http://127.0.0.1:${server.address().port}/`);
      const evaluate = (script) => view.webContents.executeJavaScript(script);
      await waitFor(() => evaluate("Boolean(document.querySelector('#bao-automation-frame-assistant .bao-orb'))"), { timeoutMs: 8000, label: 'native orb' });
      view.webContents.send('automation-assistant:show');
      await waitFor(() => evaluate("document.getElementById('bao-automation-frame-assistant').classList.contains('bao-open')"), { timeoutMs: 3000, label: 'open assistant' });
      await waitFor(() => evaluate("document.querySelectorAll('#bao-automation-frame-assistant .bao-log-row').length > 1"), { timeoutMs: 5000, intervalMs: 100, label: 'log rows rendered' });

      // 1) 复制运行记录：按钮就地变「已复制」，不产生通知
      await evaluate("document.querySelector('.bao-log-copy').click()");
      await waitFor(() => evaluate("document.querySelector('.bao-log-copy').textContent === '已复制'"), { timeoutMs: 3000, intervalMs: 50, label: 'copy button flashes' });
      assert.deepStrictEqual(toasts, [], '复制成功不应产生任何 toast: ' + JSON.stringify(toasts));
      assert(await evaluate("document.querySelector('.bao-log-copy').classList.contains('bao-flash')"), '复制按钮缺少 bao-flash 状态');
      // 隐藏窗口的后台定时器会被节流，复原时间放宽（断言的是"会复原"，不是精确时长）。
      await waitFor(() => evaluate("document.querySelector('.bao-log-copy').textContent === '复制'"), { timeoutMs: 8000, intervalMs: 100, label: 'copy button label restored' });

      // 2) 选择游戏画面：绑定成功不通知，且按钮/面板直接反映已绑定
      await evaluate("document.querySelector('.bao-game-select').click()");
      await waitFor(() => evaluate("document.querySelectorAll('.bao-game-option').length === 1"), { timeoutMs: 5000, intervalMs: 100, label: 'game candidates listed' });
      await evaluate("document.querySelector('.bao-game-option').click()");
      await waitFor(() => evaluate("document.querySelector('.bao-game-select').textContent.indexOf('已选择') === 0"), { timeoutMs: 3000, intervalMs: 100, label: 'surface bound in button' });
      assert.deepStrictEqual(toasts, [], '绑定游戏画面成功不应产生 toast: ' + JSON.stringify(toasts));

      // 3) 复制特征串：同样只做就地反馈
      await evaluate("document.querySelector('.bao-game-copy').click()");
      await waitFor(() => evaluate("document.querySelector('.bao-game-copy').textContent === '已复制'"), { timeoutMs: 3000, intervalMs: 50, label: 'feature copy flashes' });
      assert.deepStrictEqual(toasts, [], '复制特征串成功不应产生 toast: ' + JSON.stringify(toasts));

      // 4) 失败仍然要提示（错误不能被一起静音）
      await evaluate("document.querySelector('.bao-capture').click()");
      await waitFor(() => toasts.length > 0, { timeoutMs: 5000, intervalMs: 50, label: 'capture failure toasts' });
      assert(toasts.some((entry) => /capture failed on purpose/u.test(String(entry.message))), '捕获失败没有进入 toast: ' + JSON.stringify(toasts));

      return {
        ok: true,
        summary: 'copies and surface binding give in-place feedback only; capture failure still raises one toast',
        detail: { toasts },
      };
    } finally {
      if (view) { try { view.webContents.destroy(); } catch { /* gone */ } }
      host.destroy(); server.close();
      ipcMain.removeListener('userscript:get-config', config);
      ipcMain.removeListener('get-ruffle-mode', ruffle);
      for (const channel of ['ui:get-language', 'automation-assistant:list', 'automation-assistant:status', 'automation-assistant:toast', 'automation-assistant:logs-list', 'automation-assistant:logs-read', 'automation-assistant:surfaces', 'automation-assistant:capture']) ipcMain.removeHandler(channel);
    }
  },
};
