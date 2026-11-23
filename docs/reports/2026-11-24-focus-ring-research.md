# 聚焦环行为调研：能不能对齐常规浏览器

2026-11-24 · 只调研，不改代码。起因：飞窗打开时出现一圈**琥珀色**边框 + 设置页 `<select>` 点击后出现蓝框，用户要求「只有键盘操作才出现聚焦环」。

## 0. 结论摘要

| 问题 | 结论 |
| --- | --- |
| 鼠标点击是否该出环 | **不该**。规范与 Chromium 一致：鼠标点击的按钮不匹配 `:focus-visible` |
| 我们为什么会出现琥珀色环 | 打开飞窗时我们（曾）对面板容器 `focus()`；**程序化聚焦在「尚无用户交互」时会匹配 `:focus-visible`**，于是画出 Chromium 的 UA 默认环。实测该环是 `rgb(229,151,0) auto`（琥珀色） |
| `<select>` 为什么点一下就出蓝框 | Chromium 的**特例**：`<select>` 即使鼠标点击也匹配 `:focus-visible`（Firefox 不匹配），见 CSSWG issue #5822。我们随后用 `select:focus { outline: none }` 把它整条去掉了——连键盘用户也看不到焦点 |
| 我们的环和 Chrome 像不像 | 不像：Chrome 原生界面（Views）的环是 **2 dp、40% 透明度、画在控件外侧、圆角 +1 dp、取系统 accent 色**；我们用的是 Fluent 蓝 `#0f6cbd` + `outline-offset: -2px`（向内画），而选中态用的是紫色 `--engine-accent` |
| 菜单/飞窗里该不该有环 | Chrome 的菜单项用**整行高亮**表示键盘焦点，不画环；我们的飞窗是 DOM，天然会用环 |

## 1. 规范怎么说

