// Diagnose: print userData path, the store file, and the manager's list.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

app.setPath('userData', path.join(app.getPath('appData'), 'bao-flash-browser'));

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  console.log('[diag] userData:', userData);
  const storeFile = path.join(userData, 'userscripts.json');
  console.log('[diag] store file exists:', fs.existsSync(storeFile), storeFile);
  if (fs.existsSync(storeFile)) {
    const raw = fs.readFileSync(storeFile, 'utf8');
    console.log('[diag] store file:', raw.slice(0, 500));
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../../release/tests/userscripts-admin-module.cjs');
  mod.initUserscriptManager();
  console.log('[diag] manager list:', JSON.stringify(mod.listUserscripts().map((s) => ({ id: s.id, name: s.metadata.name, enabled: s.enabled }))));
  app.exit(0);
});
