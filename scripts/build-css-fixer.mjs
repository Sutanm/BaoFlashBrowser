// Builds the "BaoFlash Modern CSS Fixer" built-in userscript.
// Bundles css-fixer-entry.ts (+ postcss engine) into a single .user.js with
// the ==UserScript== metadata block prepended. The artifact is checked in so
// main-process builds and smokes always see a deterministic source.
//
//   node scripts/build-css-fixer.mjs
import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'src', 'main', 'modules', 'userscripts', 'bundled-scripts', 'css-fixer.user.js');

const METADATA = `// ==UserScript==
// @name         BaoFlash Modern CSS Fixer
// @namespace    bao-flash-browser
// @version      0.3.3
// @description  Restores modern-CSS rules that Chromium 87 drops (:where/:is unwrap + dvh). Default @match covers ruffle.rs; add more sites in the editor.
// @match        *://*.ruffle.rs/*
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

const size = fs.statSync(OUT).size;
console.log(`[build-css-fixer] wrote ${OUT} (${(size / 1024).toFixed(1)} KB)`);



