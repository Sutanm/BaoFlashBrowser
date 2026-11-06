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
if (typeof globalThis.Highlight === 'undefined') {
  // CSS Custom Highlight API 的构造器是 Chrome 105+ 才有；M97 前端在
  // ui/components/highlighting 里用类字段 #s = new Highlight() 初始化，
  // 87 上缺这个全局符号会直接炸掉 Elements 树渲染（树空白）。
  // 替身给出 Set 的形状让调用面（add/delete）活着；底色渲染交给下面的
  // CSS.highlights no-op（87 画不了 custom highlight，但面板不再空）。
  globalThis.Highlight = class Highlight {
    constructor() { this._ranges = new Set(); }
    add(range) { return this._ranges.add(range); }
    delete(range) { return this._ranges.delete(range); }
    has(range) { return this._ranges.has(range); }
    clear() { this._ranges.clear(); }
    get size() { return this._ranges.size; }
    [Symbol.iterator]() { return this._ranges[Symbol.iterator](); }
  };
}
if (typeof globalThis.CSS !== 'undefined' && !globalThis.CSS.highlights) {
  try {
    Object.defineProperty(globalThis.CSS, 'highlights', {
      configurable: true,
      value: {
        set() { /* 87 不渲染 custom highlight，只保证调用不抛 */ },
        get() { return undefined; },
        delete() { return true; },
        clear() { /* no-op */ },
      },
    });
  } catch (error) { /* CSS.highlights 不可写时不致命 */ }
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

/**
 * 源级补丁：上游格式是压缩单行，运行时 polyfill 覆盖不了的场景按精确字面量改写。
 * 命中失败会记入 failures 并让构建退出非零——上游资源一旦更新漂移，这里必须大声报。
 */
const SOURCE_PATCHES = [
  {
    file: 'core/sdk/sdk.js',
    patches: [
      // Chromium 87 的 Network.requestWillBeSentExtraInfo 不带 connectTiming，
      // M97 前端拿 undefined 去 .requestTime → 每个请求都抛 TypeError。
      [
        'setConnectTimingFromExtraInfo(e){this.#Ei=e.requestTime',
        'setConnectTimingFromExtraInfo(e){if(!e)return;this.#Ei=e.requestTime',
      ],
    ],
  },
  {
    file: 'core/i18n/i18n.js',
    patches: [
      // 语言默认值：`language` 设置的 defaultValue 是 "en-US"，而 DevToolsLocale 只在
      // 值为 "browserLanguage" 时才用 navigator.language。结果就是**无视系统语言永远是英文**
      // （实测：iframe 里 navigator.language 已是 zh-CN，界面却是英文 + 弹"切换到中文"横幅）。
      //
      // 我们也没有别的持久化手段：静态服务每个启动都换随机端口 → origin 变 →
      // localStorage 隔离，设置每次回到默认（settings-persistence-check.cjs 实测）。
      // 自定义 scheme 也没救（Electron 11 上完全没有 DOM storage，scheme-feasibility.cjs）。
      //
      // 所以把「没存过设置」等价于「跟随浏览器」：只有 localStorage 里没有 language 键
      // 时才用 navigator.language。**必须判"有没有存过"，不能只看值等于 "en-US"**——
      // 用户显式选英文时存的就是 "en-US"，与默认值同值，误判会让用户选了英文还是中文。
      [
        '"browserLanguage"===e.settingLanguage?this.locale=e.navigatorLanguage||"en-US":this.locale=e.settingLanguage',
        '("browserLanguage"===e.settingLanguage||("en-US"===e.settingLanguage&&!(()=>{try{return localStorage.getItem("language")}catch{return null}})()))?this.locale=e.navigatorLanguage||"en-US":this.locale=e.settingLanguage',
      ],
    ],
  },
  {
    file: 'ui/legacy/legacy.js',
    patches: [
      // 语言横幅（"DevTools is now available in Chinese!"）的触发条件原来只看
      // **原始设置值** 是否等于默认 "en-US"：设置是 en-US、浏览器是中文 → 就弹。
      // 但 i18n.js 的补丁让"默认（没存过）"时实际生效的 locale 已经跟随浏览器，
      // 于是界面明明是中文、横幅还在喊"可以切换成中文" —— 自相矛盾。
      //
      // 所以这里改成看**实际生效的 locale**：
      //   1) 设置被显式改过（≠ en-US）→ 不提示
      //   2) 用户显式存过 language → 不提示（"不再显示"标记存不住，只能看这个）
      //   3) 生效 locale 与 navigator.language 同语言 → 不提示（这才是本次修的点）
      // 三条都不成立才提示，即"设置是默认英文、但浏览器语言是 DevTools 支持的非英文"。
      [
        'if("en-US"!==i)return!1;return!t.DevToolsLocale.localeLanguagesMatch(navigator.language,i)',
        'if("en-US"!==i)return!1;if((()=>{try{return localStorage.getItem("language")}catch{return null}})())return!1;if(t.DevToolsLocale.localeLanguagesMatch(navigator.language,t.DevToolsLocale.DevToolsLocale.instance().locale))return!1;return!t.DevToolsLocale.localeLanguagesMatch(navigator.language,i)',
      ],
    ],
  },
  {
    file: 'ui/components/highlighting/highlighting.js',
    patches: [
      // 87 的 document.adoptedStyleSheets 已是冻结数组（push 抛 TypeError），
      // 整体赋值语义可用且样式真实生效（探针 tools/devtools-spike/adopted-probe.cjs）。
      [
        'constructor(){document.adoptedStyleSheets.push(t),',
        'constructor(){document.adoptedStyleSheets=[...document.adoptedStyleSheets,t],',
      ],
    ],
  },
  {
    // 原生 DevTools 自带的「停靠侧」菜单与关闭按钮，改成把意图交给外壳。
    // 前端跑在 BrowserView 里，自己 setDockSide 只会画出错的布局（主区空白 /
    // 标签条换边），关闭更是完全没有宿主可关。外壳的 store 才是唯一事实源。
    file: 'entrypoints/main/main.js',
    patches: [
      [
        'function i(e){E.DockController.DockController.instance().once("AfterDockSideChanged").then((()=>{o.focus()})),E.DockController.DockController.instance().setDockSide(e),t.discard()}',
        'function i(e){if(window.bfbBridge){try{window.bfbBridge.shell({dock:e})}catch(bfbErr){}t.discard();return}E.DockController.DockController.instance().once("AfterDockSideChanged").then((()=>{o.focus()})),E.DockController.DockController.instance().setDockSide(e),t.discard()}',
      ],
    ],
  },
  {
    file: 'core/host/host.js',
    patches: [
      // 前端工具栏的 ✕ 走 InspectorFrontendHost.closeWindow()，原生宿主里是
      // 真的关窗口；我们这套壳里它是空实现，点了没反应。改成交给外壳收起抽屉。
      [
        'closeWindow(){}setIsDocked(e,o){window.setTimeout(o,0)}',
        'closeWindow(){try{window.bfbBridge&&window.bfbBridge.shell({close:!0})}catch(bfbErr){}}setIsDocked(e,o){window.setTimeout(o,0)}',
      ],
    ],
  },
  {
    file: 'panels/emulation/emulation.js',
    patches: [
      // 抽屉以 `can_dock=true` 起 AdvancedApp（唯一停靠壳），DockController 的默认
      // dockSide 是 "right"，`updateForDocked()` 末尾 `showBoth()` 会把主区显示出来。
      // 真 DevTools 里主区由宿主窗口绘制被检查页面，我们跑在 iframe 里没有宿主，
      // showBoth 只会得到一块空白占位；改成 hideMain 让 InspectorView 独占整宽。
      // 保留 "right" 而不是切 "undocked"：后者会在首次 setDockSide 时触发
      // AdvancedApp.openToolboxWindow() 的 window.open(设备模式 frame)。
      [
        'this.rootSplitWidget.showBoth()}updateForUndocked(){',
        'this.rootSplitWidget.hideMain()}updateForUndocked(){',
      ],
    ],
  },
  {
    file: 'core/sdk/sdk.js',
    patches: [
      // 桥（规格 2026-11-06-devtools-cdp-bridge-design.md，B3 迁到 preload）：
      // 无 ws/wss/embedded 参数且页面里存在 `window.bfbBridge` 时，用它代替
      // WebSocketConnection。前端只认 WebSocket 是"必须开端口"的唯一原因；
      // 这条分支让前端改走 preload → IPC → 主进程桥（flatten session），
      // 端口退化为桥的内部后端。
      //
      // 判据从「在 iframe 里」换成「bfbBridge 存在」：B3 之后前端跑在独立
      // BrowserView（file://），既不是 iframe 也没有 parent，但 preload 一定会
      // 把它暴露出来；旧的 http+iframe 排障路径没有 preload，自然落到 page-ws。
      [
        'function vs(e){const t=a.Runtime.Runtime.queryParam("ws")',
        'class BfbBridgeConnection{onMessage;#lo;#uo;#bo;#go;constructor(e,t){this.onMessage=null,this.#lo=null,this.#uo=t,this.#bo=!1,this.#go=[],window.bfbBridge.onOpen(()=>this.onOpen()),window.bfbBridge.onMessage((m)=>{this.onMessage&&this.onMessage.call(null,m)}),window.bfbBridge.onDisconnect((r)=>{this.#lo&&this.#lo.call(null,r||"bridge detached")})}setOnMessage(e){this.onMessage=e}setOnDisconnect(e){this.#lo=e}onOpen(){this.#bo=!0;const q=this.#go;this.#go=[],q.forEach((m)=>this.#send(m)),this.#uo&&this.#uo.call(null)}sendRawMessage(m){this.#bo?this.#send(m):this.#go.push(m)}#send(m){window.bfbBridge.send(m)}disconnect(){return Promise.resolve()}}function vs(e){const t=a.Runtime.Runtime.queryParam("ws")',
      ],
      [
        'if(r)return new ms(r);if(t||n){',
        'if(r)return new ms(r);if(!t&&!n&&window.bfbBridge)return new BfbBridgeConnection(e);if(t||n){',
      ],
    ],
  },
];

function applySourcePatches(relative, source, failures) {
  for (const entry of SOURCE_PATCHES) {
    if (entry.file !== relative.replace(/\\/g, '/')) continue;
    for (const [pattern, replacement] of entry.patches) {
      if (source.indexOf(pattern) === -1) {
        failures.push(`${relative}: 源补丁未命中: ${pattern.slice(0, 60)}`);
        continue;
      }
      source = source.replace(pattern, replacement);
    }
  }
  return source;
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
    source = applySourcePatches(relative, source, failures);
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
  // 两个入口都要前置 polyfill：inspector.html 是 screencast 壳（保留给探针脚本对拍），
  // devtools_app.html 是应用实际加载的停靠壳入口。
  for (const name of ['inspector.html', 'devtools_app.html']) {
    const entryHtml = path.join(OUT, name);
    const html = fs.readFileSync(entryHtml, 'utf-8').replace('<body', '<script src="./bfb-polyfills.js"></script>\n<body');
    fs.writeFileSync(entryHtml, html);
  }

  console.log(`[devtools-frontend] ${transformed} js downgraded, ${patchedTla} files patched, ${failures.length} failed → ${OUT}`);
  if (failures.length) {
    for (const failure of failures) console.warn('  !', failure);
    process.exit(1);
  }
})();