[Selectors Level 4 · `:focus-visible`](https://drafts.csswg.org/selectors-4/#the-focus-visible-pseudo) 给的是启发式规则（按优先级）：

1. 用户表达了「总要看见焦点」的偏好（系统设置 / 浏览器设置）→ 始终匹配；
2. **任何支持键盘输入的元素**（`input`，以及没有物理键盘时会弹出虚拟键盘的元素）→ 聚焦时**总是**匹配；
3. 否则：由 UA 按「最近的交互方式」判断——键盘导航后聚焦 → 匹配；鼠标点击引起的聚焦 → 不匹配。

关键点：规范把「哪些元素算支持键盘输入」留给 UA 决定，这正是浏览器分歧的来源。

## 2. Chromium 怎么实现

Chromium 早期实现（[commit 54193de](https://chromium.googlesource.com/chromium/src/+/54193dec1d1ead43568aaf8abf29b1ac478c966e)，2018）里的三个概念至今仍是骨架：

- `Document::LastFocusType()`：记录**上一次聚焦是由什么引起的**（鼠标 / 键盘 / 脚本）；
- `HadKeyboardEvent()`：文档级「最近有过键盘事件」；
- `MayTriggerVirtualKeyboard()`：元素是否会唤起虚拟键盘 —— 这类元素**永远**匹配 `:focus-visible`（对应规范第 2 条）。`<select>` 在这里被算进去了。

这也解释了 [CSSWG issue #5822](https://lists.w3.org/Archives/Public/public-css-archive/2020Dec/0490.html) 记录的差异：Chromium 里鼠标点 `<select>` 会匹配 `:focus-visible`，Firefox 不会；而 `<input type=radio>` 两边都**不**匹配（尽管方向键可以切换）。

## 3. 本机实测（Chromium 142 / Electron 39.8.10）

用 `webContents.focus()` + `sendInputEvent` 在真实窗口里测的（不是推测）：

| 场景 | `:focus-visible` | 计算样式 |
| --- | --- | --- |
| 页面加载后**程序化** `element.focus()`（此前无任何用户交互） | **true** | `rgb(229, 151, 0) auto 0.666667px` |
| **鼠标点击** `<button>` | false | `none` |
| **键盘 Tab** 落到控件 | true | `rgb(229, 151, 0) auto 0.666667px` |
| **鼠标点击** `<select>` | **true** | `rgb(229, 151, 0) auto 0.666667px` |
| 我们的设置页：鼠标点 `.choice`（role=radio）/ `.theme-stop` / 导航按钮 | false | `none` |
| 我们的设置页：键盘 Tab 到 `.choice` | true | `solid 2px rgb(15, 108, 189)`（我们的 `--brand-stroke`） |
| 我们的设置页：鼠标点 `<select>` | true | `none`（被我们 `select:focus { outline: none }` 压掉了） |
| 外壳工具栏齿轮：鼠标点击 | false | `none` |

两个直接结论：

1. **琥珀色环 = Chromium 的 UA 默认 `:focus-visible` 样式**（`-webkit-focus-ring-color` 在本机解析为 `#e59700`），不是我们的品牌色。之前飞窗那圈黄边就是「面板被程序化聚焦 + 没被我们的 CSS 覆盖」的产物。
2. 我们的按钮行为**已经和 Chrome 一致**（鼠标无环、键盘有环）；**唯一偏离的是 `<select>`**——为了消掉蓝框，我们把键盘焦点指示也一起去掉了，这是一处 a11y 回退。

## 4. Chrome / Edge 自己怎么画焦点

**原生界面（Views）**：[`ui/views/controls/focus_ring.cc`](https://chromium.googlesource.com/chromium/src/+/78d6eab8cc7ccf0c7ee4e1733e47333ff268dc4a/ui/views/controls/focus_ring.cc)

- 线宽 `kFocusHaloThicknessDp = 2.f`；
- 画在控件**外侧**（`focus_bounds.Inset(gfx::Insets(-kFocusHaloThicknessDp))`）；
- 颜色 `SkColorSetA(color_, 0x66)` → **40% 透明度**，取色自 `kColorId_FocusedBorderColor`（系统 accent），不是固定蓝；
- 圆角 `corner_radius_ + kFocusHaloThicknessDp / 2.f`（比控件圆角大 1 dp）。

**菜单**：Chrome 的下拉菜单是独立的 `Widget`，键盘焦点用**整行高亮**（hover/focus 同色）表示，不画环。

**WebUI 设置页（Edge/Chrome 设置）**：用 `:focus-visible` + `outline` token（Fluent 的 `--focus-outline` 系列），本质仍是「键盘才出现」。

## 5. 差距清单

| # | 差距 | 影响 | 对齐成本 |
| --- | --- | --- | --- |
| 1 | `<select>` 被 `outline: none` 完全压掉 | 键盘用户看不到焦点；与 Chrome 行为不同（Chrome 会给环） | 低：允许 select 显示环，或换自绘下拉 |
| 2 | 我们的环色是 Fluent 蓝 `#0f6cbd`，选中态是紫 `--engine-accent` | 两套强调色并存，观感不统一 | 低：新增 `--stroke-focus-ring` 统一 |
| 3 | 我们向内画（`outline-offset: -2px`），Chrome 向外画（2 dp、40% alpha、圆角 +1） | 环贴边、压住圆角，视觉上比 Chrome「硬」 | 低：改 `outline-offset: 1px` + `color-mix` 40% |
| 4 | 飞窗/面板里用 DOM 环，Chrome 菜单用整行高亮 | 键盘操作时我们的飞窗会出现「环套行」的观感 | 中：飞窗内改为 `.row:focus-visible { background: hover }` 风格 |
| 5 | 程序化聚焦（打开飞窗时）会立刻触发 `:focus-visible` | 打开即出现环（已修，改为不聚焦任何元素） | 已完成 |
| 6 | 未被我们的 CSS 覆盖的元素会露出琥珀色 UA 环 | 偶发的「莫名黄框」 | 低：全局兜底 `:focus-visible` 规则 |

## 6. 三种可选方案（供决策，本次不改）

**A. 最小对齐**（推荐）
1. 全局兜底：`:focus-visible { outline: 2px solid var(--stroke-focus-ring); outline-offset: 1px; }`，`--stroke-focus-ring` 用 `color-mix(in srgb, var(--engine-accent) 40%, transparent)`（接近 Chrome 的 40% alpha）；
2. 把 `select:focus { outline: none }` 换成 `select:focus-visible` 才画环 —— 结果：鼠标点 select 也会出环（**和 Chrome 完全一致**），键盘用户恢复指示；
3. 飞窗/设置页保留现有结构。

**B. 全站自绘（最像 Chrome 原生）**
用 `box-shadow` 或伪元素画 2 px、40% alpha、外侧 1 px 的环，圆角 `+1px`；飞窗内的行改成「高亮行 + 无环」。视觉最接近，但要为每种控件写一份样式，维护成本最高。

**C. 折中**
按钮类保持 A；飞窗/面板内的行（引擎选项、主题档位）改成整行高亮（Chrome 菜单风格），环只留给真正需要它的表单控件（select / input）。

## 7. 我的建议

先做 **A**（半天量级，可验证），把 1 项（select 回退）和 2/3 项（环色、外扩 + 40% alpha）修掉；飞窗内的「行高亮 vs 环」单独作为视觉优化排期（C 的一半）。

## 8. 未验证

- 只在 Windows / Chromium 142 实测；macOS、Linux 的 UA 环颜色与该平台的 `kColorId_FocusedBorderColor` 未测。
- 高对比度模式（`forced-colors: active`）下环的呈现未实机验证。
- Firefox/WebKit 的行为引自 CSSWG issue，本机未实测。
- Edge 的 Fluent `--focus-outline` token 具体取值未从源码核对（只确认了「键盘才出现」这一行为）。
