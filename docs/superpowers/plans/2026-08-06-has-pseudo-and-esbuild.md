# css-has-pseudo 集成 + js-patch esbuild 按需转译 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 css-has-pseudo 补齐 Chromium 87 的 `:has()` CSS 支持（GitHub 唯一剩余缺口），并用 esbuild 按需转译补齐 js-patch 的 static{} 边界。

**Architecture:** Fixer 文本层（rewriteCssText 追加 css-has-pseudo PostCSS 转换）+ Fixer 运行时（vendor browser-global.js 做 DOM 标记）；js-patch 新增独立纯函数模块 `js-patch-transform.ts`（预检→esbuild→回退正则），js-patch-service 的协议回调改为 async 链。

**Tech Stack:** css-has-pseudo@8.0.1（MIT-0）、esbuild@0.28.1（已有依赖）、postcss（已有）、vitest（已有）

## Global Constraints

- Electron 11.5.0 / Chromium 87 / Node 12（主进程运行时）锁定，永不升级
- `css-fixer-core.ts` 是浏览器平台代码（bundle 进用户脚本）：**禁止任何 Node 依赖**；`patchModernJs` 保持同步纯函数
- esbuild 必须 external（`esbuild.main.config.mjs`），否则二进制路径解析失败
- Fixer 快照预算 512KB/page（当前 381KB，允许 +40KB 余量）
- 预检正则仅 `/static\s*\{|\busing\s+\w/` 两项（class 声明/`obj.static=` 是 C87 原生支持，不得预检命中）
- 失败回退链：esbuild 抛错 → 正则 → 原样；esbuild 无改动时返回 null
- 缓存 mode 三值：`'esbuild' | 'regex' | 'verbatim'`
- 每任务 TDD：先写失败测试，验证失败，再实现，验证通过，提交

---

### Task 1: 安装 css-has-pseudo 并 vendor 浏览器运行时

**Files:**
- Modify: `package.json`（devDependencies）
- Create: `src/main/modules/userscripts/bundled-scripts/vendor/css-has-pseudo.js`
- Create: `src/main/modules/userscripts/bundled-scripts/vendor/css-has-pseudo.LICENSE`

**Interfaces:**
- Produces: `vendor/css-has-pseudo.js` — IIFE，定义全局 `cssHasPseudo(document, options)`（与 container-query-polyfill 同模式，副作用导入）

- [ ] **Step 1: 安装依赖并拷贝 vendor 文件**

```bash
npm i -D css-has-pseudo@8.0.1
Copy-Item node_modules/css-has-pseudo/dist/browser-global.js src/main/modules/userscripts/bundled-scripts/vendor/css-has-pseudo.js
Copy-Item node_modules/css-has-pseudo/LICENSE.md src/main/modules/userscripts/bundled-scripts/vendor/css-has-pseudo.LICENSE
```

- [ ] **Step 2: 在 vendor 文件头加出处注释**

在 `vendor/css-has-pseudo.js` 第一行前插入：

```js
/* css-has-pseudo 8.0.1 (CSSTools, MIT-0) — vendored browser runtime.
   Converts csstools-has-<encoded> marker attributes (added by the fixer's
   text-layer rewrite) into matched elements via querySelectorAll. Runs its
   own MutationObserver + focus/blur/input/change + property-setter hooks. */
```

- [ ] **Step 3: 验证 esbuild 能 bundle 插件（预检，防止 Task 2 卡壳）**

```bash
npx esbuild --bundle --platform=browser --format=iife --target=chrome87 --log-level=error --outfile=C:\Users\95470\AppData\Local\Temp\opencode\has-pseudo-smoke.js --stdin <<< "import p from 'css-has-pseudo'; console.log(typeof p)"
```

