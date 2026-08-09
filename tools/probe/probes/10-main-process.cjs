// Probe: main-process service health (offline verification). Loads the
// bundled userscript admin module exactly like the app does and checks it
// initializes against an isolated temporary userData store. Deep probes never
// mutate the running browser's real store.
'use strict';

const path = require('path');

module.exports = {
  id: '10-main-process',
  name: 'userscript manager health',
  needsElectron: true,

  async run(ctx) {
    const { app } = ctx.electron;
    const moduleFile = path.join(ctx.root, 'release', 'tests', 'userscripts-admin-module.cjs');
    if (!ctx.exists(moduleFile)) {
      return {
        ok: false,
        summary: 'module not built — run: node tests/electron/build-userscripts-admin-smoke.mjs',
        detail: { moduleFile },
      };
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(moduleFile);
    let manager;
    try {
      manager = mod.initUserscriptManager();
    } catch (error) {
      return {
        ok: false,
        summary: 'initUserscriptManager threw',
        detail: { error: error instanceof Error ? error.stack : String(error) },
      };
    }
    const installed = mod.listUserscripts();
    const persisted = ctx.readJsonSafe(path.join(ctx.userData, 'userscripts.json'));
    const persistedIds = Array.isArray(persisted && persisted.scripts)
      ? persisted.scripts.map((s) => s.id)
      : [];
    const storedIds = installed.map((s) => s.id);
    const mismatch = JSON.stringify(persistedIds) !== JSON.stringify(storedIds);
    return {
      ok: true,
      summary: `manager OK · ${installed.length} scripts` + (mismatch ? ' · STORE MISMATCH' : ' · store in sync'),
      detail: {
        userData: app.getPath('userData'),
        moduleFile,
        installed: installed.map((s) => ({ id: s.id, enabled: s.enabled, version: s.metadata && s.metadata.version })),
        storeSync: !mismatch,
      },
    };
  },
};
