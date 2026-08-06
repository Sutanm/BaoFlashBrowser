// One-shot install/uninstall of the demo test script into the SAME userData
// the app uses when started via `npm start` / `electron .`.
// Usage:
//   npx electron tests/electron/install-demo-test-script.cjs            # install
//   npx electron tests/electron/install-demo-test-script.cjs --uninstall # remove
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

// `electron .` derives userData from package.json name; bare `electron <script>`
// would use a different default. Pin the same directory both ways.
app.setPath('userData', path.join(app.getPath('appData'), 'bao-flash-browser'));

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../../release/tests/userscripts-admin-module.cjs');
  mod.initUserscriptManager();

  const uninstall = process.argv.includes('--uninstall');
  if (uninstall) {
    const removed = mod.listUserscripts()
      .filter((script) => script.metadata.name.includes('BaoFlash'))
      .map((script) => ({ id: script.id, removed: mod.uninstallUserscript(script.id) }));
    console.log('[install-demo-test] uninstall:', JSON.stringify(removed));
    app.exit(removed.length > 0 && removed.every((r) => r.removed) ? 0 : 1);
    return;
  }

  const fixture = path.join(__dirname, '..', '..', 'tests', 'electron', 'fixtures', 'demo-test.user.js');
  const source = fs.readFileSync(fixture, 'utf8');
  const result = mod.installUserscript(source, { id: 'baoflash-demo-test' });
  console.log('[install-demo-test] result:', JSON.stringify(result, null, 2));
  if (!result.ok) {
    app.exit(1);
    return;
  }
  const listed = mod.listUserscripts().map((s) => ({ id: s.id, name: s.metadata.name, enabled: s.enabled }));
  console.log('[install-demo-test] installed scripts:', JSON.stringify(listed));
  app.exit(0);
});
