# 方案A：脚本平台内优化（无 FOUC + 内容哈希更新）

> 状态：设计草案（未改代码）
> 日期：2026-08-06
> 目标：在不换层、不重做方案C的前提下，拿到方案C 90% 的好处，且完全保留脚本平台的容错与覆盖能力。

## 背景

C 方案（主进程 URL 层转译）经实测导致旧站全线崩溃、`:has` 标记失效、Ruffle 不如脚本版本，已回退（`f062eb0`）。诊断确认脚本平台是自洽且容错的，但有两个真实痛点：

1. **闪变（FOUC）**：`css-fixer-entry.ts` `processLink` 先 `link.disabled = true`（样式消失），再 fetch→rewrite→替换 `<style>`，期间页面先无样式再闪出。
2. **版本 bump 摩擦**：`ensureBundledScripts` 只在 `compareVersions(bundled > stored)` 时更新，每次改 Fixer 源码必须手改 `@version`，否则已装用户拿不到修复。

本方案在不改架构的前提下解决这两点。

---

## 目标与非目标

### 目标
- 消除页面加载时的样式闪变（首帧即到位）。
- 免除每次改 Fixer 源码的手动版本 bump。
- 保持脚本平台的全部能力：动态/内联样式覆盖、`:has`/container 运行时、失败容错。

### 非目标
- 不把 Fixer 移到主进程。
- 不引入自定义协议 / URL 层拦截。
- 不牺牲旧站兼容性。

---

## 改动 1：无 FOUC 的样式插入策略

### 现状问题
`processLink`（entry.ts:286-339）流程：
```
link.disabled = true        // ← 样式瞬间消失
fetch(href)                 // 网络往返
text = rewriteCssText(text)
link 替换为 <style>          // ← 样式重新出现
```
`disabled=true` 立即生效，若 fetch 慢（现代站 6+ 张表、网络高峰），页面长时间无样式 → 闪变。

### 方案
**不再 disable 原 link，而是把 rewrite 结果作为 `<style>` 插到原 `<link>` 之前（或同位置覆盖）。**

- 保留原 `<link>` 不动 → 原始样式立刻生效（有样式，不闪白）。
- 在 `<link>` 前方插入 rewrite 后的 `<style>`（`data-bf-css-fixed` 标记）。
- 同优先级（相同 specificity）下，**文档流中靠后的声明胜出**。因此把 `<style>` 插到原 link 之后、同源替换位，让 rewrite 结果覆盖原始样式。

关键细节（继承现有 entry.ts 思路）：
- 原 `processLink` 是 `link.remove()` + 前插 `<style>`。改为：`link.parentNode.insertBefore(style, link.nextSibling)` 后 **保留 link**（不 remove）。
- 失败路径（fetch/rewrite 抛错）：
  - **不触碰 link**（它已生效），保持原样 → 零闪变、零破坏。
  - 现有 `link.disabled = false` + 重试逻辑删除（因为从未 disabled）。
- 重复处理防护：`link.hasAttribute(MARKER)` 已有；`<style>` 带 MARKER，observer 不再二次处理。
- CSSOM 影响：浏览器同时解析原始 link 与覆盖 style。二者规则都进 CSSOM，覆盖 style 的规则因顺序胜出，最终渲染 = rewrite 结果。未 rewrite 的规则（verbatim）由原始 link 提供，避免重复。
- 校验：rewrite 前后长度 / 是否含 `}`，确保 `<style>` 内容是合法 CSS，杜绝注入破坏。

### 边界
- **`@import` 依赖**：原 link 可能 `@import` 子表。保留 link 则 `@import` 照常拉取；覆盖 style 若也含 rewrite 后的 `@import`，可能重复拉取。需评估：rewrite 对 `@import` 的处理（当前 `needsRewrite` 不含 @import 特征，verbatim 时 `<style>` 与 link 内容相同——应跳过覆盖 style，直接留 link）。
  - 优化：当 `rewritten === text`（verbatim，无需改）时，**什么都不做**（保留 link），既无闪变也无重复。仅在确有 rewrite 时插覆盖 style。
- **动态插入的 style**：`handleStyle`/MutationObserver 路径同样改为"就地改 textContent"（现已是），天然无闪变。

---

## 改动 2：内容哈希更新（免除版本 bump）

### 现状问题
`ensureBundledScripts`（index.ts 同级，userscripts/index.ts）依赖 `@version` 数值比较。改源码需手改 `0.5.6 → 0.5.7`，否则同版本不覆盖。

### 方案
**用 bundled 源码的内容哈希作为"更新信号"，而非版本号。**

- 构建时（`scripts/build-css-fixer.mjs`）在 `css-fixer.user.js` 的 metadata 里写入一个稳定哈希字段，例如 `@updateHash <sha256 或简写>`。哈希由 esbuild 产物内容算出。
- 运行时 `ensureBundledScripts`：
  - 读 bundled 的 `@updateHash`。
  - 若 stored 的 `@updateHash !== bundled` 且 **未 edited** → 更新。
  - 保留 `@version` 仅作展示 / 兼容，不再作为唯一更新依据。
- 已 edited（用户在编辑器保存过）的脚本：仍不覆盖（与现状一致）。

好处：
- 改 core/entry 源码 → 重新 build → 哈希变化 → 自动更新，无需手 bump。
- 构建产物本身变了（依赖升级）哈希也变，天然触发更新。
- 防旧构建降级：stored 哈希来自旧构建，新构建哈希更高/不同 → 用版本比较仍保留 upgrade-only 语义（可选叠加：仅当 bundled version >= stored 时才应用哈希更新，杜绝 stale dist 覆盖新 store）。

### 实现位置
- `scripts/build-css-fixer.mjs`：计算产物哈希写 metadata。
- `src/main/modules/userscripts/index.ts` `ensureBundledScripts`：读哈希比较。
- `parseUserscriptMetadata`：需能解析 `@updateHash` 自定义字段（检查是否通用化）。

---

## 验证计划

### 单元测试
- `ensureBundledScripts`：同版本不同哈希 → 更新；同版本同哈希 → 不更新；edited → 不更新；旧构建版本 < stored → 不降级。

### 冒烟（css-fixer smoke）
- 现有 `test:css-fixer` 全绿（回归）。
- 新增断言：FOUC 相关——`link` 在 rewrite 期间不被 disable（通过 monkeypatch `HTMLLinkElement.disabled` setter 或观察 DOM 结构）。

### 手动
- 打开 GitHub / ruffle.rs，观察首帧是否有样式闪变（对比修复前后）。
- 修改一条 rule → rebuild → 确认已装用户自动拿到（无需手 bump）。

---

## 风险与权衡

| 项 | 说明 |
|----|------|
| 覆盖 style 与 link 重复解析 | verbatim 时跳过覆盖 style 规避；rewrite 时 CSSOM 有两份，覆盖胜出，可接受 |
| `@import` 双重拉取 | 评估后限定 verbatim 跳过；rewrite 内含 @import 的场景需再核对 |
| 内容哈希与构建确定性 | 需保证 esbuild 产物可复现（当前 minify:false，确定性强）|
| 旧构建降级 | 叠加版本比较，保持 upgrade-only |

---

## 结论

方案A 用两处小改动解决闪变 + 版本摩擦，保留脚本平台全部能力，零架构风险。是"拿到方案C好处又不崩站"的推荐路径。
