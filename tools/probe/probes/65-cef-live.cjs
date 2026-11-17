'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const flashTextField = require('../fixtures/cef-compare/live-text-field.cjs');

module.exports = {
  id: '65-cef-live',
  name: 'live Electron to CEF PPAPI input and frame transport',
  needsElectron: true,
  timeoutMs: 75_000,

  async run({ root, userData }) {
    const worker = process.env.BAO_CEF_PROBE_EXE;
    const game = process.env.BAO_CEF_GAME_SWF;
    if (process.platform !== 'win32' || process.arch !== 'x64' || !worker || !game) {
      return { ok: true, summary: 'opt-in Windows x64 (BAO_CEF_PROBE_EXE and BAO_CEF_GAME_SWF)' };
    }
    const release = path.join(root, 'release');
    fs.mkdirSync(release, { recursive: true });
    const output = fs.mkdtempSync(path.join(release, 'cef-live-'));
    const swf = path.join(userData, 'button.swf');
    fs.writeFileSync(swf, Buffer.from(fs.readFileSync(path.join(
      root, 'tools', 'automation-probe', 'fixtures', 'ruffle-button1.swf.base64',
    ), 'utf8'), 'base64'));
    fs.writeFileSync(path.join(userData, 'text-field.swf'), flashTextField());
    fs.copyFileSync(game, path.join(userData, 'game.swf'));
    const controlPath = path.join(userData, 'control.html');
    const gamePath = path.join(userData, 'game.html');
    const css = '<meta charset="utf-8"><style>body{margin:0;overflow:hidden}embed{display:block}</style>';
    fs.writeFileSync(controlPath, css + `
      <embed src="button.swf" type="application/x-shockwave-flash" width="550" height="420">
      <embed id="flash-text" src="text-field.swf" type="application/x-shockwave-flash"
        allowscriptaccess="always" width="220" height="42" style="position:absolute;top:330px;left:15px">
      <input style="position:absolute;top:387px;left:15px;width:170px;font-size:18px">
      <script>
        const input = document.querySelector('input');
        const field = document.querySelector('#flash-text');
        const readFlashValue = setInterval(() => {
          try {
            if (field.GetVariable('imeText') === '\u4e2d\u6587') {
              console.log('bao-flash-ime-committed');
              clearInterval(readFlashValue);
            }
          } catch {}
        }, 150);
        input.addEventListener('compositionupdate', event => {
          if (event.data === '\u4e2d\u6587') console.log('bao-ime-composition');
        });
        input.addEventListener('compositionend', event => {
          if (event.data === '\u4e2d\u6587') setTimeout(() => {
            if (input.value === '\u4e2d\u6587') console.log('bao-ime-committed');
          }, 0);
        });
        input.addEventListener('input', event => {
          if (input.value === '\u4e2d\u6587' && !event.isComposing) console.log('bao-ime-committed');
        });
      </script>`);
    fs.writeFileSync(gamePath, css + '<embed src="game.swf" type="application/x-shockwave-flash" width="640" height="480">');
    const modules = path.join(root, '.cache', 'electron', 'dual-kernel', 'node_modules');
    const modern = process.env.BAO_MODERN_ELECTRON || require(path.join(modules, 'electron'));
    const plugin = path.join(root, 'plugins', 'win64', 'pepflashplayer64.dll');
    const shell = path.join(__dirname, '..', 'fixtures', 'cef-compare', 'live-shell.cjs');
    await promisify(execFile)(modern, [
      shell, worker, plugin, controlPath, gamePath, userData, output, modules,
    ], { timeout: 65_000 });
    const report = JSON.parse(fs.readFileSync(path.join(output, 'report.json'), 'utf8'));
    const ok = Boolean(report.control?.latencyMs?.length === 10 && report.control.worker?.imeComposition &&
      report.control.worker.imeCommitted && report.control.worker.flashImeCommitted && report.game?.shipAfterX > report.game.shipBeforeX + 8 && report.game.distinctFrames > 30 && report.game.worker?.keyCommands >= 4);
    const summary = ok ? 'real PPAPI frames, shell mouse, game movement, HTML and Flash IME verified'
      : report.error || report.control?.error || report.game?.error || 'one or more live checks failed';
    return { ok, summary, detail: { output, ...report } };
  },
};
