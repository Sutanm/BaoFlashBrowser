# 设计：css-has-pseudo 集成 + js-patch esbuild 按需转译

日期：2026-08-06
状态：待审阅

## 背景

Chromium 87（Electron 11 锁定）缺失多种现代 Web/CSS 能力，本项目通过三层机制补偿：

1. **core-js polyfill**（页面主世界注入）——Web API（randomUUID/.at/structuredClone 等）
2. **CSS Fixer 用户脚本**（文本层重写）——`:where`/`:is` 解包、`@layer` 展平、嵌套展平、dvh、颜色转换、容器查询 polyfill
3. **js-patch-service**（主进程 URL 层）——`static{}` 静态块正则补丁（`STATIC_BLOCK_RE`）

GitHub 审计（0 console 错误，样式已恢复）确认**唯一剩余缺口**是 `:has()` 选择器（约 170 处，C87 整条规则丢弃）。经评估（实测验证），`lightningcss` 不处理 `@layer`/`:where`/`dvh`（保留自研），主进程 URL 层 CSS 架构重构收益不足以覆盖成本——均否决。采用两个增量：

## 范围

### Part 1：css-has-pseudo 集成（CSS Fixer v0.4.2）

依赖：`css-has-pseudo@8.0.1`（CSSTools 官方，MIT-0 许可，npm 包含 PostCSS 插件 + 浏览器运行时 `dist/browser-global.js` 11.9KB，压缩 ES5，C87 直接兼容）。

**机制**（官方设计，与 Fixer 文本层架构天然吻合）：

- 转换层（PostCSS 插件）：`E:has(F)` → `[csstools-has-<base36编码F>]:not(does-not-exist)`，`preserve: false` 不保留原规则
- 运行时（browser-global.js）：从 CSSOM 解码 `csstools-has-` 属性 → `querySelectorAll(F)` 找匹配元素 → 设置标记属性 → 转换后的规则匹配。自带：
  - MutationObserver（childList + attributes + 大 attributeFilter 列表）
  - focus/blur/input/change 事件（覆盖表单 label 浮动等值变化场景）
  - 原型属性 setter 拦截（disabled/checked/value 等）
  - `querySelector/All/matches/closest` 的 `:has()` JS API polyfill
  - 运行时会把规则里的 `.js-has-pseudo ` 前缀剥除（无需 html 标记类）

**集成点**：

| 文件 | 改动 |
|---|---|
| `css-fixer-core.ts` | `needsRewrite` 增加 `:has(` 检查；`rewriteCssText` 在含 `:has` 时追加 `postcss([hasPseudoPlugin({ preserve: false })]).process(css)`（仅含 `:has` 的文件触发，避免双解析开销）。**保持浏览器平台纯函数**（不引入任何 Node 依赖） |
| `css-fixer-entry.ts` | import vendor `browser-global.js`（拷贝至 `bundled-scripts/vendor/`，与 container-query-polyfill 同模式）；**`cssHasPseudo(document)` 在 `start()` 内 `fixNextImages(document)` 之后调用**（documentElement 已就绪；Fixer 后续替换的 `<style>` 由运行时自带 MutationObserver 捕获 walkStyleSheet，无需额外协调） |
| `scripts/build-css-fixer.mjs` | 版本 0.4.2；bundle 体积约 +12KB（预算 512KB 内） |

**性能**：含 `:has` 的文件（GitHub 仅 4 个）每次重写额外一次 postcss 解析（约 +150ms/文件）；运行时标记经 requestAnimationFrame 节流。

### Part 2：js-patch esbuild 按需转译（主进程）

**动机**：现有正则 `STATIC_BLOCK_RE` 仅匹配简单赋值形式 `static{this.X=ref}`；复杂静态块（多语句、函数调用、表达式）漏补丁 → chunk 整段语法错误。esbuild 边界完备且已在 Electron 11 主进程实测可用（33ms transform）。实测 esbuild 0.28.1 支持 `using` 声明降级（转译 `__using` helper）。

**集成点**（`js-patch-service.ts`；**不动 `css-fixer-core.ts`**——其 `patchModernJs` 被 bundle 进浏览器用户脚本，Node 依赖禁止进入）：

