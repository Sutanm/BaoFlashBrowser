// Smoke: @updateURL 手动检查更新 (Task 4)
// 本地 server: /v1.user.js(1.0.0,@updateURL 绝对 URL,@connect 127.0.0.1)、
// /v2.user.js(2.0.0)、/manifest.json({version, updateURL})。
// 断言:JSON 元数据路径、enabled 保留、edited 跳过、无 @connect 拒绝、
// __platform_updater__ 不出现在 store。
const { app } = require('electron');
const http = require('http');
const path = require('path');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'WinUseBrowserSpellChecker');
app.on('window-all-closed', () => {});
app.setPath('userData', process.env.BAO_SMOKE_USER_DATA || path.join(app.getPath('appData'), 'bao-flash-browser'));

const failures = [];
function check(name, ok, detail) {
  console.log(`[update-smoke] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail) : ''}`);
  if (!ok) failures.push(name);
}

const NS = 'https://baoflash.local/update-smoke';
const V1_SOURCE = (port) => `// ==UserScript==
// @name         Update Smoke Demo
// @namespace    ${NS}
// @version      1.0.0
// @description  更新冒烟 v1
// @updateURL    http://127.0.0.1:${port}/manifest.json
// @connect      127.0.0.1
// @match        https://other.example/*
// ==/UserScript==
console.log('update-smoke v1');
`;
const V2_SOURCE = `// ==UserScript==
// @name         Update Smoke Demo
// @namespace    ${NS}
// @version      2.0.0
// @description  更新冒烟 v2
// @updateURL    http://127.0.0.1:PORT_PLACEHOLDER/manifest.json
// @connect      127.0.0.1
// @match        https://other.example/*
// ==/UserScript==
console.log('update-smoke v2');
`;
const NO_CONNECT_SOURCE = (port) => `// ==UserScript==
// @name         Update Smoke NoConnect
// @namespace    ${NS}
// @version      1.0.0
// @description  无 @connect,仅 @match 不匹配 update host
// @updateURL    http://127.0.0.1:${port}/manifest.json
// @match        https://other.example/*
// ==/UserScript==
console.log('update-smoke no-connect');
`;

app.whenReady().then(async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../../release/tests/userscripts-admin-module.cjs');
  mod.initUserscriptManager();

  let manifestHits = 0;
  const srv = http.createServer((req, res) => {
    if (req.url === '/v1.user.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end('// ==UserScript==\n// @name  Update Smoke Demo\n// @version 1.0.0\n// ==/UserScript==\n');
    } else if (req.url === '/v2.user.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end(V2_SOURCE);
    } else if (req.url === '/manifest.json') {
      manifestHits += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '2.0.0', updateURL: '/v2.user.js' }));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = srv.address().port;

  // 1. 安装 v1
  const installed = mod.installUserscript(V1_SOURCE(port));
  check('install v1', installed.ok === true && installed.script.metadata.version === '1.0.0', installed.ok ? installed.script.id : installed);
  const id = installed.ok ? installed.script.id : 'missing';

  // 2. checkUpdates → JSON 元数据路径,报可更新 2.0.0;并发调用去重
  const [checked, checked2] = await Promise.all([mod.checkUpdates(), mod.checkUpdates()]);
  check('checkUpdates dedupes concurrent calls', checked === checked2, { sameObject: checked === checked2, manifestHits });
  const update = checked.updates.find((u) => u.id === id);
  check('checkUpdates reports v2.0.0 via manifest', Boolean(update) && update.latestVersion === '2.0.0', update ?? checked.updates.map((u) => u.id));

  // 3. 禁用后 applyUpdate → 版本 2.0.0、enabled 保留(false)
  mod.setUserscriptEnabled(id, false);
  const applied = await mod.applyUpdate(id);
  check('applyUpdate ok', applied.ok === true, applied);
  const after = mod.listUserscripts().find((s) => s.id === id);
  check('applied version 2.0.0', after?.metadata.version === '2.0.0', after?.metadata.version);
  check('enabled preserved (false)', after?.enabled === false, after?.enabled);

  // 4. edited 脚本:updateUserscriptSource 后 checkUpdates 跳过
  mod.updateUserscriptSource(id, V1_SOURCE(port).replace('// ==/UserScript==', '// user edit\n// ==/UserScript=='));
  const checkedEdited = await mod.checkUpdates();
  check('edited script skipped by checkUpdates', !checkedEdited.updates.some((u) => u.id === id), checkedEdited.updates);

  // 5. 无 @connect 的脚本(仅 @match 且不匹配 update host)→ 拒绝
  const noConnect = mod.installUserscript(NO_CONNECT_SOURCE(port));
  const ncId = noConnect.ok ? noConnect.script.id : 'missing';
  const checkedNoConnect = await mod.checkUpdates();
  check('no-connect script rejected (host check)', noConnect.ok === true && !checkedNoConnect.updates.some((u) => u.id === ncId), checkedNoConnect.updates.map((u) => u.id));

  // 6. __platform_updater__ 从不进入 script-store
  check('__platform_updater__ absent from store', !mod.listUserscripts().some((s) => s.id === '__platform_updater__'));

  // 清理:卸载冒烟 fixture,恢复 store
  mod.uninstallUserscript(id);
  mod.uninstallUserscript(ncId);

  srv.close();
  console.log(`[update-smoke] ${failures.length === 0 ? 'ALL PASS' : 'FAILURES: ' + failures.join(', ')}`);
  app.exit(failures.length === 0 ? 0 : 1);
});
