// Pin an Electron smoke's userData to a throwaway directory.
//
// Why: without this, `app.getPath('userData')` falls back to `%APPDATA%\Electron`
// (Electron's own default, not the app's), so a smoke silently shares — and
// pollutes — one real directory across every standalone Electron script. Real
// damage was observed: `%APPDATA%\Electron` accumulated `userscripts.json`
// (518 KB), `password-store.json`, `password-autofill-key.json` and Electron
// bookkeeping from unrelated runs.
//
// The security-relevant half is the password vault: `password-store.init()`
// SHELVES and CLEARS the wrap key when the OS keyring cannot unwrap it. Pointed
// at a directory holding a real `password-autofill-key.json`, a smoke would
// discard that key and make the vault's entries permanently unreadable — the DEK
// is wrapped BY that key. Isolating userData removes that class of accident.
//
// Usage — immediately after requiring electron, before any `app.*` call:
//
//   const { app } = require('electron');
//   require('./isolate-user-data.cjs')(app, 'browserview-smoke');
//
// Honors `BAO_SMOKE_USER_DATA` (set by scripts/run-smokes.cjs) so multi-process
// smokes can still share one deliberate directory.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/** @param {{ setPath(name: string, value: string): void }} app @param {string} slug */
module.exports = function isolateUserData(app, slug) {
  const explicit = process.env.BAO_SMOKE_USER_DATA;
  const dir = explicit && explicit.trim()
    ? explicit
    : fs.mkdtempSync(path.join(os.tmpdir(), `${slug}-`));
  app.setPath('userData', dir);
  // Smokes manage their own teardown; the default handler would quit early.
  app.on('window-all-closed', () => {});
  return dir;
};
