#!/usr/bin/env node
/**
 * 把随应用分发的 DevTools 前端（`assets/devtools-frontend`，取自 chii 的构建产物，
 * 面板版本约 M97）降级到 Chromium 87 可用。
 *
 * 为什么要这一步：本项目锁死 Electron 11 / Chromium 87（Flash PPAPI 的硬约束），
 * 而现代 DevTools 前端用了 87 不认的语法与 API。三处差异都能机械修补：
 *
 *  1. top-level await（`const x = await import(...)`）→ 摘掉 await，
 *     受影响的分支（AIDA、Preloading 的 JSON 高亮）默认不启用。
 *  2. 语法降级 → esbuild `target: chrome87`。
 *  3. 运行时 API 与 CSS 属性前缀 → 生成 `bfb-polyfills.js` 并在 inspector.html 里前置，
 *     同时把 `mask*` 系列属性补 `-webkit-` 前缀（否则所有图标渲染成灰块）。
 *
 * 产物：`dist/devtools-frontend`（开发时由静态服务托管，打包时进 resources/）。
 *
 *   node scripts/build-devtools-frontend.cjs [outDir]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'assets', 'devtools-frontend');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'dist', 'devtools-frontend'));

const POLYFILL = `
/* DevTools 前端在 Chromium 87 上缺少的运行时 API（构建期注入，勿手改）。 */
if (!Object.hasOwn) {
  Object.hasOwn = function (target, key) { return Object.prototype.hasOwnProperty.call(target, key); };
}
if (!Array.prototype.at) {
  Object.defineProperty(Array.prototype, 'at', {
    value: function (index) {
      var length = this.length >>> 0;
      var n = Math.trunc(index) || 0;
      if (n < 0) n += length;
      return n < 0 || n >= length ? undefined : this[n];
    },
    writable: true, configurable: true,
  });
}
if (!String.prototype.at) {
  Object.defineProperty(String.prototype, 'at', {
    value: function (index) {
      var n = Math.trunc(index) || 0;
      return this.charAt(n < 0 ? this.length + n : n);
    },
    writable: true, configurable: true,
  });
}
if (!Array.prototype.findLast) {
  Object.defineProperty(Array.prototype, 'findLast', {
    value: function (predicate, thisArg) {
      for (var i = this.length - 1; i >= 0; i -= 1) { if (predicate.call(thisArg, this[i], i, this)) return this[i]; }
      return undefined;
    },
    writable: true, configurable: true,
  });
}
if (!Array.prototype.findLastIndex) {
  Object.defineProperty(Array.prototype, 'findLastIndex', {
    value: function (predicate, thisArg) {
      for (var i = this.length - 1; i >= 0; i -= 1) { if (predicate.call(thisArg, this[i], i, this)) return i; }
      return -1;
    },
    writable: true, configurable: true,
  });
}
if (!Array.prototype.toSorted) {
  Object.defineProperty(Array.prototype, 'toSorted', {
    value: function (compare) { return Array.prototype.slice.call(this).sort(compare); },
    writable: true, configurable: true,
  });
}
if (!Array.prototype.toReversed) {
  Object.defineProperty(Array.prototype, 'toReversed', {
    value: function () { return Array.prototype.slice.call(this).reverse(); },
    writable: true, configurable: true,
  });
}
if (!Array.prototype.toSpliced) {
  Object.defineProperty(Array.prototype, 'toSpliced', {
    value: function () {
      var copy = Array.prototype.slice.call(this);
      copy.splice.apply(copy, arguments);
      return copy;
    },
    writable: true, configurable: true,
  });
}
if (!Array.prototype.with) {
  Object.defineProperty(Array.prototype, 'with', {
    value: function (index, value) {
      var copy = Array.prototype.slice.call(this);
      var i = index < 0 ? copy.length + index : index;
      if (i < 0 || i >= copy.length) throw new RangeError('Invalid index');
      copy[i] = value;
      return copy;
    },
    writable: true, configurable: true,
  });
}
if (!Object.groupBy) {
  Object.groupBy = function (items, callback) {
    var result = Object.create(null);
    var index = 0;
    for (var item of items) {
      var key = callback(item, index += 1);
      (result[key] || (result[key] = [])).push(item);
    }
    return result;
  };
}
if (!Promise.withResolvers) {
  Promise.withResolvers = function () {
    var resolve; var reject;
    var promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
    return { promise: promise, resolve: resolve, reject: reject };
  };
}
if (!globalThis.structuredClone) {
  globalThis.structuredClone = function (value) { return JSON.parse(JSON.stringify(value)); };
}
if (!URL.canParse) {
  URL.canParse = function (input, base) { try { new URL(input, base); return true; } catch (e) { return false; } };
}
if (!URL.parse) {
  URL.parse = function (input, base) { try { return new URL(input, base); } catch (e) { return null; } };
}
`;

/**
 * Chrome 87 只认带前缀的 mask 系列属性（无前缀要到 Chrome 120）。
 * 带后缀的属性名不会出现在对象字面量里，可以安全改写；简写只在值像 CSS 引用时改。
 */
function prefixMask(text) {
  return text
    .replace(/(?<!-webkit-)mask(-image|-size|-position|-repeat|-composite)(\s*:)/g, '-webkit-mask$1$2')
    .replace(/(?<!-webkit-)mask(\s*:\s*(?:url\(|var\())/g, '-webkit-mask$1');
}

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

(async () => {
  if (!fs.existsSync(SRC)) {
    console.error(`[devtools-frontend] 缺少源资源目录：${SRC}`);
    process.exit(1);
  }
  if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true, force: true });

  const files = walk(SRC);
  let transformed = 0;
  let patchedTla = 0;
  const failures = [];

  for (const file of files) {
    const relative = path.relative(SRC, file);
    const target = path.join(OUT, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const ext = path.extname(file).toLowerCase();

    if (ext === '.css') {
      fs.writeFileSync(target, prefixMask(fs.readFileSync(file, 'utf-8')));
      continue;
    }
    if (ext !== '.js') {
      fs.copyFileSync(file, target);
      continue;
    }

    let source = fs.readFileSync(file, 'utf-8');
    const before = source;
    source = source.replace(/\bawait import\(/g, 'import(');
    source = prefixMask(source);
    if (source !== before) patchedTla += 1;

    // 剩余的顶层 await：按 esbuild 报的精确行列逐个摘掉，避免误伤 async 函数体内部
    let code = null;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      try {
        const result = await esbuild.transform(source, {
          loader: 'js', format: 'esm', target: 'chrome87', sourcefile: relative, legalComments: 'none',
        });
        code = result.code;
        break;
      } catch (error) {
        const located = /:(\d+):(\d+): ERROR: Top-level await/.exec(String(error.message));
        if (!located) {
          failures.push(`${relative}: ${String(error.message).split('\n').slice(0, 2).join(' ')}`);
          break;
        }
        const line = Number(located[1]);
        const column = Number(located[2]);
        const lines = source.split('\n');
        let index = 0;
        for (let i = 0; i < line - 1 && i < lines.length; i += 1) index += lines[i].length + 1;
        index += column;
        if (!source.startsWith('await', index)) {
          failures.push(`${relative}: 无法在 ${line}:${column} 定位 await`);
          break;
        }
        source = `${source.slice(0, index)}${source.slice(index + 6)}`;
        patchedTla += 1;
      }
    }

    if (code === null) fs.copyFileSync(file, target);
    else {
      fs.writeFileSync(target, code);
      transformed += 1;
    }
  }

  fs.writeFileSync(path.join(OUT, 'bfb-polyfills.js'), POLYFILL);
  const indexHtml = path.join(OUT, 'inspector.html');
  const html = fs.readFileSync(indexHtml, 'utf-8').replace('<body', '<script src="./bfb-polyfills.js"></script>\n<body');
  fs.writeFileSync(indexHtml, html);

  console.log(`[devtools-frontend] ${transformed} js downgraded, ${patchedTla} files patched, ${failures.length} failed → ${OUT}`);
  if (failures.length) {
    for (const failure of failures) console.warn('  !', failure);
    process.exit(1);
  }
})();
