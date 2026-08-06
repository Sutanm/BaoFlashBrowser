// Probe: build artifact freshness. Compares each product against the newest
// mtime of its source tree and reports which build command is stale. This is
// the #1 cause of "I ran the smoke and it tested OLD code" time sinks.
'use strict';

const path = require('path');

module.exports = {
  id: '00-build',
  name: 'build artifact freshness',
  needsElectron: false,

  async run(ctx) {
    const pairs = [
      {
        name: 'main (dist/main.js)',
        product: path.join(ctx.root, 'dist', 'main.js'),
        sources: ['src/main/index.ts', 'src/main', 'src/shared'],
        build: 'npm run build:main',
      },
      {
        name: 'preload (dist/preload.js)',
        product: path.join(ctx.root, 'dist', 'preload.js'),
        sources: ['src/preload/index.ts'],
        build: 'npm run build:main',
      },
      {
        name: 'webview-preload (dist/webview-preload.js)',
        product: path.join(ctx.root, 'dist', 'webview-preload.js'),
        sources: ['src/webview-preload/index.ts', 'src/webview-preload', 'src/shared'],
        build: 'npm run build:main',
      },
      {
        name: 'renderer (dist/renderer/)',
        product: path.join(ctx.root, 'dist', 'renderer'),
        sources: ['src/renderer', 'src/shared'],
        build: 'npm run build:renderer',
      },
      {
        name: 'userscripts admin module (release/tests/userscripts-admin-module.cjs)',
        product: path.join(ctx.root, 'release', 'tests', 'userscripts-admin-module.cjs'),
        sources: ['src/main/modules/userscripts', 'src/shared'],
        build: 'node tests/electron/build-userscripts-admin-smoke.mjs',
      },
      {
        name: 'userscript runtime preload (release/tests/userscript-runtime-preload.cjs)',
        product: path.join(ctx.root, 'release', 'tests', 'userscript-runtime-preload.cjs'),
        sources: ['src/webview-preload/userscripts', 'src/shared'],
        build: 'node tests/electron/build-userscript-runtime-smoke.mjs',
      },
      {
        name: 'compatibility smoke (release/tests/session-compatibility-smoke.cjs)',
        product: path.join(ctx.root, 'release', 'tests', 'session-compatibility-smoke.cjs'),
        sources: ['src/main/modules/session-manager.ts', 'tests/electron/session-compatibility-smoke.ts'],
        build: 'node tests/electron/build-compatibility-smoke.mjs',
      },
    ];

    const entries = pairs.map((pair) => {
      const sourceMtime = Math.max(...pair.sources.map((s) => ctx.latestMtime(path.join(ctx.root, s))));
      const productMtime = ctx.latestMtime(pair.product);
      return {
        name: pair.name,
        product: pair.product,
        exists: productMtime > 0,
        sourceMtime,
        productMtime,
        stale: productMtime > 0 && sourceMtime > productMtime + 1000, // 1s clock slack
        build: pair.build,
      };
    });

    const stale = entries.filter((e) => e.stale);
    const missing = entries.filter((e) => !e.exists);
    const summary = stale.length > 0
      ? `${stale.length} STALE: ${stale.map((e) => e.name.split(' ')[0]).join(', ')}`
      : missing.length > 0
        ? `${missing.length} missing (never built)`
        : 'all fresh';
    return { ok: stale.length === 0, summary, detail: { entries, stale, missing } };
  },
};
