// Single source of truth for the Electron smoke bundles under release/tests/.
//
// Why this exists
// ---------------
// `npm run build` deliberately does NOT build these (they are smoke-only
// artifacts). Each is produced by its own tests/electron/build-*.mjs. That made
// it easy to edit a source file, run a smoke, and silently test STALE code —
// documented as a landmine in AGENTS.md and hit repeatedly in practice.
//
// `tools/probe/probes/00-build.cjs` already computed staleness, but with its own
// private copy of the product paths, so the two drifted (the probe knew about
// some bundles and not others). This module is that knowledge's one home.
//
// Shape
// -----
// Only stable facts live here: the bundle id, the product it writes, and the
// script that builds it. The set of source files a bundle pulls in is NOT listed
// deliberately — `src/shared` (among others) feeds nearly every bundle, so any
// hand-maintained per-bundle source list would drift immediately. Staleness is
// therefore judged by directory-tree mtimes, and the npm scripts simply call
// `ensure-build.cjs` every time: rebuilding is idempotent and costs milliseconds
// when nothing changed.
'use strict';

/**
 * @typedef {object} SmokeBundle
 * @property {string} id       stable short name used on the command line
 * @property {string} product  repo-relative artifact path
 * @property {string} build    repo-relative build script (run with `node`)
 * @property {string} what     human-readable description for log lines
 */

/** @type {readonly SmokeBundle[]} */
const SMOKE_BUNDLES = Object.freeze([
  {
    id: 'userscripts-admin',
    product: 'release/tests/userscripts-admin-module.cjs',
    build: 'tests/electron/build-userscripts-admin-smoke.mjs',
    what: 'user script admin service bundle',
  },
  {
    id: 'userscript-runtime',
    product: 'release/tests/userscript-runtime-preload.cjs',
    build: 'tests/electron/build-userscript-runtime-smoke.mjs',
    what: 'full production BrowserView preload',
  },
  {
    id: 'userscript-runtime-smoke',
    product: 'release/tests/userscript-runtime-smoke.cjs',
    build: 'tests/electron/build-userscript-runtime-smoke.mjs',
    what: 'user script runtime smoke entry',
  },
  {
    id: 'compatibility',
    product: 'release/tests/session-compatibility-smoke.cjs',
    build: 'tests/electron/build-compatibility-smoke.mjs',
    what: 'session compatibility smoke',
  },
  {
    id: 'automation-authoring',
    product: 'release/tests/automation-authoring-core.cjs',
    build: 'tests/electron/build-automation-authoring-smoke.mjs',
    what: 'automation authoring core',
  },
  {
    id: 'automation-js-sandbox',
    product: 'release/tests/automation-js-sandbox-host.cjs',
    build: 'tests/electron/build-automation-js-sandbox.mjs',
    what: 'automation JavaScript sandbox host',
  },
]);

/**
 * Source trees whose newest mtime decides whether a bundle is stale.
 * Repo-relative; a missing entry is ignored so the list stays safe on partial
 * checkouts.
 * @type {readonly string[]}
 */
const SMOKE_SOURCES = Object.freeze([
  'src/main',
  'src/shared',
  'src/webview-preload',
  'src/preload',
  'tests/electron/fixtures',
  'tests/electron/session-compatibility-smoke.ts',
  'tests/electron/userscript-runtime-smoke-entry.ts',
]);

/** Look up one bundle by id; throws with the known ids when the id is unknown. */
function findBundle(id) {
  const found = SMOKE_BUNDLES.find((bundle) => bundle.id === id);
  if (found) return found;
  throw new Error(
    `unknown smoke bundle "${id}"; known ids: ${SMOKE_BUNDLES.map((b) => b.id).join(', ')}`,
  );
}

module.exports = { SMOKE_BUNDLES, SMOKE_SOURCES, findBundle };
