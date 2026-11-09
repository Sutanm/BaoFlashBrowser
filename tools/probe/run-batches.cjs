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

// 只挑 needsElectron 的探针：其余探针属于纯 Node 的 `npm run probe`。
const ids = fs.readdirSync(probesDir)
  .filter((name) => /^\d+-.*\.cjs$/u.test(name))
  .map((name) => {
    const probe = require(path.join(probesDir, name));
    return probe && probe.needsElectron === true ? String(probe.id).split('-')[0] : null;
  })
  .filter((id, index, all) => Boolean(id) && all.indexOf(id) === index)
  .sort();

const groups = [
  ids.filter((id) => Number(id) < 30),
  ids.filter((id) => Number(id) >= 30 && Number(id) < 47),
  ids.filter((id) => Number(id) >= 47),
];
// 每批最多 4 个：本机 Electron 探针在长批次里会累积窗口/表面状态并偶发挂起。
const batches = groups.flatMap((group) => {
  const chunks = [];
  for (let index = 0; index < group.length; index += 4) chunks.push(group.slice(index, index + 4));
  return chunks;
});

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

let failed = 0;
for (const [index, batch] of batches.entries()) {
  if (batch.length === 0) continue;
  console.log(`[batched] batch ${index + 1}/${batches.length}: ${batch.join(',')}`);
  const run = () => spawnSync(electronPath, [host, '--only', batch.join(',')], {
    cwd: root,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  let result = run();
  if (result.status !== 0) {
    console.log('[batched] retrying failed batch once');
    result = run();
  }
  if (result.status !== 0) failed += 1;
}

if (failed > 0) {
  console.log(`[batched] ${failed} batch(es) failed`);
  process.exit(1);
}
console.log('[batched] all batches passed');
