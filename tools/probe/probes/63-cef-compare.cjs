'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { randomBytes } = require('crypto');
const { waitFor } = require('../lib/timeout.cjs');

const run = promisify(execFile);

function changedPixels(dir, first, second) {
  const bitmap = (name) => fs.readFileSync(path.join(dir, name + '.bmp')).subarray(54);
  const a = bitmap(first);
  const b = bitmap(second);
  if (!a.length || a.length !== b.length) throw new Error('invalid bitmap dimensions');
  let count = 0;
  for (let i = 0; i < a.length; i += 4) {
    const change = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (change >= 24) count++;
  }
  return count / (a.length / 4);
}

function readReport(dir, name) {
  return JSON.parse(fs.readFileSync(path.join(dir, name + '.json'), 'utf8'));
}

function centerPixels(dir) {
  return ['before', 'hover', 'pressed', 'released'].map((name) => {
    const data = fs.readFileSync(path.join(dir, name + '.bmp'));
    const p = 54 + (210 * 550 + 250) * 4;
    return (data[p + 2] << 16) | (data[p + 1] << 8) | data[p];
  });
}

async function compareShell(kind, { root, userData, output, plugin, url }) {
  const dir = path.join(output, kind);
  fs.mkdirSync(dir);
  const profile = fs.mkdtempSync(path.join(userData, kind + '-'));
  const mapping = 'Local\\BaoCefComparison-' + randomBytes(16).toString('hex');
  const fixture = path.join(__dirname, '..', 'fixtures', 'cef-compare');
  const modules = path.join(root, '.cache', 'electron', 'dual-kernel', 'node_modules');
  const exe = kind === 'cef-shell'
    ? process.env.BAO_CEF_MODERN_EXE
    : process.env.BAO_MODERN_ELECTRON || require(path.join(modules, 'electron'));
  const args = kind === 'cef-shell'
    ? [mapping, pathToFileURL(path.join(fixture, 'shell.html')).href, profile, dir]
    : [path.join(fixture, 'electron-shell.cjs'), mapping, profile, dir, modules];

  // Attach rejection handlers immediately because a shell can exit before it is ready.
  const started = run(exe, args, { timeout: 19_000 }).then(() => null, (error) => error);
  const shellExited = started.then((error) => { throw error || new Error('shell exited before it was ready'); });
  await Promise.race([
    waitFor(() => fs.existsSync(path.join(dir, 'ready')), { timeoutMs: 12_000, intervalMs: 25, label: kind + ' ready' }),
    shellExited,
  ]);
  const workerProfile = fs.mkdtempSync(path.join(userData, kind + '-worker-'));
  await run(process.env.BAO_CEF_PROBE_EXE, [plugin, url, workerProfile, dir, 'bitmap', mapping], {
    timeout: 20_000, windowsHide: true,
  });
  const failure = await started;
  if (failure) throw failure;
  const shell = readReport(dir, 'shell');
  const expected = centerPixels(dir);
  const inputVerified = changedPixels(dir, 'hover', 'pressed') > 0.01 &&
    changedPixels(dir, 'pressed', 'released') > 0.01;
  const matched = JSON.stringify(shell.centers) === JSON.stringify(expected);
  return { ...shell, expected, inputVerified, matched, ok: Boolean(shell.modernCss && shell.drawn && inputVerified && matched) };
}
module.exports = {
  id: '63-cef-compare',
  name: 'CEF 87 PPAPI bitmap and D3D11 texture',
  needsElectron: true,
  timeoutMs: 80_000,

  async run({ root, userData }) {
    if (process.platform !== 'win32' || process.arch !== 'x64' || !process.env.BAO_CEF_PROBE_EXE) {
      return { ok: true, summary: 'opt-in Windows x64 probe (BAO_CEF_PROBE_EXE)' };
    }

    const release = path.join(root, 'release');
    fs.mkdirSync(release, { recursive: true });
    const output = fs.mkdtempSync(path.join(release, 'cef-compare-'));
    const swf = path.join(userData, 'cef-button.swf');
    fs.writeFileSync(swf, Buffer.from(fs.readFileSync(path.join(
      root, 'tools', 'automation-probe', 'fixtures', 'ruffle-button1.swf.base64',
    ), 'utf8'), 'base64'));
    const html = path.join(userData, 'cef-button.html');
    fs.writeFileSync(html, '<!doctype html><style>body{margin:0}</style>' +
      '<embed src="cef-button.swf" type="application/x-shockwave-flash" width="550" height="420">');
    const plugin = path.join(root, 'plugins', 'win64', 'pepflashplayer64.dll');
    const modes = {};

    for (const mode of ['bitmap', 'texture']) {
      const profile = fs.mkdtempSync(path.join(userData, 'cef-' + mode + '-'));
      const dir = path.join(output, mode);
      fs.mkdirSync(dir);
      try {
        await run(process.env.BAO_CEF_PROBE_EXE, [
          plugin, pathToFileURL(html).href, profile, dir, mode,
        ], { timeout: 26_000, windowsHide: true });
        const report = JSON.parse(fs.readFileSync(path.join(dir, 'worker.json'), 'utf8'));
        modes[mode] = report;
        if (report.saved.every(Boolean)) {
          report.pressChanged = changedPixels(dir, 'hover', 'pressed');
          report.releaseChanged = changedPixels(dir, 'pressed', 'released');
        }
        report.inputVerified = report.pressChanged > 0.01 && report.releaseChanged > 0.01;
      } catch (error) {
        modes[mode] = { error: error.message, inputVerified: false };
      }
    }
    const shells = {};
    if (process.env.BAO_CEF_MODERN_EXE && modes.bitmap.inputVerified) {
      for (const kind of ['cef-shell', 'electron-shell']) {
        try {
          shells[kind] = await compareShell(kind, { root, userData, output, plugin, url: pathToFileURL(html).href });
        } catch (error) {
          shells[kind] = { ok: false, error: error.message };
        }
      }
    }
    const shellResults = Object.entries(shells);
    const ok = modes.bitmap.inputVerified && shellResults.every(([, shell]) => shell.ok);
    const detail = { output, modes, shells };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(detail, null, 2) + '\n');
    return { ok, summary: ['bitmap', 'texture'].map((mode) => (
      mode + ' ' + (modes[mode].inputVerified ? 'verified' : 'unverified')
    )).concat(shellResults.map(([kind, shell]) => kind + (shell.ok ? ' verified' : ' unverified'))).join(' · '), detail };
  },
};
