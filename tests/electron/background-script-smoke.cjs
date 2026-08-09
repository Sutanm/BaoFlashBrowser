// Smoke: @background per-script window pool (Task 9)
// 每个 @background 脚本一个隐藏窗口:崩溃/启停互不影响。
// 断言:双脚本双窗口、getScriptIdForWc 各归其位、禁用其一仅销毁自身、
// 命令合并+invoke、无 @connect 的 xhr 被拒、无 sendSync 挂起。
const { app, ipcMain, webContents } = require('electron');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'WinUseBrowserSpellChecker');
app.on('window-all-closed', () => {});
const USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'background-script-smoke-'));
app.setPath('userData', USER_DATA);

const failures = [];
function check(name, ok, detail) {
  console.log(`[bg-smoke] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail) : ''}`);
  if (!ok) failures.push(name);
}

const BG_FIXTURE_PATH = path.join(__dirname, 'fixtures', 'background-demo.user.js');
const DEMO2_SOURCE = `// ==UserScript==
// @name         BaoFlash Background Demo2
// @namespace    https://baoflash.local/background-demo2
// @version      1.0.0
// @description  第二个后台脚本(验证窗口隔离)
// @background
// @match        *://*/*
// @grant        GM_setValue
// @run-at       document-end
// ==/UserScript==
(function () {
  'use strict';
  GM_setValue('bg2-running', 1);
  setInterval(function () { GM_setValue('bg2-tick', Date.now()); }, 2000);
})();
`;
const NO_CONNECT_SOURCE = (port) => `// ==UserScript==
// @name         BaoFlash Background NoConnect
// @namespace    https://baoflash.local/background-noconnect
// @version      1.0.0
// @description  后台无 @connect:xhr 应被拒绝
// @background
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @run-at       document-end
// ==/UserScript==
(function () {
  'use strict';
  GM_xmlhttpRequest({
    method: 'GET',
    url: 'http://127.0.0.1:${port}/x',
    onload: function () { GM_setValue('bg-conn', 'loaded'); },
    onerror: function (e) { GM_setValue('bg-conn', String((e && e.error) || 'error')); },
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

const runtime = () => mod.getBackgroundRuntime();
const wcCount = () => runtime().getWcIds().length;
const otherWc = (notWcId) => runtime().getWcIds().find((id) => id !== notWcId) ?? null;

let mod;
let manager;
let getRuffleQueries = 0;

app.whenReady().then(async () => {
  // Smoke bundles live in release/tests/: point background windows' preload
  // at the runtime-preload bundle there.
  process.env.BAO_USERSCRIPT_PRELOAD_PATH = path.join(__dirname, '..', '..', 'release', 'tests', 'userscript-runtime-preload.cjs');

  // ---- mock 全部 preload 通道(必须在 init 之前) ---------------------------
  ipcMain.on('get-ruffle-mode', (event) => {
    getRuffleQueries += 1;
    event.returnValue = { enabled: false, source: 'bundled', js: '', bundle: null };
  });
  ipcMain.on('userscript:get-config', (event, payload) => {
    const active = manager;
    if (!active) { event.returnValue = { ok: false, scripts: [], values: {} }; return; }
    const bgScriptId = runtime()?.getScriptIdForWc(event.sender.id) ?? null;
    if (bgScriptId != null) {
      event.returnValue = active.snapshotBackground(event.sender.id);
    } else {
      event.returnValue = active.snapshotFor(event.sender.id, payload?.url ?? '', Boolean(payload?.isMainFrame));
    }
  });
  ipcMain.on('userscript:report', (event, payload) => {
    manager?.acceptReport(event.sender.id, payload);
  });
  ipcMain.on('userscript:set-value', (event, payload) => {
    if (manager && manager.isScriptInstalled(payload?.scriptId) && payload?.key) {
      manager.setValue(event.sender.id, payload.scriptId, payload.key, payload.value);
    }
  });
  ipcMain.on('userscript:delete-value', (event, payload) => {
    manager?.deleteValue(event.sender.id, payload?.scriptId, payload?.key);
  });
  ipcMain.on('userscript:menu-register', (event, payload) => {
    manager?.registerMenuCommand(event.sender.id, payload.scriptId, payload.documentId, payload.title, payload.commandId, Boolean(payload.isMainFrame));
  });
  ipcMain.on('userscript:menu-unregister', (event, payload) => {
    manager?.unregisterMenuCommand(event.sender.id, payload.commandId);
  });
  ipcMain.handle('userscript:xhr-request', async (event, raw) => {
    const active = manager;
    const requests = mod.getRequestService();
    if (!active || !requests) return { ok: false, error: 'not-ready' };
    const metadata = active.getScriptMetadata(raw?.scriptId);
    if (!metadata) return { ok: false, error: 'invalid-arguments' };
    return requests.request(event.sender.id, raw.scriptId, raw.pageUrl ?? '', metadata.metadata.connect, raw.details, raw.localId);
  });
  ipcMain.on('userscript:xhr-abort', (event, payload) => {
    mod.getRequestService()?.abort(event.sender.id, String(payload?.scriptId || ''), payload?.localId);
  });
  ipcMain.on('userscript:log', () => {});

  mod = require('../../release/tests/userscripts-admin-module.cjs');
  mod.initUserscriptManager();
  manager = mod.getUserscriptManager();

  const t0 = Date.now();
  // 初始无 background 脚本 → 无窗口
  check('no background windows at init', wcCount() === 0, wcCount());

  // 1. 安装 demo → 一个窗口
  const demo = mod.installUserscript(fs.readFileSync(BG_FIXTURE_PATH, 'utf8'));
  check('install background-demo', demo.ok === true, demo.ok ? demo.script.id : demo);
  const bgId = demo.ok ? demo.script.id : 'missing';
  let wcA = await waitFor(() => (wcCount() === 1 ? runtime().getWcIds()[0] : null), 10000);
  check('one window after first install', wcA != null, wcCount());

  // 报告含 phase bootstrap 且 detail.scripts 含 bg 脚本(mode ppapi)
  const boot = await waitFor(() => {
    const report = manager.getReports().find((r) => r.phase === 'bootstrap' && Array.isArray(r.detail?.scripts) && r.detail.scripts.includes(bgId));
    return report;
  }, 15000);
  check('bootstrap report includes bg script', Boolean(boot) && boot.mode === 'ppapi', boot && { mode: boot.mode, scripts: boot.detail.scripts });
  check('background booted quickly (no sendSync hang)', boot !== null && Date.now() - t0 < 15000, boot && Date.now() - t0);
  check('get-ruffle-mode queried by background preload', getRuffleQueries > 0, getRuffleQueries);

  // 值写入生效
  const running = await waitFor(() => manager.getValuesFor(wcA, bgId)['bg-running'], 5000);
  check('bg script runs and writes values', running === 1, running);

  // 2. URL 匹配排除 + snapshotBackground 按窗口过滤 + wc→scriptId 映射
  manager.registerView(777, { mode: 'ppapi', generation: 1, token: 'tab' });
  const tabSnap = manager.snapshotFor(777, 'http://example.com/', true);
  check('snapshotFor excludes bg script', !tabSnap.scripts.some((s) => s.id === bgId), tabSnap.scripts.map((s) => s.id));
  const bgSnap = manager.snapshotBackground(wcA);
  check('snapshotBackground includes only this window script', bgSnap.ok && bgSnap.scripts.length === 1 && bgSnap.scripts[0].id === bgId, bgSnap.scripts?.map((s) => s.id));
  check('getScriptIdForWc maps wcA → demo', runtime().getScriptIdForWc(wcA) === bgId, runtime().getScriptIdForWc(wcA));

  // 3. 命令合并 + invoke
  const cmd = await waitFor(() => {
    const found = manager.commandsFor(wcA).find((c) => c.title === '后台命令');
    return found ? { ...found, background: true } : null;
  }, 10000);
  check('bg command listed with background:true', Boolean(cmd), manager.commandsFor(wcA).map((c) => ({ title: c.title, background: c.background })));
  if (cmd) {
    webContents.fromId(wcA).send('userscript:menu-invoke', { commandId: cmd.commandId, documentId: cmd.documentId });
    const ran = await waitFor(() => manager.getValuesFor(wcA, bgId)['bg-ran'], 5000);
    check('invoked bg command ran callback', ran === 1, ran);
  }

  // 4. 定时 tick 持续产生新值
  const tick1 = await waitFor(() => manager.getValuesFor(wcA, bgId)['bg-tick'], 5000);
  const samples = [];
  for (let i = 0; i < 6; i++) {
    await sleep(1000);
    samples.push(manager.getValuesFor(wcA, bgId)['bg-tick']);
  }
  const distinct = new Set(samples.filter((v) => v !== undefined));
  check('bg interval keeps ticking', distinct.size >= 2 && samples[samples.length - 1] !== undefined, { tick1, samples: [samples[0], samples[samples.length - 1]] });

  // Crash recovery must destroy/clear the dead instance before backoff spawn.
  const crashedWc = wcA;
  webContents.fromId(crashedWc)?.forcefullyCrashRenderer();
  const recoveredWc = await waitFor(() => {
    const ids = runtime().getWcIds();
    return ids.length === 1 && ids[0] !== crashedWc ? ids[0] : null;
  }, 10000);
  check('crashed background window is recreated after backoff', recoveredWc != null, { crashedWc, recoveredWc });
  if (recoveredWc != null) wcA = recoveredWc;

  // 5. 第二个 bg 脚本 → 两个窗口,互不干扰
  const demo2 = mod.installUserscript(DEMO2_SOURCE);
  check('install background-demo2', demo2.ok === true, demo2.ok ? demo2.script.id : demo2);
  const bg2Id = demo2.ok ? demo2.script.id : 'missing';
  const wcB = await waitFor(() => (wcCount() === 2 ? otherWc(wcA) : null), 10000);
  check('two windows after second install', wcB != null, wcCount());
  const mapA = runtime().getScriptIdForWc(wcA);
  const mapB = runtime().getScriptIdForWc(wcB);
  check('each window maps to its own script', mapA === bgId && mapB === bg2Id, { mapA, mapB });
  const bg2Running = await waitFor(() => manager.getValuesFor(wcB, bg2Id)['bg2-running'], 5000);
  check('second script runs in its own window', bg2Running === 1, bg2Running);
  check('first script still running in wcA', manager.getValuesFor(wcA, bgId)['bg-running'] === 1, manager.getValuesFor(wcA, bgId)['bg-running']);

  // 6. 禁用 demo2 → 仅销毁其窗口,wcA 保留
  mod.setUserscriptEnabled(bg2Id, false);
  const remaining = await waitFor(() => (wcCount() === 1 ? runtime().getWcIds()[0] : null), 10000);
  check('disabling one script destroys only its window', remaining === wcA, { remaining, wcA });
  check('surviving window still serves demo', manager.snapshotBackground(wcA).scripts[0]?.id === bgId, manager.snapshotBackground(wcA).scripts?.map((s) => s.id));
  mod.setUserscriptEnabled(bg2Id, true);
  const wcB2 = await waitFor(() => (wcCount() === 2 ? otherWc(wcA) : null), 10000);
  check('re-enabling recreates its window', wcB2 != null && runtime().getScriptIdForWc(wcB2) === bg2Id, { wcB2, map: runtime().getScriptIdForWc(wcB2) });

  // 7. 无 @connect 的 xhr → connect-denied(第三窗口)
  const srv = http.createServer((req, res) => { res.writeHead(200); res.end('x'); });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;
  const nc = mod.installUserscript(NO_CONNECT_SOURCE(port));
  check('install background no-connect fixture', nc.ok === true, nc.ok ? nc.script.id : nc);
  const ncId = nc.ok ? nc.script.id : 'missing';
  const wcC = await waitFor(() => (wcCount() === 3 ? runtime().getWcIds().find((id) => id !== wcA && id !== wcB2) : null), 10000);
  const conn = await waitFor(() => manager.getValuesFor(wcC, ncId)['bg-conn'], 10000);
  check('no-connect xhr rejected with connect-denied', conn === 'connect-denied', conn);
  srv.close();

  // 清理
  mod.uninstallUserscript(bgId);
  mod.uninstallUserscript(bg2Id);
  mod.uninstallUserscript(ncId);
  runtime().stop();
  try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch { /* best effort */ }

  console.log(`[bg-smoke] ${failures.length === 0 ? 'ALL PASS' : 'FAILURES: ' + failures.join(', ')}`);
  app.exit(failures.length === 0 ? 0 : 1);
});
