// Ensure the release/tests/ smoke bundles are newer than their sources.
//
// Usage:
//   node scripts/ensure-build.cjs           # rebuild anything stale
//   node scripts/ensure-build.cjs --check   # report staleness, build nothing
//   node scripts/ensure-build.cjs --quiet   # only speak up when something changed
//
// Exits 0 when everything is (or was made) current, 1 when a build fails, and —
// with --check — 1 when something is stale. The check mode is what CI and the
// freshness probe want; the default mode is what the npm test scripts want, so a
// smoke can never run against stale code.
//
// Deliberately builds EVERY bundle rather than taking per-bundle ids: it costs
// ~50ms when nothing is stale, and bundles are not one-to-one with smokes (most
// smokes load both the runtime preload and the admin module), so a hand-picked
// subset is an easy way to test stale code again.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { SMOKE_BUNDLES, SMOKE_SOURCES } = require('./smoke-bundles.cjs');

const root = path.resolve(__dirname, '..');

/** Newest mtime (ms) under a file or directory tree; 0 when it does not exist. */
function newestMtime(relative) {
  const target = path.join(root, relative);
  let stats;
  try {
    stats = fs.statSync(target);
  } catch {
    return 0;
  }
  if (!stats.isDirectory()) return stats.mtimeMs;
  let newest = stats.mtimeMs;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(child);
      } else {
        try {
          const mtime = fs.statSync(child).mtimeMs;
          if (mtime > newest) newest = mtime;
        } catch {
          /* ignore files that vanish mid-walk */
        }
      }
    }
  };
  walk(target);
  return newest;
}

const argv = process.argv.slice(2);
const known = ['--check', '--quiet'];
const unknown = argv.filter((arg) => !known.includes(arg));
if (unknown.length > 0) {
  console.error(`[ensure-build] unknown argument(s): ${unknown.join(', ')}`);
  console.error(`[ensure-build] usage: node scripts/ensure-build.cjs [--check] [--quiet]`);
  process.exit(1);
}
const checkOnly = argv.includes('--check');
const quiet = argv.includes('--quiet');

// 1s slack: filesystem timestamp granularity and same-second edits must not read
// as stale (matches the freshness probe).
const SLACK_MS = 1000;
const newestSource = SMOKE_SOURCES.reduce((newest, source) => Math.max(newest, newestMtime(source)), 0);

const stale = SMOKE_BUNDLES.filter((bundle) => {
  let productMtime = 0;
  try {
    productMtime = fs.statSync(path.join(root, bundle.product)).mtimeMs;
  } catch {
    productMtime = 0;
  }
  return productMtime === 0 || newestSource > productMtime + SLACK_MS;
});

if (stale.length === 0) {
  if (!quiet) console.log(`[ensure-build] ${SMOKE_BUNDLES.length} smoke bundle(s) up to date`);
  process.exit(0);
}

if (checkOnly) {
  for (const bundle of stale) {
    console.log(`[ensure-build] STALE ${bundle.id} (${bundle.what}): ${bundle.product}`);
  }
  process.exit(1);
}

// One build script can produce more than one bundle (the runtime smoke script
// writes both the preload and the smoke entry), so run each script once.
const scripts = [...new Set(stale.map((bundle) => bundle.build))];

for (const script of scripts) {
  console.log(`[ensure-build] building ${script}`);
  const result = spawnSync(process.execPath, [path.join(root, script)], { cwd: root, stdio: 'inherit' });
  if (result.error) {
    console.error(`[ensure-build] failed to run ${script}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[ensure-build] ${script} exited ${result.status}`);
    process.exit(1);
  }
}

console.log(`[ensure-build] rebuilt: ${stale.map((bundle) => bundle.id).join(', ')}`);
process.exit(0);
