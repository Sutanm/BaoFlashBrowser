// Serial runner for the Electron userscript smokes.
// Builds the release/tests bundles first, then runs each smoke and reports a
// combined PASS/FAIL (non-zero exit on any failure).
// Usage: node scripts/run-smokes.cjs
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const ELECTRON_CLI = path.join(ROOT, 'node_modules', 'electron', 'cli.js');
const SMOKE_TIMEOUT_MS = 5 * 60 * 1000;
const SMOKE_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-userscript-smokes-'));
const SMOKE_ENV = { ...process.env, BAO_SMOKE_USER_DATA: SMOKE_USER_DATA };

function run(label, args) {
  console.log(`\n===== ${label} =====`);
  const result = spawnSync(NODE, args, { cwd: ROOT, stdio: 'inherit', timeout: SMOKE_TIMEOUT_MS, env: SMOKE_ENV });
  if (result.error) {
    console.error(`[run-smokes] ${label} spawn error: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    console.error(`[run-smokes] ${label} exited ${result.status}`);
    return false;
  }
  return true;
}

function runElectron(label, smokePath, extraArgs = []) {
  // Electron smokes run via node_modules/electron/cli.js (avoids npx/.cmd
  // resolution quirks on Windows).
  return run(label, [ELECTRON_CLI, smokePath, ...extraArgs]);
}

const steps = [
  ['build admin-module', () => run('build admin-module', ['tests/electron/build-userscripts-admin-smoke.mjs'])],
  ['build runtime-preload', () => run('build runtime-preload', ['tests/electron/build-userscript-runtime-smoke.mjs'])],
  ['values-persistence (process A)', () => runElectron('values-persistence A', 'tests/electron/values-persistence-smoke.cjs')],
  ['values-persistence (process B)', () => runElectron('values-persistence B', 'tests/electron/values-persistence-smoke.cjs', ['--second'])],
  ['gm-capacity', () => runElectron('gm-capacity', 'tests/electron/gm-capacity-smoke.cjs')],
  ['userscripts-update', () => runElectron('userscripts-update', 'tests/electron/userscripts-update-smoke.cjs')],
  ['menu-command-dedupe', () => runElectron('menu-command-dedupe', 'tests/electron/menu-command-dedupe-smoke.cjs')],
  ['userscripts-cookie', () => runElectron('userscripts-cookie', 'tests/electron/userscripts-cookie-smoke.cjs')],
  ['userscripts-web-request', () => runElectron('userscripts-web-request', 'tests/electron/userscripts-web-request-smoke.cjs')],
  ['background-script (round 1)', () => runElectron('background-script r1', 'tests/electron/background-script-smoke.cjs')],
  ['background-script (round 2)', () => runElectron('background-script r2', 'tests/electron/background-script-smoke.cjs')],
];

const failures = [];
for (const [label, step] of steps) {
  if (!step()) failures.push(label);
}

console.log(`\n===== run-smokes summary =====`);
if (failures.length === 0) {
  console.log('[run-smokes] ALL PASS');
  try { fs.rmSync(SMOKE_USER_DATA, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(0);
}
console.error(`[run-smokes] FAILURES: ${failures.join(', ')}`);
try { fs.rmSync(SMOKE_USER_DATA, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(1);
