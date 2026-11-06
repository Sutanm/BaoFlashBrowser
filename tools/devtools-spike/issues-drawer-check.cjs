#!/usr/bin/env node
/**
 * 静态核对 DevTools 前端的「问题(issues)」面板注册方式。
 *
 * 结论先行：issues-pane 注册在 `location: "drawer-view"`，也就是**底部抽屉**面板，
 * 与 Chrome 一致——点红色问题计数会在抽屉里切到「问题」，不占主标签位。
 * 这不是我们的壳造成的，改壳也改不了它的归属。
 *
 * 这个脚本只读构建产物，用来在升级/重建前端后复核这条前提没变：
 *   node tools/devtools-spike/issues-drawer-check.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const CANDIDATES = [
  'dist/devtools-frontend/panels/issues/issues-meta.js',
  'dist/devtools-frontend/entrypoints/devtools_app/devtools_app.js',
];

let checked = 0;
let failures = 0;
for (const rel of CANDIDATES) {
  const file = path.join(APP_ROOT, rel);
  if (!fs.existsSync(file)) {
    console.log(`[issues] 跳过（不存在）: ${rel}`);
    continue;
  }
  const source = fs.readFileSync(file, 'utf8');
  const at = source.indexOf('"issues-pane"');
  if (at < 0) {
    console.log(`[issues] 跳过（没有 issues-pane）: ${rel}`);
    continue;
  }
  checked += 1;
  const snippet = source.slice(Math.max(0, at - 160), at + 60);
  const drawer = /location:\s*"drawer-view"/.test(snippet) || /location:\s*'drawer-view'/.test(snippet);
  console.log(`[issues] ${rel}`);
  console.log(`  ${drawer ? 'OK  ' : 'FAIL'} location=${drawer ? 'drawer-view' : '(不是 drawer-view)'}`);
  console.log(`  片段: ${snippet.replace(/\s+/g, ' ').trim().slice(0, 120)}`);
  if (!drawer) failures += 1;
}

if (checked === 0) {
  console.log('[issues] 没找到 issues-pane 注册（前端产物可能没构建）');
  process.exit(2);
}
console.log(`[issues] 检查 ${checked} 处，失败 ${failures} 处`);
process.exit(failures === 0 ? 0 : 1);
