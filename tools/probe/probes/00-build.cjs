// Probe: build artifact freshness. Compares each product against the newest
// mtime of its source tree and reports which build command is stale. This is
// the #1 cause of "I ran the smoke and it tested OLD code" time sinks.
//
// The release/tests/ smoke bundles are described by scripts/smoke-bundles.cjs so
// this probe and scripts/ensure-build.cjs cannot drift apart. They previously
// kept private, diverging lists — the probe silently ignored several bundles
// (automation-authoring-core, automation-js-sandbox-host).
'use strict';

const path = require('path');
// probes/ -> probe/ -> tools/ -> repo root
const { SMOKE_BUNDLES, SMOKE_SOURCES } = require(path.join(__dirname, '..', '..', '..', 'scripts', 'smoke-bundles.cjs'));

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
      // Smoke bundles come from the shared manifest; rebuild one with
      // `node scripts/ensure-build.cjs <id>`, or all of them without an id.
      ...SMOKE_BUNDLES.map((bundle) => ({
        name: `${bundle.id} (${bundle.what})`,
        product: path.join(ctx.root, bundle.product),
        sources: SMOKE_SOURCES,
        build: `node scripts/ensure-build.cjs ${bundle.id}`,
      })),
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
