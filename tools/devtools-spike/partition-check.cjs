/**
 * 连开两次应用，看分区存储是否「隔离 + 持久」。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON = path.join(APP_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const RUNNER = path.join(__dirname, 'partition-runner.cjs');
const LOG = path.join(os.tmpdir(), 'bfb-partition.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function oneRun(label) {
  try { fs.unlinkSync(LOG); } catch { /* ignore */ }
  const out = fs.openSync(LOG, 'w');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, [RUNNER], { cwd: APP_ROOT, stdio: ['ignore', out, out], env });
  await sleep(9000);
  child.kill();
  await sleep(500);
  const text = fs.readFileSync(LOG, 'utf8');
  const lines = text.split('\n').filter((l) => l.indexOf('[part]') !== -1);
  console.log(`\n=== ${label} ===`);
  lines.forEach((l) => console.log('   ' + l.replace('[part] ', '')));
  return lines;
}

(async () => {
  try { spawn('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' }); } catch { /* ignore */ }
  await sleep(1000);
  await oneRun('第一次启动（写入）');
  await oneRun('第二次启动（应读到上次的值 = 持久，且两边互不可见 = 隔离）');
  process.exit(0);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
