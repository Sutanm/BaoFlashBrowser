// Probe toolkit — plain Node host (fast probes, no Electron).
// Usage:
//   node tools/probe/host.cjs                 # run all pure-Node probes
//   node tools/probe/host.cjs --only 00,03    # run specific probes
//   node tools/probe/host.cjs --json          # machine-readable (AI-friendly)
//   SMOKE_TIMEOUT=200 node tools/probe/host.cjs   # raise the watchdog budget
// Exit code = number of failed probes.
'use strict';

const fs = require('fs');
const path = require('path');
const { createContext } = require('./lib/context.cjs');
const { withTimeout, createWatchdog } = require('./lib/timeout.cjs');
const { renderText, renderJson, failCount } = require('./lib/reporter.cjs');

function parseArgs(argv) {
  const args = { only: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--only' && argv[i + 1]) args.only = argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
    if (argv[i] === '--json') args.json = true;
  }
  return args;
}

function discoverProbes(dir, needsElectron) {
  return fs.readdirSync(dir)
    .filter((file) => file.endsWith('.cjs') && file !== '_template.cjs')
    .map((file) => require(path.join(dir, file)))
    .filter((probe) => probe && typeof probe.run === 'function')
    .filter((probe) => Boolean(probe.needsElectron) === needsElectron)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

async function runProbe(probe, ctx) {
  const started = Date.now();
  try {
    const result = await withTimeout(probe.run(ctx), probe.timeoutMs, `probe ${probe.id} (${probe.name})`);
    return {
      id: probe.id,
      name: probe.name,
      ok: Boolean(result && result.ok),
      summary: result && result.summary != null ? String(result.summary) : '',
      detail: result && result.detail,
      ms: Date.now() - started,
    };
  } catch (error) {
    return {
      id: probe.id,
      name: probe.name,
      ok: false,
      summary: error instanceof Error ? error.message : String(error),
      detail: { error: String(error), stack: error instanceof Error ? error.stack : undefined },
      ms: Date.now() - started,
    };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = path.join(__dirname, 'probes');
  let probes = discoverProbes(dir, false);
  if (args.only) probes = probes.filter((p) => args.only.some((want) => p.id === want || p.id.startsWith(want + '-')));
  if (probes.length === 0) {
    console.error('[probe] no pure-Node probes matched (--only ids? needElectron probes need host-electron.cjs)');
    process.exit(1);
  }

  const watchdog = createWatchdog();
  watchdog.arm();
  const ctx = createContext();
  const results = [];
  for (const probe of probes) {
    process.stdout.write(`[probe] ${probe.id} ${probe.name} ... `);
    const result = await runProbe(probe, ctx);
    process.stdout.write(result.ok ? 'OK\n' : 'FAIL\n');
    results.push(result);
  }
  watchdog.disarm();

  if (args.json) {
    console.log(renderJson(results));
  } else {
    console.log(renderText(results));
  }
  process.exit(failCount(results));
}

main().catch((error) => {
  console.error('[probe] host crashed:', error);
  process.exit(2);
});
