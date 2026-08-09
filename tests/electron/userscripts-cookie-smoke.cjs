// Smoke: GM_cookie 只读 list/get (Task 5)
// 页面经 Set-Cookie 落 cookie 到 persist 会话;fixture 脚本用 GM_cookie.list/get
// 读取并写进 GM_setValue;冒烟轮询断言;未放行域返回空数组。
const { app, BrowserView, BrowserWindow, ipcMain } = require('electron');
const http = require('http');
const path = require('path');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'WinUseBrowserSpellChecker');
app.on('window-all-closed', () => {});
app.setPath('userData', process.env.BAO_SMOKE_USER_DATA || path.join(app.getPath('appData'), 'bao-flash-browser'));

const failures = [];
function check(name, ok, detail) {
  console.log(`[cookie-smoke] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail) : ''}`);
  if (!ok) failures.push(name);
}

const FIXTURE = (base) => `// ==UserScript==
// @name         BaoFlash Cookie Demo
// @namespace    https://baoflash.local/cookie-demo
// @version      1.0.0
// @description  GM_cookie 只读冒烟
// @match        *://*/*
// @connect      127.0.0.1
// @grant        GM_cookie
// @grant        GM_setValue
// @run-at       document-end
// ==/UserScript==
(function () {
  'use strict';
  GM_cookie.list({ url: '${base}/x' }, function (cookies) {
    GM_setValue('cookies', JSON.stringify((cookies || []).map(function (c) { return c.name; })));
    GM_setValue('cookie-value', (cookies || []).length > 0 ? cookies[0].value : 'NONE');
  });
  GM_cookie.get({ url: '${base}/x', name: 'demo' }, function (cookie) {
    GM_setValue('got', cookie ? cookie.value : 'MISSING');
  });
  GM_cookie.list({ url: 'https://evil.example/' }, function (cookies) {
    GM_setValue('evil', JSON.stringify((cookies || []).map(function (c) { return c.name; })));
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

  const srv = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': 'demo=hello; Path=/',
    });
    res.end('<!doctype html><html><body>cookie page</body></html>');
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
  ipcMain.on('userscript:menu-register', () => {});
  ipcMain.on('userscript:log', () => {});
  ipcMain.handle('userscript:cookie-list', async (event, raw) => {
    const active = manager;
    const service = mod.getCookieService();
    if (!active || !service) return { ok: false, error: 'not-ready' };
    const metadata = active.getScriptMetadata(raw?.scriptId);
    if (!metadata) return { ok: false, error: 'invalid-arguments' };
    return service.list(event.sender.id, raw.scriptId, raw.pageUrl ?? '', metadata.metadata.connect,
      { url: raw.url, domain: raw.domain, name: raw.name });
  });
  ipcMain.handle('userscript:cookie-get', async (event, raw) => {
    const active = manager;
    const service = mod.getCookieService();
    if (!active || !service) return { ok: false, error: 'not-ready' };
    const metadata = active.getScriptMetadata(raw?.scriptId);
    if (!metadata) return { ok: false, error: 'invalid-arguments' };
    return service.get(event.sender.id, raw.scriptId, raw.pageUrl ?? '', metadata.metadata.connect,
      { url: raw.url, name: raw.name });
  });

  // 安装 fixture 并加载页面(Set-Cookie 落 persist 会话)
  const installed = mod.installUserscript(FIXTURE(base));
  check('install cookie fixture', installed.ok === true, installed.ok ? installed.script.id : installed);
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
      // 必须与 GmCookieService 的 'persist:' 一致,cookie 才在同一会话里
      partition: 'persist:',
    },
  });
  host.addBrowserView(view);
  view.setBounds({ x: 0, y: 0, width: 600, height: 400 });
  manager.registerView(view.webContents.id, { mode: 'ppapi', generation: 1, token: 'cookie' });
  await view.webContents.loadURL(base + '/');
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const cookies = await waitFor(() => manager.getValuesFor(view.webContents.id, fixtureId)['cookies'], 5000);
  check('GM_cookie.list returns the demo cookie', cookies === '["demo"]', cookies);
  const cookieValue = manager.getValuesFor(view.webContents.id, fixtureId)['cookie-value'];
  check('cookie value read back', cookieValue === 'hello', cookieValue);
  const got = await waitFor(() => manager.getValuesFor(view.webContents.id, fixtureId)['got'], 5000);
  check('GM_cookie.get returns the demo cookie', got === 'hello', got);
  const evil = await waitFor(() => manager.getValuesFor(view.webContents.id, fixtureId)['evil'], 5000);
  check('unlisted host returns empty (connect-denied)', evil === '[]', evil);

  mod.uninstallUserscript(fixtureId);
  host.destroy();
  srv.close();
  console.log(`[cookie-smoke] ${failures.length === 0 ? 'ALL PASS' : 'FAILURES: ' + failures.join(', ')}`);
  app.exit(failures.length === 0 ? 0 : 1);
});