1. 新增 `patchModernJsAsync(text): Promise<string | null>`（仅 js-patch-service 使用）：
   - 预检正则 **`/static\s*\{|\busing\s+\w/`**（仅两项：类静态块 `static{`/`static {`；`using` 声明——`\b` 边界避免 `myUsing` 误命中）。**不包含 `class\s+\w+\s*\{` 或 `\.static\s*=`**（class 声明是 ES6/C87 原生支持，`obj.static = 1` 是普通赋值——误命中会让 esbuild 成为常态路径，破坏零开销承诺）命中才走 esbuild，否则 `return null`（零开销）
   - `require('esbuild').transform(text, { target: 'chrome87', loader: 'js' })`（**同步 require**，esbuild 是 CJS；transform 不改模块格式，保留 import/export；helper 默认内联不依赖外部 import）
   - 失败回退链：esbuild 抛错 → `patchModernJs(text)`（现有正则，同步）→ 原样返回；catch 中 `log.warn('[js-patch] esbuild transform failed, falling back to regex', src, error.message)`（沿用现有 115 行日志模式）
   - 返回值语义：**esbuild 输出与输入相同（无实际改动）时返回 `null`**（避免缓存无意义重复）
2. `registerBufferProtocol` 的 `.then` 链改为 `.then(async (text) => { const patched = await patchModernJsAsync(text); ...; callback({...}) })`——callback 仍在 promise 链内调用（现状 fetchText 本身异步，callback 本就异步调用；不改变契约）
3. `esbuild.main.config.mjs`：`external` 增加 `'esbuild'`（否则 esbuild 包被 bundle 进 dist/main.js 且二进制路径解析失败；`require('esbuild')` 静态分析后 external 化）
4. chunk 缓存 value 增加 `mode: 'esbuild' | 'regex' | 'verbatim'` 字段，served 日志带上 mode（同 URL 首次 esbuild、后续失败回退正则时调试可辨）。**mode 映射**：

   | 场景 | patchModernJsAsync 返回 | cache mode |
   |---|---|---|
   | esbuild transform 成功且有改动 | 转译后 text | `'esbuild'` |
   | esbuild 抛错 → 回退正则 | 正则补丁后 text（或 null） | `'regex'` |
   | 预检不命中 | null | `'verbatim'` |
   | 预检命中但 esbuild 无改动 | null | `'verbatim'` |
5. esbuild 懒加载：`let esbuildMod: typeof import('esbuild') | null`，首次命中 `require`（同步，无 dynamic import 额外开销）；首次 transform 含 spawn 二进制开销（约 +100ms），单独文档化
6. **边界（已知不可降级）**：top-level await（esbuild 硬限制）——预检命中 TLA 跳过转译（保持现状），文档化

## 测试

- **单元**：
  - `rewriteCssText` 对 `:has` 转换（标记属性 `[csstools-has-...]` 生成 + 原规则移除）
  - `patchModernJsAsync`：预检不命中 → 返回 null（不调 esbuild）；esbuild 抛错 → 回退正则；`static { this.x = 1; this.y = 2; }`（多语句）被 esbuild 正确降级
  - `patchModernJsAsync`：字符串字面量含 `static{`（`var s = "static{x=1}"`）预检命中但 esbuild 不改——验证"预检宽松、esbuild 精确"
  - `patchModernJsAsync`：transform 含 `using x = expr` 的输入，断言输出含内联 `__using` 函数定义且**无新增 import 语句**（helper 内联确认，防 helper 外链导致 chunk 加载失败）
- **冒烟**：css-fixer-smoke fixture 增加 `:has` 断言（标记属性出现在 DOM + 样式生效）
- **真实探针**：GitHub 页面 `:has` 标记属性出现在预期元素（如 `.prc-Button:has([data-kbd-chord])`）
- **回归**：
  - `npm run check`、userscripts/admin smokes、css-fixer-smoke
  - `npm run build` 后 dist/main.js 体积增量 < 100KB（esbuild external 生效）
  - dist/main.js 含 `require("esbuild")`（external 化确认）

## 不做（评估否决）

- lightningcss（15.8MB wasm + Node 12 双 shim；不降级 @layer/:where/dvh；增量仅 color-mix）
- 主进程 URL 层 CSS 拦截架构重构（Fixer 竞态问题已实测解决）
- top-level await 降级（无成熟工具）
- `@keyframes` 内的 `:has` 无需处理（`:has` 不出现在 keyframes 选择器，语义不成立；css-fixer-core 的 keyframes 跳过逻辑天然覆盖）