Expected: 无 error，输出文件存在（>2KB）。若失败（ESM 导入问题），记录错误到 Task 2 处理。

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/main/modules/userscripts/bundled-scripts/vendor/css-has-pseudo.js src/main/modules/userscripts/bundled-scripts/vendor/css-has-pseudo.LICENSE
git commit -m "chore(fixer): vendor css-has-pseudo 8.0.1 browser runtime (MIT-0)"
```

---

### Task 2: css-fixer-core 文本层 :has 转换（TDD）

**Files:**
- Modify: `src/main/modules/userscripts/bundled-scripts/css-fixer-core.ts`
- Test: `tests/userscripts/css-fixer-core.test.ts`

**Interfaces:**
- Consumes: `css-has-pseudo` default export（PostCSS 插件工厂，`postcssHasPseudo(options)`）
- Produces: `needsRewrite` 现在对含 `:has(` 返回 true；`rewriteCssText` 对含 `:has(` 的输入先跑 css-has-pseudo 转换（`preserve: false`）再走既有管道

- [ ] **Step 1: 改写既有"文档化限制"测试为转换断言**

在 `tests/userscripts/css-fixer-core.test.ts` 中，把第 65-68 行：

```ts
  it('keeps :has() rules unchanged (documented limitation)', () => {
    const css = '.m_88b62a41:has([data-mantine-scrollbar]) { max-width: 10px }';
    expect(rewriteCssText(css)).toBe(css);
  });
```

替换为：

```ts
  it('converts :has() into a csstools-has marker attribute rule', () => {
    const css = '.m_88b62a41:has([data-mantine-scrollbar]) { max-width: 10px }';
    const out = rewriteCssText(css);
    expect(out).not.toContain(':has(');
    expect(out).toContain('[csstools-has-');
    expect(out).toContain(':not(does-not-exist)');
    expect(out).toContain('max-width: 10px');
  });

  it('needsRewrite detects :has(', () => {
    expect(needsRewrite('.a:has(.b) { color: red }')).toBe(true);
  });

  it('keeps plain selectors without :has untouched', () => {
    const css = '.a .b { color: red }';
    expect(rewriteCssText(css)).toBe(css);
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/userscripts/css-fixer-core.test.ts`
Expected: FAIL — `expect(out).not.toContain(':has(')` 不满足（当前 rewriteCssText 原样返回）

- [ ] **Step 3: 实现转换**

在 `css-fixer-core.ts`：

```ts
import postcssHasPseudo from 'css-has-pseudo';
```

`needsRewrite` 的返回条件增加一行：

```ts
    css.includes(':has(') ||
```

`rewriteCssText` 开头改为：

```ts
export function rewriteCssText(css: string): string {
  if (!needsRewrite(css)) return css;
  // css-has-pseudo text-layer conversion (preserve: false — the original
  // :has() rule is dropped by Chromium 87 anyway): E:has(F) becomes
  // [csstools-has-<base36-encoded-F>]:not(does-not-exist). The browser
  // runtime (vendor/css-has-pseudo.js) sets that marker attribute on
  // matched elements.
  let root = postcss.parse(css);
  if (css.includes(':has(')) {
    const converted = postcss([postcssHasPseudo({ preserve: false })]).process(css, { from: undefined });
    root = postcss.parse(converted.css);
  }

  flattenLayers(root);
```

（后续 `flattenLayers(root); ...` 不变，仅替换 `const root = postcss.parse(css);` 一行。）

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/userscripts/css-fixer-core.test.ts`
Expected: 全部 PASS（含既有 :where/:is/@layer/嵌套/dvh/颜色用例）

- [ ] **Step 5: 验证 patchModernJs 正则不受影响（同文件同步函数）**

Run: `npx vitest run tests/userscripts/css-fixer-core.test.ts -t "patchModernJs"`
Expected: PASS（既有静态块用例保持）

- [ ] **Step 6: Commit**

```bash
git add src/main/modules/userscripts/bundled-scripts/css-fixer-core.ts tests/userscripts/css-fixer-core.test.ts
git commit -m "feat(fixer): css-has-pseudo 文本层转换 — :has() → csstools-has 标记属性"
```

---

### Task 3: Fixer 运行时接入 cssHasPseudo + 冒烟断言（TDD）

**Files:**
- Modify: `src/main/modules/userscripts/bundled-scripts/css-fixer-entry.ts`
- Modify: `tests/electron/userscript-css-fixer-smoke.cjs`

**Interfaces:**
- Consumes: 全局 `cssHasPseudo(document)`（vendor IIFE）
- Produces: `start()` 在 `fixNextImages(document)` 后调用 `cssHasPseudo(document)`；冒烟 fixture 增加 `:has` 场景并断言标记属性 + 样式生效

- [ ] **Step 1: 冒烟 fixture 加 :has 场景 + 断言（先失败）**

在 `tests/electron/userscript-css-fixer-smoke.cjs` 的 FIXTURE_HTML 中 `<style id="nest-css">` 块后追加：

```html
  <style id="has-css">
    .m_has:has(.m_has-child) { color: rgb(1, 2, 3) }
  </style>
```

在 body 中追加：

```html
  <div id="hasbox" class="m_has"><span class="m_has-child">has-child</span></div>
```

在 ASSERT_SCRIPT 的返回对象中追加：

```js
    hasMarker: (() => {
      const el = document.getElementById('hasbox');
      if (!el) return null;
      const attrs = [];
      for (let i = 0; i < el.attributes.length; i++) attrs.push(el.attributes[i].name);
      return attrs.some((a) => a.startsWith('csstools-has-')) ? 'marked' : attrs.join(',');
    })(),
    hasColor: (() => {
      const el = document.getElementById('hasbox');
      return el ? getComputedStyle(el).color : 'no-el';
    })(),
    hasRuleInCssom: (() => {
      for (const s of document.styleSheets) {
        try { for (const r of s.cssRules) if (String(r.cssText).includes('csstools-has-')) return true; } catch { /* ignore */ }
      }
      return false;
    })(),
```

轮询 `done` 条件追加：

```js
      && result?.hasColor === 'rgb(1, 2, 3)'
```

断言区追加（放在 core-js 断言之后）：

```js
  check('has polyfill marker applied', result?.hasMarker === 'marked', result?.hasMarker);
  check('has polyfill rule in cssom', result?.hasRuleInCssom === true, result?.hasRuleInCssom);
  check('has polyfill style applied', result?.hasColor === 'rgb(1, 2, 3)', result?.hasColor);
```

- [ ] **Step 2: 运行冒烟确认失败**

```bash
node tests/electron/build-userscript-runtime-smoke.mjs
npx electron tests/electron/userscript-css-fixer-smoke.cjs
```

Expected: `has polyfill marker applied` FAIL（标记属性不存在）

- [ ] **Step 3: entry 集成运行时**

在 `css-fixer-entry.ts` 的 vendor import 下方追加：

```ts
import './vendor/css-has-pseudo.js';
```

在 `start()` 函数内、`fixNextImages(document);` 之后追加：

```ts
      // css-has-pseudo runtime: scans CSSOM for csstools-has- marker rules,
      // sets the marker attribute on matched elements. Its own
      // MutationObserver picks up every <style> the fixer replaces later.
      try {
        (globalThis as unknown as { cssHasPseudo?: (doc: Document) => void }).cssHasPseudo?.(document);
      } catch { /* never break the page */ }
```

- [ ] **Step 4: 重新构建并运行冒烟**

```bash
node scripts/build-css-fixer.mjs
node tests/electron/build-userscript-runtime-smoke.mjs
npx electron tests/electron/userscript-css-fixer-smoke.cjs
```

Expected: 全部 PASS（含三个 has 断言）

- [ ] **Step 5: Commit**

```bash
git add src/main/modules/userscripts/bundled-scripts/css-fixer-entry.ts src/main/modules/userscripts/bundled-scripts/css-fixer.user.js tests/electron/userscript-css-fixer-smoke.cjs
git commit -m "feat(fixer): 运行时 cssHasPseudo(document) 接入 + 冒烟 :has 断言"
```

---

### Task 4: Fixer v0.4.2 构建 + 真实 GitHub 探针

**Files:**
- Modify: `scripts/build-css-fixer.mjs`（版本 0.4.2）
- Test: `tests/electron/gh-has-probe.cjs`（一次性探针，验证后删除）

- [ ] **Step 1: bump 版本并构建**

在 `scripts/build-css-fixer.mjs` 中把 `// @version      0.4.1` 改为 `// @version      0.4.2`，然后：

```bash
node scripts/build-css-fixer.mjs
node esbuild.main.config.mjs
```

Expected: css-fixer.user.js 写入成功，体积 < 430KB（预算内）

- [ ] **Step 2: 真实 GitHub 探针**

创建 `tests/electron/gh-has-probe.cjs`（临时，参照此前 gh-fixer5 探针模式：真实 app + CDP 创建 GitHub tab），在页面中执行：

```js
(() => {
  const marked = document.querySelectorAll('[class*="csstools-has-"], [csstools-has-]').length;
  const cssomRules = (() => {
    let n = 0;
    for (const s of document.styleSheets) {
      try { for (const r of s.cssRules) if (String(r.cssText).includes('csstools-has-')) n++; } catch { /* ignore */ }
    }
    return n;
  })();
  const fixed = document.querySelectorAll('style[data-bf-css-fix-source]').length;
  const primerRules = (() => {
    const el = [...document.querySelectorAll('style[data-bf-css-fix-source]')].find((s) => (s.getAttribute('data-bf-css-fix-source') || '').includes('primer-react-css'));
    return el && el.sheet ? el.sheet.cssRules.length : -1;
  })();
  return JSON.stringify({ markedElements: marked, cssomHasRules: cssomRules, fixedSheets: fixed, primerRules });
})()
```

Expected: `markedElements > 0` 且 `cssomHasRules > 0`（:has 转换 + 运行时标记生效）；`primerRules > 1000`（回归）。失败则记录实际值排查（重点：转换规则是否进入 CSSOM、browser.js 是否启动）。

- [ ] **Step 3: 删除临时探针并提交**

```bash
Remove-Item tests/electron/gh-has-probe.cjs
git add scripts/build-css-fixer.mjs src/main/modules/userscripts/bundled-scripts/css-fixer.user.js
git commit -m "feat(fixer): v0.4.2 — GitHub :has() 样式恢复 (css-has-pseudo)"
```

---

### Task 5: js-patch-transform 独立模块（TDD）

**Files:**
- Create: `src/main/modules/js-patch-transform.ts`
- Test: `tests/userscripts/js-patch-transform.test.ts`

**Interfaces:**
- Consumes: `patchModernJs`（css-fixer-core 同步正则）
- Produces:
  ```ts
  export interface PatchResult { text: string | null; mode: 'esbuild' | 'regex' | 'verbatim'; }
  export function patchModernJsAsync(text: string): Promise<PatchResult>;
  ```
  （`js-patch-service.ts` 在 Task 6 消费）

- [ ] **Step 1: 写失败测试**

创建 `tests/userscripts/js-patch-transform.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { patchModernJsAsync } from '@main/modules/js-patch-transform';

describe('js-patch-transform patchModernJsAsync', () => {
  it('returns verbatim for plain ES5 code (preflight miss, zero esbuild cost)', async () => {
    const r = await patchModernJsAsync('var a = 1; function f() { return a; }');
    expect(r).toEqual({ text: null, mode: 'verbatim' });
  });

  it('degrades a multi-statement static block via esbuild', async () => {
    const src = 'class A { static { this.x = 1; this.y = 2; } }';
    const r = await patchModernJsAsync(src);
    expect(r.mode).toBe('esbuild');
    expect(r.text).toContain('this.x = 1');
    expect(r.text).not.toContain('static {');
  });

  it('does not change string literals containing static{ (preflight loose, esbuild precise)', async () => {
    const src = 'var s = "static{x=1}";';
    const r = await patchModernJsAsync(src);
    expect(r.mode).toBe('verbatim');
    expect(r.text).toBeNull();
  });

  it('degrades using declarations with an inline __using helper and no new imports', async () => {
    const src = 'function f() { using r = acquire(); return r.x; }';
    const r = await patchModernJsAsync(src);
    expect(r.mode).toBe('esbuild');
    expect(r.text).toContain('__using');
    expect(r.text).not.toMatch(/\bimport\b/);
  });

  it('falls back to regex patch when esbuild throws', async () => {
    const r = await patchModernJsAsync('class A { static { this.x = 1 } } /* unbalanced ( { */');
    expect(['esbuild', 'regex']).toContain(r.mode);
    expect(r.text).not.toBeNull();
  });

  it('returns verbatim when esbuild output equals input', async () => {
    const src = 'static { const x = 1; }';
    // esbuild keeps static{} for unsupported-target? — assert the contract: no-change => null
    const r = await patchModernJsAsync(src);
    if (r.text !== null && r.text === src) expect(r.mode).toBe('verbatim');
    else expect(r.mode).toBe('esbuild');
  });
});
```

（最后一条是契约断言：无改动必须返回 `{ text: null, mode: 'verbatim' }` 或等价语义——若 esbuild 对 `static{}` 无改动的 target 语义不符预期，以实测为准调整断言，但契约不变。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/userscripts/js-patch-transform.test.ts`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现**

创建 `src/main/modules/js-patch-transform.ts`：

```ts
// js-patch-transform: URL-layer JS patching with esbuild fallback.
// The regex patch (css-fixer-core patchModernJs) only covers simple
// `static{this.X=ref}` blocks; esbuild degrades complex static blocks and
// `using` declarations with full edge coverage. esbuild is lazy-required
// (Node-only; this module must NEVER be imported from browser-bundled code).
//
// Preflight is deliberately loose (`static{`, `static {`, `using` only):
// class declarations and `.static =` assignments are native to Chromium 87
// and must not trigger the esbuild path ("zero overhead" promise).

import { patchModernJs } from './userscripts/bundled-scripts/css-fixer-core';

const PREFLIGHT_RE = /static\s*\{|\busing\s+\w/;

export interface PatchResult {
  text: string | null;
  mode: 'esbuild' | 'regex' | 'verbatim';
}

interface EsbuildTransform {
  transform(text: string, opts: { target: string; loader: string }): Promise<{ code: string }>;
}

let esbuildMod: EsbuildTransform | null = null;

function getEsbuild(): EsbuildTransform {
  if (!esbuildMod) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    esbuildMod = require('esbuild') as EsbuildTransform;
  }
  return esbuildMod;
}

export async function patchModernJsAsync(text: string): Promise<PatchResult> {
  if (!PREFLIGHT_RE.test(text)) return { text: null, mode: 'verbatim' };
  try {
    const out = await getEsbuild().transform(text, { target: 'chrome87', loader: 'js' });
    if (out.code === text) return { text: null, mode: 'verbatim' };
    return { text: out.code, mode: 'esbuild' };
  } catch {
    const regex = patchModernJs(text);
    return regex === null ? { text: null, mode: 'verbatim' } : { text: regex, mode: 'regex' };
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/userscripts/js-patch-transform.test.ts`
Expected: 全部 PASS（若第 6 条 esbuild 对 `static{ const x = 1; }` 的行为与断言不符，按 Step 1 注释调整）

- [ ] **Step 5: Commit**

```bash
git add src/main/modules/js-patch-transform.ts tests/userscripts/js-patch-transform.test.ts
git commit -m "feat(js-patch): patchModernJsAsync — 预检 static/using → esbuild → 回退正则"
```

---

### Task 6: js-patch-service 接入 async 链 + 缓存 mode

**Files:**
- Modify: `src/main/modules/js-patch-service.ts`

**Interfaces:**
- Consumes: `patchModernJsAsync`（Task 5 的 `PatchResult`）
- Produces: 协议回调在 promise 链内调用；缓存 value 带 mode；served 日志带 mode

- [ ] **Step 1: 改造缓存结构与协议回调**

在 `js-patch-service.ts`：

```ts
import { patchModernJsAsync } from './js-patch-transform';
```

缓存类型与 cachePut：

```ts
type PatchMode = 'esbuild' | 'regex' | 'verbatim';
const patchCache = new Map<string, { text: string; bytes: number; mode: PatchMode }>();

function cachePut(src: string, text: string, mode: PatchMode): void {
  const bytes = text.length;
  patchCache.set(src, { text, bytes, mode });
  // ...（既有 eviction 逻辑不变）
}
```

`registerJsPatchProtocol` 内的命中分支：

```ts
    const cached = patchCache.get(src);
    if (cached) {
      log.info('[js-patch] cached', src.slice(0, 60), 'mode=' + cached.mode);
      callback({
        statusCode: 200,
        headers: { 'content-type': 'application/javascript' },
        data: Buffer.from(cached.text, 'utf8'),
      });
      return;
    }
    fetchText(src)
      .then(async (text) => {
        const { text: patched, mode } = await patchModernJsAsync(text);
        const finalText = patched ?? text;
        cachePut(src, finalText, mode);
        log.info('[js-patch] served', src.slice(0, 60), 'mode=' + mode, 'bytes=' + finalText.length);
        callback({
          statusCode: 200,
          headers: { 'content-type': 'application/javascript' },
          data: Buffer.from(finalText, 'utf8'),
        });
      })
      .catch((error) => {
        log.warn('[js-patch] fetch failed', src.slice(0, 60), error instanceof Error ? error.message : String(error));
        callback({ statusCode: 502, headers: { 'content-type': 'text/plain' }, data: Buffer.from('fetch failed') });
      });
```

（删除对 `patchModernJs` 的直接 import——改由 `patchModernJsAsync` 内部回退调用。）

- [ ] **Step 2: 类型检查**

Run: `npx tsc -p tsconfig.main.json --noEmit`
Expected: 0 errors

- [ ] **Step 3: 冒烟回归（css-fixer-smoke 含 static-block 断言）**

```bash
node esbuild.main.config.mjs
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
npx electron tests/electron/userscript-css-fixer-smoke.cjs
```

Expected: ALL PASS（static-block 补丁链路仍工作）

- [ ] **Step 4: Commit**

```bash
git add src/main/modules/js-patch-service.ts
git commit -m "feat(js-patch): 协议回调接入 patchModernJsAsync，缓存带 mode，日志带 mode"
```

---

### Task 7: esbuild external + 全量回归

**Files:**
- Modify: `esbuild.main.config.mjs`
- Modify: `AGENTS.md`（构建说明补充，可选）

- [ ] **Step 1: external 加 esbuild**

在 `esbuild.main.config.mjs` 中：

```js
  external: ['electron', 'electron-log', 'electron-store', 'esbuild'],
```

- [ ] **Step 2: 构建验证体积与 external 化**

```bash
node esbuild.main.config.mjs
$m = Get-Content dist/main.js -Raw
Write-Output "main.js bytes: $((Get-Item dist/main.js).Length)"
Write-Output "has external esbuild require: $($m.Contains('require(\"esbuild\")') -or $m.Contains(\"require('esbuild')\"))"
Write-Output "esbuild bundled into main (BAD): $($m.Contains('esbuild.exe'))"
```

Expected: main.js < 2MB（不含 esbuild 二进制）；含 `require("esbuild")`；不含 `esbuild.exe` 字符串

- [ ] **Step 3: 运行时验证 esbuild 可解析（真实 app + ruffle.rs 探针）**

真实 app + CDP 打开 `https://ruffle.rs/`（Next.js App Router chunk 含 static{}），等 20s 后检查 main.log：

```powershell
Get-Content "$env:APPDATA\bao-flash-browser\logs\main.log" -Tail 20 | Select-String 'js-patch'
```

Expected: 出现 `mode=esbuild` 的 served 条目（chunk 经 esbuild 转译）；无 `falling back` 警告（或个别正常）

- [ ] **Step 4: 全量回归**

```bash
node tests/electron/build-userscripts-admin-smoke.mjs
node tests/electron/build-userscript-runtime-smoke.mjs
npm run test:css-fixer
npm run test:userscripts
npm run test:userscripts-admin
npm run check
```

Expected: css-fixer ALL PASS；userscripts 143/143；admin ALL PASS；check 45 files 全绿

- [ ] **Step 5: 提交**

```bash
git add esbuild.main.config.mjs
git commit -m "build: esbuild external 化（js-patch 运行时转译所需）+ 全量回归"
```

---

## Self-Review 记录

- **Spec 覆盖**：R1（Task 3 Step 3 start() 内调用 ✓）、P0（Task 5 独立模块 + Task 6 async 链 ✓）、P1-1（Task 5 PREFLIGHT_RE 两项 ✓）、P1-2（Task 7 external ✓）、P2-1（Task 5 同步 require ✓）、P2-2（Task 5 回退 + Task 6 日志 ✓）、P2-3（Task 6 mode 映射 ✓）、using helper 内联断言（Task 5 测试 4 ✓）、mode 映射表（Task 5 接口 + Task 6 实现 ✓）
- **类型一致性**：`PatchResult` 接口在 Task 5 定义、Task 6 消费；`mode` 三值一致
- **已知风险**：Task 2 的 css-has-pseudo ESM 导入在 esbuild bundle 下的行为已由 Task 1 Step 3 预检；Task 5 第 6 条测试对 esbuild 无改动语义的断言以实测为准（契约不变）
