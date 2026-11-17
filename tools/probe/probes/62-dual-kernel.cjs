'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

module.exports = {
  id: '62-dual-kernel',
  name: 'modern Electron + embedded PPAPI BrowserView',
  needsElectron: true,
  timeoutMs: 60_000,

  async run({ root, userData }) {
    if (process.platform !== 'win32' || process.arch !== 'x64' || process.env.BAO_PROBE_DUAL_KERNEL !== '1') {
      return { ok: true, summary: 'opt-in Windows x64 desktop probe (BAO_PROBE_DUAL_KERNEL=1)' };
    }

    const modules = path.join(root, '.cache', 'electron', 'dual-kernel', 'node_modules');
    const modern = process.env.BAO_MODERN_ELECTRON || require(path.join(modules, 'electron'));
    const release = path.join(root, 'release');
    fs.mkdirSync(release, { recursive: true });
    const output = fs.mkdtempSync(path.join(release, 'dual-kernel-'));
    const { stdout } = await promisify(execFile)(modern, [
      path.join(__dirname, '..', 'fixtures', 'dual-kernel-shell.cjs'),
      process.execPath, modules, userData, output,
    ], { timeout: 50_000, windowsHide: false });

    const result = JSON.parse(stdout.trim());
    return {
      ok: result.ok,
      summary: result.error || 'two Chromium versions, native PPAPI input, tab switching and child restart verified',
      detail: { output, ...result },
    };
  },
};
