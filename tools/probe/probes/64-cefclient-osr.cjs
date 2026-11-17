'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

module.exports = {
  id: '64-cefclient-osr',
  name: 'official cefclient desktop rendering controls',
  needsElectron: true,
  timeoutMs: 75_000,

  async run({ root, userData }) {
    const cef87 = process.env.BAO_CEFCLIENT_87;
    if (process.platform !== 'win32' || process.arch !== 'x64' || !cef87) {
      return { ok: true, summary: 'opt-in Windows x64 desktop test (BAO_CEFCLIENT_87)' };
    }
    const release = path.join(root, 'release');
    fs.mkdirSync(release, { recursive: true });
    const output = fs.mkdtempSync(path.join(release, 'cefclient-osr-'));
    const modules = path.join(root, '.cache', 'electron', 'dual-kernel', 'node_modules');
    const modern = process.env.BAO_MODERN_ELECTRON || require(path.join(modules, 'electron'));
    const args = [
      path.join(__dirname, '..', 'fixtures', 'cef-compare', 'cefclient-desktop.cjs'),
      modules, output, userData, cef87,
    ];
    if (process.env.BAO_CEFCLIENT_MODERN) args.push(process.env.BAO_CEFCLIENT_MODERN);
    await promisify(execFile)(modern, args, { timeout: 70_000 });
    const report = JSON.parse(fs.readFileSync(path.join(output, 'report.json'), 'utf8'));
    const ok = ['windowed87', 'bitmap87', 'bitmapGpu87'].every((key) => report[key]?.animated) &&
      report.texture87 && !report.texture87.error && report.texture87.occluded === 0 &&
      (!process.env.BAO_CEFCLIENT_MODERN || report.textureModern?.animated);
    const texture = report.texture87?.animated ? 'animated' : 'no color cycle';
    return { ok, summary: 'CEF 87 texture: ' + texture + (ok ? ' · controls passed' : ' · controls failed'),
      detail: { output, ...report } };
  },
};
