// Probe: app config snapshot (userData/config.json, electron-store). Read-only.
'use strict';

const path = require('path');

module.exports = {
  id: '02-config',
  name: 'app config snapshot',
  needsElectron: false,

  async run(ctx) {
    const file = path.join(ctx.userData, 'config.json');
    const config = ctx.readJsonSafe(file);
    if (!config) {
      return { ok: false, summary: `missing ${file}`, detail: { file } };
    }
    const keys = ['flashVersion', 'lowEndMode', 'downloadEngine', 'downloadDir'];
    const snapshot = {};
    for (const key of keys) snapshot[key] = config[key];
    return {
      ok: true,
      summary: `flash ${snapshot.flashVersion ?? '?'} · engine ${snapshot.downloadEngine ?? '?'} · lowEnd ${Boolean(snapshot.lowEndMode)}`,
      detail: { file, snapshot },
    };
  },
};
