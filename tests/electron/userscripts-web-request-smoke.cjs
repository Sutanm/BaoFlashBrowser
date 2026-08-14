// Smoke: GM_webRequest 仅观察 (Task 6)
// before-request:直接注入 observer.notifyBeforeRequest 断言 @match 过滤 + URL 脱敏;
// completed:页面真实加载触发 session onCompleted 监听 → 脚本回调收到事件。
const { app, BrowserView, BrowserWindow, ipcMain, session } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'WinUseBrowserSpellChecker');
app.on('window-all-closed', () => {});
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'userscripts-web-request-'));
app.setPath('userData', USER_DATA);

const failures = [];
function check(name, ok, detail) {
  console.log(`[wr-smoke] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail) : ''}`);
  if (!ok) failures.push(name);
}

const FIXTURE = `// ==UserScript==
// @name         BaoFlash WebRequest Demo
// @namespace    https://baoflash.local/wr-demo
// @version      1.0.0
// @description  GM_webRequest 仅观察冒烟
// @match        http://127.0.0.1/*
// @grant        GM_webRequest
// @grant        GM_setValue
// @run-at       document-end
// ==/UserScript==
(function () {
  'use strict';
  GM_webRequest({
    onBeforeRequest: function (e) { GM_setValue('wr-before', JSON.stringify(e)); },
    onCompleted: function (e) { GM_setValue('wr-complete', JSON.stringify(e)); },
  });
})();
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(probe, timeoutMs, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

app.whenReady().then(async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../../release/tests/userscripts-admin-module.cjs');
  mod.initUserscriptManager();
  const manager = mod.getUserscriptManager();
  const observer = mod.getWebRequestObserver();

  const srv = http.createServer((req, res) => {
    if (req.url === '/page.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>wr</title></head><body><img src="/api/data?x=1" /></body></html>');
    } else {
      // 延迟响应:确保 document-end 的 GM_webRequest 注册先于 completed 事件
      // (页面资源可能在脚本注册前就完成,导致事件丢失的竞态)
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      }, 800);
    }
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${srv.address().port}`;

  ipcMain.on('userscript:get-config', (event, payload) => {
    event.returnValue = manager.snapshotFor(event.sender.id, payload?.url ?? '', Boolean(payload?.isMainFrame));
  });
  ipcMain.on('userscript:report', (event, payload) => {
    manager.acceptReport(event.sender.id, payload);
  });
  ipcMain.on('userscript:set-value', (event, payload) => {
    if (manager && manager.isScriptInstalled(payload?.scriptId) && payload?.key) {
      manager.setValue(event.sender.id, payload.scriptId, payload.key, payload.value);
    }
  });
  ipcMain.on('userscript:web-request-register', (event, payload) => {
    observer.register({ wcId: event.sender.id, documentId: payload.documentId, scriptId: payload.scriptId });
  });
  ipcMain.on('userscript:web-request-unregister', (event, payload) => {
    observer.unregister(event.sender.id, payload.documentId, payload.scriptId);
  });
  ipcMain.on('userscript:menu-register', () => {});
  ipcMain.on('userscript:log', () => {});
  ipcMain.handle('userscript:automation-list', async () => []);
  ipcMain.handle('userscript:automation-status', async () => ({ state: 'idle', executedSteps: 0, logs: [] }));

  // 真实 onCompleted/onErrorOccurred 监听注册到 persist 会话
  observer.attach(session.fromPartition('persist:'));

  const installed = mod.installUserscript(FIXTURE);
  check('install web-request fixture', installed.ok === true, installed.ok ? installed.script.id : installed);
  const fixtureId = installed.ok ? installed.script.id : 'missing';

  const host = new BrowserWindow({ show: false, width: 600, height: 400, webPreferences: { nodeIntegration: false, contextIsolation: true, spellcheck: false } });
  const view = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'release', 'tests', 'userscript-runtime-preload.cjs'),
      plugins: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      spellcheck: false,
      partition: 'persist:',
    },
  });
  host.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, width: 600, height: 400 });
  manager.registerView(view.webContents.id, { mode: 'ppapi', generation: 1, token: 'wr' });
  await view.webContents.loadURL(base + '/page.html');
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // before-request:注入事件断言 @match 过滤 + query 脱敏
  observer.notifyBeforeRequest({ webContentsId: view.webContents.id, url: `${base}/api/data?token=secret`, method: 'GET' });
  observer.notifyBeforeRequest({ webContentsId: view.webContents.id, url: 'https://unmatched.example/api?x=1', method: 'GET' }); // 不匹配 @match → 不应到达
  const before = await waitFor(() => manager.getValuesFor(view.webContents.id, fixtureId)['wr-before'], 5000);
  check('before-request delivered', typeof before === 'string' && before.includes('before-request'), before);
  const redacted = before ? JSON.parse(before) : null;
  check('before-request url redacted', redacted && redacted.url === `${base}/api/data?<redacted>`, redacted && redacted.url);
  check('before-request not delivered for unmatched host', before !== null && !before.includes('unmatched.example'), before);

  // completed:真实页面请求(/api/data?x=1)经 session onCompleted 到达
  const complete = await waitFor(() => manager.getValuesFor(view.webContents.id, fixtureId)['wr-complete'], 8000);
  check('completed delivered via real session listener', typeof complete === 'string' && complete.includes('completed'), complete);
  const completeEvent = complete ? JSON.parse(complete) : null;
  check('completed statusCode present', completeEvent && typeof completeEvent.statusCode === 'number' && completeEvent.statusCode === 200, completeEvent && completeEvent.statusCode);

  mod.uninstallUserscript(fixtureId);
  host.destroy();
  srv.close();
  try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log(`[wr-smoke] ${failures.length === 0 ? 'ALL PASS' : 'FAILURES: ' + failures.join(', ')}`);
  app.exit(failures.length === 0 ? 0 : 1);
});
