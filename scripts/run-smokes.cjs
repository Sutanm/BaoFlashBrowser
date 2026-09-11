// Serial runner for the Electron userscript smokes.
// Runs each smoke and reports a combined PASS/FAIL (non-zero exit on any failure).
// Usage: node scripts/run-smokes.cjs   (or `npm run test:smokes`, which ensures
// the release/tests bundles are fresh first — this script refuses to start on
// stale bundles so a direct invocation cannot silently test old code either).
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const ELECTRON_CLI = path.join(ROOT, 'node_modules', 'electron', 'cli.js');

// Refuse to run against stale bundles. `npm run test:smokes` rebuilds them first;
// this guard covers a direct `node scripts/run-smokes.cjs` invocation, which is
// exactly how a smoke used to end up testing outdated code.
{
  const check = spawnSync(NODE, [path.join(__dirname, 'ensure-build.cjs'), '--check'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (check.status !== 0) {
    console.error('\n[run-smokes] refusing to run: smoke bundles are stale (see above).');
    console.error('[run-smokes] fix with: node scripts/ensure-build.cjs');
    process.exit(1);
  }
}
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
  // resolution quirks on Windows). Linux's SUID sandbox check happens before
  // the smoke entry can call app.commandLine.appendSwitch(), so the CLI switch
  // must appear before the entry path.
  const launchArgs = process.platform === 'linux'
    ? [ELECTRON_CLI, '--no-sandbox', smokePath, ...extraArgs]
    : [ELECTRON_CLI, smokePath, ...extraArgs];
  return run(label, launchArgs);
}

// Bundle freshness is handled by `npm run test:smokes`
// (`node scripts/ensure-build.cjs`), which rebuilds any release/tests/ artifact
// older than its sources. Keeping a second hand-written build step here is what
// previously let these smokes run against stale bundles.
const steps = [
  ['values-persistence (process A)', () => runElectron('values-persistence A', 'tests/electron/values-persistence-smoke.cjs')],
  ['values-persistence (process B)', () => runElectron('values-persistence B', 'tests/electron/values-persistence-smoke.cjs', ['--second'])],
  ['gm-capacity', () => runElectron('gm-capacity', 'tests/electron/gm-capacity-smoke.cjs')],
  ['userscripts-update', () => runElectron('userscripts-update', 'tests/electron/userscripts-update-smoke.cjs')],
  ['menu-command-dedupe', () => runElectron('menu-command-dedupe', 'tests/electron/menu-command-dedupe-smoke.cjs')],
  ['userscripts-cookie', () => runElectron('userscripts-cookie', 'tests/electron/userscripts-cookie-smoke.cjs')],
  ['userscripts-web-request', () => runElectron('userscripts-web-request', 'tests/electron/userscripts-web-request-smoke.cjs')],
  ['background-script (round 1)', () => runElectron('background-script r1', 'tests/electron/background-script-smoke.cjs')],
  ['background-script (round 2)', () => runElectron('background-script r2', 'tests/electron/background-script-smoke.cjs')],
  ['renderer-csp', () => runElectron('renderer-csp', 'tests/electron/csp-smoke.cjs')],
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
