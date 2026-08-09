// Probe: installed userscripts from the persistent store
// (userData/userscripts.json, electron-store format). Read-only.
'use strict';

const path = require('path');

module.exports = {
  id: '01-userscripts',
  name: 'installed userscripts',
  needsElectron: false,

  async run(ctx) {
    const file = path.join(ctx.userData, 'userscripts.json');
    const store = ctx.readJsonSafe(file);
    const scripts = Array.isArray(store && store.scripts) ? store.scripts : [];
    const rows = scripts.map((s) => ({
      id: s.id,
      name: s.metadata && s.metadata.name,
      enabled: s.enabled,
      version: s.metadata && s.metadata.version,
      updatedAt: s.updatedAt,
      runAt: s.metadata && s.metadata.runAt,
      matchCount: s.metadata && s.metadata.match ? s.metadata.match.length : 0,
      background: Boolean(s.metadata && s.metadata.background),
      updateUrl: (s.metadata && s.metadata.updateUrl) || undefined,
      edited: Boolean(s.edited),
    }));
    const enabled = rows.filter((r) => r.enabled).length;
    return {
      ok: true,
      summary: `${rows.length} scripts (${enabled} enabled)`,
      detail: { file, scripts: rows },
    };
  },
};
