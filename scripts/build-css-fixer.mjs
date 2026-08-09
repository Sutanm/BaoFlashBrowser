// Builds the "BaoFlash Modern CSS Fixer" built-in userscript.
// Bundles css-fixer-entry.ts (+ postcss engine) into a single .user.js with
// the ==UserScript== metadata block prepended. The artifact is checked in so
// main-process builds and smokes always see a deterministic source.
//
//   node scripts/build-css-fixer.mjs
//
// The @updateHash field is a content hash of the bundled artifact (source +
// metadata). ensureBundledScripts compares it against the stored copy to
// decide whether to update, so shipping a fix no longer requires bumping
// @version by hand — any change to css-fixer source changes the hash.
import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'src', 'main', 'modules', 'userscripts', 'bundled-scripts', 'css-fixer.user.js');

const METADATA = `// ==UserScript==
// @name         BaoFlash Modern CSS Fixer
// @namespace    bao-flash-browser
// @version      0.5.7
// @description  Restores modern-CSS rules that Chromium 87 drops (:where/:is unwrap, @layer flatten, dvh, colors). Covers ruffle.rs + github.com; add more sites in the editor.
// @match        *://*.ruffle.rs/*
// @match        *://*.github.com/*
// @run-at       document-start
// ==/UserScript==
`;

await esbuild.build({
  entryPoints: ['src/main/modules/userscripts/bundled-scripts/css-fixer-entry.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome87',
  // Deliberately NOT minified: the artifact is shown in the script editor,
  // where a single-line minified bundle is unreadable. Still well under the
  // 512KB per-page source budget.
  minify: false,
  banner: { js: METADATA },
  outfile: OUT,
  logLevel: 'info',
});

// Compute a content hash of the bundled artifact and write it into the file's
// metadata block. Uses a short, stable hash (first 12 hex chars of sha1) —
// collision risk is negligible for update-signaling purposes. The hash covers
// the whole file including metadata, so any rebuild is correctly detected.
let file = fs.readFileSync(OUT, 'utf8');
const hash = crypto.createHash('sha1').update(file).digest('hex').slice(0, 12);
// Replace any existing @updateHash line, or inject one after @version.
if (/\n\/\/ @updateHash\s+\S+/.test(file)) {
  file = file.replace(/(\n\/\/ @updateHash\s+)\S+/, `$1${hash}`);
} else {
  file = file.replace(/(\n\/\/ @version\s+\S+)/, `$1\n// @updateHash  ${hash}`);
}
fs.writeFileSync(OUT, file, 'utf8');

const size = fs.statSync(OUT).size;
console.log(`[build-css-fixer] wrote ${OUT} (${(size / 1024).toFixed(1)} KB, updateHash=${hash})`);



