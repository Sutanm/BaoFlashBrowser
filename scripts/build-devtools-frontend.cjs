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

/**
 * 焦点描边只留给键盘：`:focus` → `:focus-visible`。
 *
 * M97 前端有一批「聚焦就画蓝框」的规则写的是 `:focus`（`.text-button`、`.close-button`、
 * 输入框等），而同一份资源里的工具栏按钮用的是 `:focus-visible`。鼠标点一下就出一圈
 * 蓝框、程序化 focus（例如设置页默认聚焦「添加自定义配置文件…」）也画，观感上就是
 * 「按钮莫名多了个蓝框」。
 *
 * 只改「画得出来」的描边：`outline:0 / none`、`outline-width:0` 是上游用来压掉原生
 * 描边的，改成 `:focus-visible` 反而会把原生描边放回来，必须原样保留。
 * 用 box-shadow 画 ring 的少数几处算同类（值里带 `focus-ring`），一并处理。
 * `:focus-visible` / `:focus-within` 用负前瞻排除，避免二次改写。
 */
const VISIBLE_OUTLINE = /outline\s*:\s*(?:auto|[1-9]|var\()|outline-width\s*:\s*(?:[1-9]|var\()|outline-color\s*:|box-shadow[^{};]*focus-ring/;

function keyboardOnlyFocus(text) {
  let count = 0;
  const next = text.replace(/([^{}]*)\{([^{}]*)\}/g, (match, selector, body) => {
    // 选择器里必须真有裸 `:focus`（不能是 `:focus-visible` / `:focus-within`）
    if (!/:focus(?![-:])/.test(selector)) return match;
    if (!VISIBLE_OUTLINE.test(body)) return match;
    count += 1;
    // 一条规则可能挂多个选择器（`td:focus, th:focus{}`），整组一起换
    return `${selector.replace(/:focus(?![-:])/g, ':focus-visible')}{${body}}`;
  });
  return { text: next, count };
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
      // 【兼容垫片，不是根因修复】87 在刷新《皮卡堂》这类"Flash 插件 + 子帧导航"的页面时，
      // 会让**刚成功用过一次**的 DOM 节点 ID 再次失效；而且这次失效对 CDP 会话完全不可见——
      // 抓桥的流水是：frameNavigated → documentUpdated → DOM.getDocument（拿到新文档）→
      // CSS 成功一次 → CSS 报 Could not find node with given id，中间没有任何 DOM 命令。
      // 对照：同一套刷新在纯 fixture、以及带跨域 iframe 的 fixture 上都不复现。
      // 结论：作废发生在 Chromium 87 的 DOM agent 里，应用层看不到也拦不住，只能事后自愈。
      //
      // 两级自愈（2026-11-09 Styles 永久转圈：同一 loader 内作废会**复发**，
      // 原"每 loader 一次"的本地恢复用完额度后就永久卡死，Flash 游戏页尤其频繁；
      // 用户实测的恢复手段「切外壳再切回当前页」本质是换 session = 全新 DOM agent）：
      //   第一级：150ms 合并、每 loader 一次的本地 documentUpdated（重取文档，快）；
      //   第二级：恢复后 1.5s 内同类错误仍在/复发 → 调 bfbBridge.rotate() 轮换会话
      //   （主进程 detach+attachToTarget，新 DOM agent 与节点 id 空间，带 3s 冷却）。
      //   成功路径取消轮换定时器，所以只有错误持续时才会真正轮换。
      [
        'async getMatchedStyles(e){const t=await this.agent.invoke_getMatchedStylesForNode({nodeId:e});if(t.getError())return null;',
        `async getMatchedStyles(e){
          const doc=this.#an.existingDocument();
          const node=this.#an.nodeForId(e);
          const resourceTree=this.target().model(Pr);
          const loader=resourceTree?.mainFrame?.loaderId;
          const t=await this.agent.invoke_getMatchedStylesForNode({nodeId:e});
          if(t.getError()){
            if(t.getError()==="Could not find node with given id"&&doc&&node&&loader&&
               this.#an.existingDocument()===doc){
              clearTimeout(this.bfbDocumentRecoveryTimer);
              this.bfbDocumentRecoveryTimer=setTimeout(()=>{
                if(resourceTree.mainFrame?.loaderId!==loader||this.#an.existingDocument()!==doc)return;
                if(this.bfbRecoveredLoader!==loader){
                  this.bfbRecoveredLoader=loader;
                  this.#an.documentUpdated();
                }
                clearTimeout(this.bfbRotateTimer);
                this.bfbRotateTimer=setTimeout(()=>{
                  try{window.bfbBridge&&window.bfbBridge.rotate&&window.bfbBridge.rotate()}catch(bfbErr){}
                },1500);
              },150);
            }
            return null;
          }
          clearTimeout(this.bfbRotateTimer);`,
      ],
      [
        // 【兼容垫片】getMatchedStyles 成功响应的**构建期**崩溃：响应引用的
        // styleSheetId 在前端 CSSModel 头部表里不存在（`header.sourceURL` 读 null
        // 抛 TypeError）。见主进程 devtoolbox-bridge.ts attach 的注释——根因是
        // replay 的 styleSheetAdded 事件落在空 listener 上蒸发，且后端对已启用
        // 的 CSS 域不重发头部。Promise 一旦 reject，Styles 面板永久 spinner。
        // 该状态 documentUpdated 兜不了（头部来自 styleSheetAdded，不随文档重取），
        // 唯一出路是轮换 session（新 session 上 enable 重新走一遍、事件落在已注册
        // 的 listener 上）。短暂延迟合并并发崩溃；桥内有 3s 冷却防风暴。
        'const n=this.#an.nodeForId(e);return n?await De.create({cssModel:this,node:n,inlinePayload:t.inlineStyle||null,attributesPayload:t.attributesStyle||null,matchedPayload:t.matchedCSSRules||[],pseudoPayload:t.pseudoElements||[],inheritedPayload:t.inherited||[],inheritedPseudoPayload:t.inheritedPseudoElements||[],animationsPayload:t.cssKeyframesRules||[],parentLayoutNodeId:t.parentLayoutNodeId,positionFallbackRules:t.cssPositionFallbackRules||[],propertyRules:t.cssPropertyRules??[],cssPropertyRegistrations:t.cssPropertyRegistrations??[],fontPaletteValuesRule:t.cssFontPaletteValuesRule}):null}',
        `const n=this.#an.nodeForId(e);if(!n)return null;try{
          return await De.create({cssModel:this,node:n,inlinePayload:t.inlineStyle||null,attributesPayload:t.attributesStyle||null,matchedPayload:t.matchedCSSRules||[],pseudoPayload:t.pseudoElements||[],inheritedPayload:t.inherited||[],inheritedPseudoPayload:t.inheritedPseudoElements||[],animationsPayload:t.cssKeyframesRules||[],parentLayoutNodeId:t.parentLayoutNodeId,positionFallbackRules:t.cssPositionFallbackRules||[],propertyRules:t.cssPropertyRules??[],cssPropertyRegistrations:t.cssPropertyRegistrations??[],fontPaletteValuesRule:t.cssFontPaletteValuesRule});
        }catch(bfbErr){
          clearTimeout(this.bfbRotateTimer);
          this.bfbRotateTimer=setTimeout(()=>{try{window.bfbBridge&&window.bfbBridge.rotate&&window.bfbBridge.rotate()}catch(e2){}},600);
          return null;
        }}`,
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
    // 前端工具栏自带的 ✕（DockController.closeButton，注册在 MAIN_TOOLBAR_RIGHT）
    // 和外壳抽屉顶栏的 ✕ 上下叠在同一列，动作又完全一样（都收起抽屉），
    // 看起来就是重复；而且只有 DevTools 页签有第二个 ✕，另外三个页签没有，
    // 切页签时更显不对称。这里直接不注册它，关闭统一交给外壳。
    file: 'entrypoints/main/main-meta.js',
    patches: [
      [
        'n.Toolbar.registerToolbarItem({loadItem:async()=>n.DockController.CloseButtonProvider.instance(),order:101,location:n.Toolbar.ToolbarItemLocation.MAIN_TOOLBAR_RIGHT,showLabel:void 0,condition:void 0,separator:void 0,actionId:void 0}),',
        '',
      ],
    ],
  },
  {
    file: 'ui/legacy/legacy.js',
    patches: [
      // 原生「停靠侧」菜单的勾选读的是前端自己的 dockSide()，而停靠由外壳决定
      // （我们刻意不让前端改 dockSide，否则它会在 BrowserView 里画出错的布局）。
      // 让 dockSide() 优先返回外壳推过来的值：右侧停靠时菜单就勾在右侧，
      // 而不是永远勾在初始的「底部」。
      [
        'dockSide(){return this.dockSideInternal}',
        'dockSide(){try{if(window.bfbBridge&&window.bfbBridge.dockSide){const s=window.bfbBridge.dockSide();if(s)return s}}catch(bfbErr){}return this.dockSideInternal}',
      ],
      // 上面把关闭按钮移除了，它为绝对定位的 ✕ 预留的 28px 右边距就没有意义，
      // 留着只会让 ⋮ 菜单离右边缘差一截。
      [
        '{margin-inline-end:28px}',
        '{margin-inline-end:0}',
      ],
    ],
  },
  {
    file: 'panels/elements/elements.js',
    patches: [
      // DOMNodeRevealer.reveal() 一进来就把 pendingNodeReveal 置 true，但**只有成功
      // 分支 l() 会复位**；三条失败分支（DeferredDOMNode 解析为空、远端对象推不回
      // 节点、找不到所属模型）都是直接 reject，标志位永远停在 true。之后
      // ElementsPanel.setDefaultSelectedNode() 里的
      //   if (!node || this.hasNonDefaultSelectedNode || this.pendingNodeReveal) return;
      // 就永久早退，面板再也选不上节点 → Styles 停在「找不到匹配的选择器或样式」。
      // 这里把 reject 包一层：任何失败先复位再交给原 reject。
      [
        'return s.pendingNodeReveal=!0,new Promise((function(e,o){if(t instanceof n.DOMModel.DOMNode)l(t);',
        'return s.pendingNodeReveal=!0,new Promise((function(e,o0){const o=function(bfbErr){s.pendingNodeReveal=!1,o0(bfbErr)};if(t instanceof n.DOMModel.DOMNode)l(t);',
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
  let patchedFocus = 0;
  const failures = [];

  for (const file of files) {
    const relative = path.relative(SRC, file);
    const target = path.join(OUT, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const ext = path.extname(file).toLowerCase();

    if (ext === '.css') {
      const focus = keyboardOnlyFocus(prefixMask(fs.readFileSync(file, 'utf-8')));
      patchedFocus += focus.count;
      fs.writeFileSync(target, focus.text);
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
    const focus = keyboardOnlyFocus(source);
    source = focus.text;
    patchedFocus += focus.count;
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
  // 工作区运行时（真实本地文件夹）：把 hosted mode 下宿主那五个假方法接管成
  // 「preload → IPC → 主进程 fs」。源码在 scripts/devtools-frontend/bfb-workspace.js。
  fs.copyFileSync(path.join(__dirname, 'devtools-frontend', 'bfb-workspace.js'), path.join(OUT, 'bfb-workspace.js'));
  // 三个入口都要前置：devtools_app.html 是实际加载的停靠壳，
  // inspector.html 保留给探针脚本对拍，其余场景按同一套行为。
  for (const name of ['inspector.html', 'devtools_app.html']) {
    const entryHtml = path.join(OUT, name);
    const html = fs.readFileSync(entryHtml, 'utf-8')
      .replace('<body', '<script src="./bfb-polyfills.js"></script>\n<script src="./bfb-workspace.js"></script>\n<body');
    fs.writeFileSync(entryHtml, html);
  }

  console.log(`[devtools-frontend] ${transformed} js downgraded, ${patchedTla} files patched, ${patchedFocus} focus rules scoped to :focus-visible, ${failures.length} failed → ${OUT}`);
  if (failures.length) {
    for (const failure of failures) console.warn('  !', failure);
    process.exit(1);
  }
})();
