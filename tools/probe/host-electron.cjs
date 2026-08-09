// Probe toolkit — Electron host for deep probes (needsElectron: true).
// Run with:  npx electron tools/probe/host-electron.cjs [--only 10,11] [--json]
// Pins userData to the real app dir (bao-flash-browser) so deep probes read
// the same store as the running application.
'use strict';

const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { userDataDir } = require('./lib/context.cjs');
const { withTimeout, createWatchdog } = require('./lib/timeout.cjs');
const { renderText, renderJson, failCount } = require('./lib/reporter.cjs');

if (process.platform === 'linux') app.commandLine.appendSwitch('no-sandbox');
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'WinUseBrowserSpellChecker');
app.on('window-all-closed', () => {});
const realUserData = userDataDir();
const probeUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-probe-userdata-'));
app.setPath('userData', probeUserData);

function parseArgs(argv) {
  const args = { only: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--only' && argv[i + 1]) args.only = argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
    if (argv[i] === '--json') args.json = true;
  }
  return args;
}

function discoverProbes(dir) {
  return fs.readdirSync(dir)
    .filter((file) => file.endsWith('.cjs') && file !== '_template.cjs')
    .map((file) => require(path.join(dir, file)))
    .filter((probe) => probe && typeof probe.run === 'function')
    .filter((probe) => probe.needsElectron === true)
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

app.whenReady().then(async () => {
  const args = parseArgs(process.argv.slice(2));
  const { createContext } = require('./lib/context.cjs');
  const ctx = createContext();
  ctx.realUserData = realUserData;
  ctx.userData = probeUserData;
  ctx.electron = { app, BrowserWindow: require('electron').BrowserWindow, BrowserView: require('electron').BrowserView, ipcMain: require('electron').ipcMain };

  let probes = discoverProbes(path.join(__dirname, 'probes'));
  if (args.only) probes = probes.filter((p) => args.only.some((want) => p.id === want || p.id.startsWith(want + '-')));
  if (probes.length === 0) {
    console.error('[probe] no Electron probes matched (--only ids?)');
    app.exit(1);
    return;
  }

  const watchdog = createWatchdog();
  watchdog.arm();
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
  try { fs.rmSync(probeUserData, { recursive: true, force: true }); } catch { /* best effort */ }
  app.exit(failCount(results));
}).catch((error) => {
  console.error('[probe] electron host crashed:', error);
  try { fs.rmSync(probeUserData, { recursive: true, force: true }); } catch { /* best effort */ }
  app.exit(2);
});
