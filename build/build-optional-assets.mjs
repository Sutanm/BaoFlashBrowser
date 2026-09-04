import { spawnSync } from 'child_process';
import { moduleSummary, parseModules } from './module-flags.mjs';

const modules = parseModules();

function run(script) {
  const result = spawnSync(process.execPath, [script], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (modules.has('userscripts')) {
  run('scripts/build-css-fixer.mjs');
  if (modules.has('automation')) run('scripts/build-automation-assistant.mjs');
}

console.log(`[build] optional assets complete (modules: ${moduleSummary(modules)})`);
