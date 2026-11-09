// Run deep probes in batches so per-probe state does not accumulate in one
// Electron process (probes 47/51 spawn their own children and are sensitive to
// long-lived processes in this environment).
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const probesDir = path.join(__dirname, 'probes');
const host = path.join(__dirname, 'host-electron.cjs');
const electronPath = require('electron');

const ids = fs.readdirSync(probesDir)
  .filter((name) => /^\d+-.*\.cjs$/u.test(name))
  .map((name) => name.split('-')[0])
  .filter((id, index, all) => all.indexOf(id) === index)
  .sort();

const batches = [
  ids.filter((id) => Number(id) < 30),
  ids.filter((id) => Number(id) >= 30 && Number(id) < 47),
  ids.filter((id) => Number(id) >= 47),
];

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

let failed = 0;
for (const [index, batch] of batches.entries()) {
  if (batch.length === 0) continue;
  console.log(`[batched] batch ${index + 1}/${batches.length}: ${batch.join(',')}`);
  const result = spawnSync(electronPath, [host, '--only', batch.join(',')], {
    cwd: root,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) failed += 1;
}

if (failed > 0) {
  console.log(`[batched] ${failed} batch(es) failed`);
  process.exit(1);
}
console.log('[batched] all batches passed');
