// Smoke: GM 值跨重启持久化 (Task 1)
// 进程 A: init manager → registerView(假 wc) → setValue → flushValues → 退出
// 进程 B(--second): init manager → loadValues → getValuesFor 读到同一值
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'WinUseBrowserSpellChecker');
app.on('window-all-closed', () => {});
app.setPath('userData', process.env.BAO_SMOKE_USER_DATA || path.join(app.getPath('appData'), 'bao-flash-browser'));

const failures = [];
function check(name, ok, detail) {
  console.log(`[values-persistence] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail) : ''}`);
  if (!ok) failures.push(name);
}

const VALUES_FILE = path.join(app.getPath('userData'), 'userscript-values.json');
const WID = 9001; // 假 wcId:setValue/getValuesFor 仅需 view 登记,不创建 BrowserView

app.whenReady().then(async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../../release/tests/userscripts-admin-module.cjs');
  mod.initUserscriptManager();
  const manager = mod.getUserscriptManager();

  if (process.argv.includes('--second')) {
    // 进程 B:读回
    manager.loadValues(VALUES_FILE);
    manager.registerView(WID, { mode: 'ppapi', generation: 1, token: 'smoke' });
    const values = manager.getValuesFor(WID, 'baoflash-demo-test');
    check('value persisted across processes', values.visits === 42, values);
    // 恢复临时值(进程 A 写入前不存在 → 删除)
    manager.deleteValue(WID, 'baoflash-demo-test', 'visits');
    manager.flushValues();
  } else {
    // 进程 A:写入
    manager.registerView(WID, { mode: 'ppapi', generation: 1, token: 'smoke' });
    const result = manager.setValue(WID, 'baoflash-demo-test', 'visits', 42);
    check('setValue succeeded', result.ok === true, result);
    manager.flushValues();
    check('values file exists after flush', fs.existsSync(VALUES_FILE));
  }

  console.log(`[values-persistence] ${failures.length === 0 ? 'ALL PASS' : 'FAILURES: ' + failures.join(', ')}`);
  app.exit(failures.length === 0 ? 0 : 1);
});
