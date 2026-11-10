// Probe 53 — 运行历史按脚本隔离（原生助手形态，真实 production preload）。
//
// 2026-11：历史列表此前是全局的（automation-logs 下所有文件），选中哪个脚本都一样。
// 现在默认只看当前脚本（按日志首行的 packageId 归属），顶部可切「全部脚本」。
// 本探针用桩 IPC 冒充主进程，只验证 UI↔IPC 契约与切换行为：
//   1. 打开「运行历史」默认发 logs-list 时带 packageId/packageName；
//   2. 列表只渲染该脚本的运行，「当前脚本」按钮高亮，行内不再重复脚本名；
//   3. 切「全部脚本」→ 不带过滤参数，能列出别的脚本并显示脚本名；
//   4. 切回「当前脚本」→ 过滤参数回来。
'use strict';

const http = require('http');
const path = require('path');
const assert = require('assert');
const { waitFor } = require('../lib/timeout.cjs');

const PACKAGE = { packageId: 'pkg-a', name: '斗地主', mainEntryId: 'workflow', assets: [], profiles: [], frontends: [] };
const LOG_A = { name: '260110-12-00-斗地主-记录1.json', sizeLabel: '1.2 KB', scriptName: '斗地主', startedAt: 1700000200000, packageId: 'pkg-a', identity: 'meta' };
const LOG_A2 = { name: '260110-11-00-斗地主-记录1.json', sizeLabel: '0.8 KB', scriptName: '斗地主', startedAt: 1700000100000, packageId: 'pkg-a', identity: 'meta' };
const LOG_B = { name: '260110-10-00-麻将-记录1.json', sizeLabel: '2.0 KB', scriptName: '麻将', startedAt: 1700000000000, packageId: 'pkg-b', identity: 'meta' };

module.exports = {
  id: '53-automation-history-scope',
  name: 'run history scoped to the selected script (native assistant)',
  needsElectron: true,
  timeoutMs: 60000,
  async run(ctx) {
    const { BrowserWindow, BrowserView, ipcMain } = ctx.electron;
    const config = (event) => { event.returnValue = { ok: true, mode: 'ppapi', generation: 1, scripts: [], values: {}, resources: {} }; };
    const ruffle = (event) => { event.returnValue = { enabled: false }; };
    const logListPayloads = [];
    ipcMain.on('userscript:get-config', config);
    ipcMain.on('get-ruffle-mode', ruffle);
    ipcMain.handle('ui:get-language', () => 'zh-CN');
    ipcMain.handle('automation-assistant:list', () => [PACKAGE]);
    ipcMain.handle('automation-assistant:status', () => ({ state: 'idle', executedSteps: 0, logs: [] }));
    ipcMain.handle('automation-assistant:logs-list', (_event, payload) => {
      logListPayloads.push(payload);
      // 与主进程一致：带 packageId 时只返回该脚本的运行
      return payload && payload.packageId ? [LOG_A, LOG_A2] : [LOG_A, LOG_A2, LOG_B];
    });
    ipcMain.handle('automation-assistant:logs-read', () => [
      { timestamp: 1700000200000, level: 'info', message: '开始运行' },
      { timestamp: 1700000201000, level: 'success', message: '完成一步' },
    ]);

    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html><body><canvas width="640" height="480"></canvas></body></html>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const host = new BrowserWindow({ show: false });
    let view;
    try {
      view = new BrowserView({ webPreferences: { preload: path.join(ctx.root, 'dist/webview-preload.js'), contextIsolation: true, nodeIntegration: false, partition: 'persist:probe-history-scope' } });
      view.webContents.on('preload-error', (_e, _p, error) => console.error('native preload:', error));
      host.addBrowserView(view);
      view.setBounds({ x: 0, y: 0, width: 900, height: 650 });
      await view.webContents.loadURL(`http://127.0.0.1:${server.address().port}/`);
      const evaluate = (script) => view.webContents.executeJavaScript(script);
      await waitFor(() => evaluate("Boolean(document.querySelector('#bao-automation-frame-assistant .bao-orb'))"), { timeoutMs: 8000, label: 'native orb' });
      view.webContents.send('automation-assistant:show');
      await waitFor(() => evaluate("document.getElementById('bao-automation-frame-assistant').classList.contains('bao-open')"), { timeoutMs: 3000, label: 'open assistant' });
      await waitFor(() => evaluate('Boolean(document.querySelector(\'.bao-archive-toggle\'))'), { timeoutMs: 3000, label: 'history toggle present' });

      const rows = () => evaluate("document.querySelectorAll('#bao-automation-history-layer .bao-history-file').length");
      const rowTitles = () => evaluate("Array.prototype.map.call(document.querySelectorAll('#bao-automation-history-layer .bao-history-file b'), function (el) { return el.textContent; })");
      const scopeState = () => evaluate("({ current: document.querySelector('.bao-history-scope-current').classList.contains('bao-active'), all: document.querySelector('.bao-history-scope-all').classList.contains('bao-active') })");

      await evaluate("document.querySelector('.bao-archive-toggle').click()");
      await waitFor(async () => (await rows()) === 2, { timeoutMs: 5000, intervalMs: 100, label: 'history rows scoped to current script' });
      const scoped = await scopeState();
      assert.deepStrictEqual(scoped, { current: true, all: false }, '当前脚本 not highlighted by default');
      const scopedPayload = logListPayloads[logListPayloads.length - 1];
      assert.strictEqual(scopedPayload.packageId, PACKAGE.packageId, 'logs-list 未带 packageId');
      assert.strictEqual(scopedPayload.packageName, PACKAGE.name, 'logs-list 未带 packageName');
      assert.deepStrictEqual(await rowTitles(), [], '当前脚本范围下不应重复显示脚本名');

      await evaluate("document.querySelector('.bao-history-scope-all').click()");
      await waitFor(async () => (await rows()) === 3, { timeoutMs: 5000, intervalMs: 100, label: 'history rows for all scripts' });
      assert.deepStrictEqual(await scopeState(), { current: false, all: true }, '全部脚本 not highlighted after switching');
      const allPayload = logListPayloads[logListPayloads.length - 1];
      assert.strictEqual(allPayload.packageId, undefined, '全部脚本不该带 packageId');
      assert.deepStrictEqual(await rowTitles(), ['斗地主', '斗地主', '麻将'], '全部脚本范围下应显示每个脚本名');

      await evaluate("document.querySelector('.bao-history-scope-current').click()");
      await waitFor(async () => (await rows()) === 2, { timeoutMs: 5000, intervalMs: 100, label: 'history rows back to current script' });
      assert.strictEqual(logListPayloads[logListPayloads.length - 1].packageId, PACKAGE.packageId, '切回当前脚本未重新带过滤');

      return {
        ok: true,
        summary: 'history scoped to selected script by default, 「全部脚本」lists every script, payload carries packageId only when scoped',
        detail: { logListPayloads },
      };
    } finally {
      if (view) { try { view.webContents.destroy(); } catch { /* gone */ } }
      host.destroy(); server.close();
      ipcMain.removeListener('userscript:get-config', config);
      ipcMain.removeListener('get-ruffle-mode', ruffle);
      for (const channel of ['ui:get-language', 'automation-assistant:list', 'automation-assistant:status', 'automation-assistant:logs-list', 'automation-assistant:logs-read']) ipcMain.removeHandler(channel);
    }
  },
};
