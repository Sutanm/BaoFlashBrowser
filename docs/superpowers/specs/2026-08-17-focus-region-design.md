# 视觉脚本"播放器区域"搜索范围设计方案（focusRegion）

> 版本：2026-08-17，基于《03 视觉自动化平台》模块设计与自动化 schema 现状。
> 需求来源：用户希望视觉脚本的图片搜索范围"可选指定到 Flash 游戏区域"，
> 而非默认全 BrowserView。
>
> **已确认决策（brainstorming 收敛）**：
>
> - **D1 数据组织：工作流级 `focusRegion` + 每步可跳出**（方案 1）。工作流根部挂可选
>   `focusRegion`，所有图像类步骤默认在其中搜索；个别步骤可显式标"全区"。
>   "多命名区域"（方案 3）留作未来扩展点，本次不做。
> - **D2 拾取与解算分离**：拾取发生在**搭建时**（工作台对真实游戏页做元素拾取），
>   存入工作流的**不是矩形快照而是元素选择器**；执行时**每次匹配前重新解析**
>   `selector → getBoundingClientRect()`（用户在**最小化运行**场景下要求逐次解析，
>   防止恢复窗口/DPI 变化的矩形漂移）。
> - **D3 解析失败兜底**：元素解算失败（`null`/零尺寸）→ **回退全区匹配** + 发新事件
>   `focus-region-fallback`（不中止脚本，无人值守安全）。
> - **D4 引擎无关**：CDP 输入路径本就作用于 compositor（见 03 文档 §6），元素矩形
>   拾取/解析同样与 Ruffle/PPAPI 引擎无关；播放器在跨域 iframe 内时，顶层拾取命中
>   iframe 元素，矩形 = iframe 可视区，正是期望的"播放器区域"。
> - **D5 向后兼容**：未设置 focusRegion 的脚本零行为变化；静态 `region` 优先级最高。

## 需求

1. 工作台可为脚本设置"播放器区域"：在真实游戏页**点击拾取**一个 HTML 元素，
   其矩形作为图像搜索子区域。
2. 搜索区域语义：设置了焦点区域的脚本，所有未单独指定搜索区域的图像步骤默认
   只在该子区域搜索；无设置则保持全 BrowserView（现状）。
3. 执行时**逐次重新解析**元素矩形，支持最小化运行/窗口缩放/DPR 变化。
4. 解析失败回退全区并告警，不中止脚本。
5. 向后兼容：现有 `region`（静态矩形）行为不变；旧脚本零改动。

## 已验证事实（现状基线）

| 事实 | 来源 |
|------|------|
| `region?: AutomationRegion` 已存在于图像类步骤与 `ImageCondition`，运行时 `findImage` 全链路透传，matcher 用 `cssRegionToDevice` 按 CSS→设备像素裁剪搜索帧；**无任何 UI 入口**（Blockly 积木与资产测试床均无 region 字段） | `types.ts:1-18,49-132`、`schema.ts:17-37,72-199`、`vision-worker-matcher.ts:76-86`、`AutomationBlocklyEditor.tsx:47-97`、`AutomationAssetTestBench.tsx` |
| `findImage` 走 `capturePage` 全帧 → matcher；匹配与点击坐标经 `deviceMatchToCssPoint` 换算（CSS 视口坐标系）；**`region` 亦为 CSS 视口坐标系**，与 `getBoundingClientRect()` 天然同系 | `browserview-driver.ts:187-223,150-168` |
| Demo 脚本有"截图时隐藏悬浮助手"先例：`executeJavaScript` 注入页面脚本 + 撤销的可靠路径 | `browserview-driver.ts:120-148`（`hideAutomationAssistantForCapture`） |
| 自动化输入类动作均经**瞬态 CDP 出租约**（`withTransientCdp`）；`findImage` **不占利尿约**（capturePage 无需 debugger） | `browserview-driver.ts:187-223,381-398`、`cdp-lease.ts` |
| 工作流 schema 用 zod `strict()`；共享类型在 `src/shared/automation/types.ts`；manifest 能力清单 `capabilities?: AutomationCapability[]` | `schema.ts:39-42`、`types.ts:243-262` |
| i18n：改字典必须 `npm run i18n` 后 build，baseLocale zh-CN / en | 仓库 `AGENTS.md` §构建与运行 |
| 自动化标签须保持合法/不被休眠，截图帧才新鲜（最小化运行前置） | `tabs` 休眠门控、`03-automation` 文档 |

## 架构

```
src/shared/automation/types.ts          改 — FocusRegion、workflow.focusRegion、regionScope、capability
src/shared/automation/schema.ts         改 — 上述 zod（strict，未设不改写既有校验）
src/shared/automation/element-selector.ts  新 — describeElement()（稳定选择器生成）+ buildFocusRectScript()（构造注入脚本串）+ resolveEffectiveRegion()（搜索框优先级别断纯函数；主/渲染共用，可 vitest）
src/main/modules/automation/element-picker.ts  新 — 拾取器：注入/高亮/轮询/取消
src/main/modules/automation/browserview-driver.ts  改 — findImage 每次匹配前解析 focusRegion → 有效 region；兜底告警
src/main/modules/automation/runtime.ts   改 — onEvent 增 'focus-region-fallback'；FindImageRequest 透传 focusRegion
src/main/modules/automation/automation-service.ts  改 — 启动运行时把 workflow.focusRegion 注入 driver options
src/main/ipc/automation.ipc.ts           改 — 新通道 automation:pick-region / automation:cancel-pick
src/preload/index.ts                     改 — ALLOWED_INVOKE_CHANNELS + electronAPI.automation 扩充
src/renderer/types/electron.d.ts         改 — FocusRegion/PickRegionResult 类型
src/renderer/components/automation/AutomationPage.tsx  改 — 播放器区域栏（拾取/清除/状态）
src/renderer/components/automation/AutomationBlocklyEditor.tsx  改 — 图像积木 regionScope 下拉
i18n dictionaries（zh-CN/en）            改 — 文案；改后 npm run i18n
tests/element-selector.test.ts           新 — 选择器生成/转义/解析优先级
tests/focus-region-policy.test.ts        新 — 有效搜索框优先级别断纯函数
tests/electron/focus-region-smoke.cjs    新 — 拾取端到端 + 运行时生效/回退两条路径
docs/modules/03-automation.md            改 — 同步数据模型新字段（后续实现期）
```

**设计隔离原则**：

- `element-selector.ts` 是**纯 DOM 逻辑**（输入元素/文档，输出选择器/矩形），
  与 Electron/主进程解耦 —— vitest + jsdom 可全量覆盖，拾取器与运行时解析共用。
- 拾取器负责**交互态**（注入、事件、轮询窗口），运行时解析只消费选择器；
  两者不共享状态，只共享 `element-selector.ts` 的输出格式。
- 驱动层拿到的是"有效 region"，matcher 接口零改动（仍吃 `AutomationRegion`）。

## 数据模型（schema 变更）

```ts
// types.ts
export type FocusRegion = {
  type: 'element';
  selector: string;   // CSS 选择器，如 "#flashPlayer" / "embed[data-game=602]"
  label?: string;     // 拾取自动生成的展示名，如 "播放器 (embed#flashPlayer)"，仅 UI
};

// AutomationWorkflow 新增
export type AutomationWorkflow = {
  formatVersion: 1;
  id: string;
  name: string;
  description?: string;
  readyWhen?: AutomationCondition;
  focusRegion?: FocusRegion;   // 新增：脚本级聚焦区域
  root: SequenceStep;
};

// regionScope —— 仅图像类步骤（见下），不含 ImageCondition
export type AutomationRegionScope = 'focus' | 'viewport';
// 加入：WaitImageStep / WaitImageStateStep / ClickImageStep / KeyHoldUntilImageStep / MoveToImageStep

// AutomationCapability 追加
export type AutomationCapability = ... | 'focus-region';

// schema.ts
const focusRegionSchema = z.object({
  type: z.literal('element'),
  selector: z.string().min(1).max(512),
  label: z.string().max(128).optional(),
}).strict();
const regionScopeSchema = z.enum(['focus', 'viewport']).optional();
// workflowSchema 增 focusRegion: focusRegionSchema.optional()
// 五个图像步骤 schema 增 regionScope: regionScopeSchema
```

**搜索框优先级（唯一权威判定，实现为纯函数 `resolveEffectiveRegion`）**：

1. 步骤显式给了静态 `region` → 用之（`regionScope` 忽略；现状不变）；
2. 步骤 `regionScope !== 'viewport'` 且工作流有 `focusRegion` → 用**元素实时解析矩形**；
3. 其余 → 全 BrowserView。

语义说明：`regionScope` 只在"该步是否打算脱离聚焦区域"上作显式声明，
缺省按"跟随聚焦区域"；`region` 是独立的老功能，仍优先。

## 拾取交互（搭建时）

### 流程（渲染层编排，主进程出能力）

```
工作台「播放器区域」栏 [拾取] 点击
  → renderer 记录目标游戏标签 gameTabId（自动化运行目标），tab:activate(gameTabId)
  → api.pickRegion(gameTabId)  [automation:pick-region {tabId}]
  → 主进程注入拾取脚本 + 轮询（见下）
  → 用户点击播放器元素
  → 返回 { selector, label } → renderer 填 workflow.focusRegion、toast 提示
```

### 拾取器（`element-picker.ts`）

- **不挂 CDP 出租约**：注入/轮询全走 `webContents.executeJavaScript`（与
  `hideAutomationAssistantForCapture` 同路径为先例），避免与自动化输入/密码捕获抢 debugger。
- 注入脚本行为（一次性，完成后自清）：
  - 建固定定位高亮层 `#bao-element-picker`（`pointer-events:none`，边框跟随悬停元素）；
  - document mousemove → `elementFromPoint` → 描边高亮；
  - document click（捕获阶段）→ `preventDefault + stopPropagation` **仅吞这一击** →
    取目标元素 → `describeElement(el)` 生成 `{selector, label}` + `getBoundingClientRect()`
    → 写 `window.__baoPickResult = {...}` → 移除全部监听与高亮层；
  - 注入失败/页面导航 try/catch 兜底，不残留。
- 主进程轮询（~200ms，上限 120s）读 `window.__baoPickResult`；
  `automation:cancel-pick` 使轮询即时结束并返回 CANCELLED。
- 模块级单例守卫：同一时间只允许一个拾取会话（重复 pick 先取消上一个）。
- 选择器生成规则（`describeElement`，稳定性排序）：
  1. 元素有唯一且安全的 `id` → `#id`（CSS 转义 id）；
  2. 否则 `tag.class`（唯一时）→ 否则沿 `tag:nth-of-type(n)` 生成**唯一化路径**
     （从根到目标逐层剥离出唯一描述）；
  3. 属性/类名一律 CSS.escape 式转义，杜绝选择器注入。
- `label`：`文本标签 (tag#id)` 形态，仅展示。

### 边界

- 播放器在跨域 iframe 内：顶层 `elementFromPoint` 命中 iframe 元素 → rect = iframe
  可视区（期望结果）；无法拾取 iframe 内部元素（顶层 querySelector 不可达其内容，
  匹配帧截的也是 iframe 合成内容，语义自洽）。
- 画面有多个 Flash 元素（广告等）：拾取即绑定用户点中的那一个，选择器唯一化。

## 运行时解析与匹配（执行时）

- driver `findImage` 每匹配前：
  1. 依 §数据模型 优先级求"是否命中聚焦"：`focusRegion && regionScope !== 'viewport'
     && !region`；
  2. `resolveEffectiveRegion`（纯函数）+ 运行时 `executeJavaScript` 注入
     `buildFocusRectScript().resolveFocusRect(selector)` —— 选择器经 `JSON.stringify`
     安全注入 `querySelector`（**注入脚本串内无任何 eval**）；返回值 {x,y,width,height}
     按 CSS 视口取整并**钳制到 [0, viewport]**；
  3. 结果 `null`/宽或高 ≤ 0 → `onFocusRegionFallback(selector, reason)` 回调 +
     **按全区匹配**继续（不中止）；
  4. 命中 → 以该矩形作为 `region` 传给 matcher（`cssRegionToDevice` 不变，
     坐标同为 CSS 视口系）。
- per-step 重解析 = D2-B：即使运行中元素移动/伸缩/窗口切换，下一匹配即对准。
- 事件：`onEvent` 增 `{ type: 'focus-region-fallback', selector, reason:
  'not-found' | 'zero-size' }`（运行日志/UI 可见，不中断）。
- **最小化运行前置**（记录，非本功能实现）：元素矩形由 DOM 布局计算，
  与窗口状态无关；但 `capturePage` 帧的新鲜度依赖标签保持活动/不被休眠——沿用
  既有休眠门控约束，写入运行条件文档。

## IPC 接口

`src/main/ipc/automation.ipc.ts`（沿用 `createValidatedHandler` + zod strict）：

| 通道 | 入参 | 返回 | 说明 |
|------|------|------|------|
| `automation:pick-region` | `{ tabId }` | `{ ok:true, selector, label } | { ok:false, code, error }` | 启动拾取会话；tab 须为合法有视图的标签 |
| `automation:cancel-pick` | 无参 → `z.object({}).optional()` | `{ ok:true }` | 取消当前拾取 |

错误码：`NO_TAB`（无 BrowserView）、`PICK_BUSY`（已有会话）、`TIMEOUT`、
`CANCELLED`、`PICK_FAILED`（注入/解析异常）、`NO_SELECTION`（空元素，防御）。

## Preload 与类型

- `ALLOWED_INVOKE_CHANNELS` 追加 `'automation:pick-region'`, `'automation:cancel-pick'`。
- `electronAPI.automation.pickRegion(tabId)` / `cancelPick()`。
- `src/renderer/types/electron.d.ts` 补 `FocusRegion` / `PickRegionResult`。

## UI（工作台）

**AutomationPage「播放器区域」栏**（Blockly 上方）：
- 未设置：显示"未设置 — 图像将在整个页面搜索"+ [拾取区域] 按钮；
- 已设置：显示 `label`（无则 selector 截断）+ [重新拾取] [清除]；
- 拾取流程中：按钮转"请点击游戏中的播放器区域…"+ [取消]（走 cancel-pick）；
- 运行/回退告警：运行面板实时显示 `focus-region-fallback` 事件。

**Blockly 图像积木**（wait/click/move/hold/repeat-until）：加
"搜索范围:跟随播放器区域 / 全区" 下拉（`regionScope`，默认跟随）；
`repeat-until-image` 的条件本体跟随，不另设。`if-image`/条件块不加（YAGNI）。

**i18n**：新增文案集中在 `LL.automation.*`（焦点区域标签/按钮/提示/事件文案），
zh-CN + en 双侧；改后 `npm run i18n` 再 build。

## 测试

| 层 | 内容 |
|----|------|
| vitest | `element-selector.test.ts`：describeElement 稳定性（id→tag.class→nth-of-type 路径）、id/类名转义防注入、iframe 命中返回 iframe rect 语义；`focus-region-policy.test.ts`：resolveEffectiveRegion 三优先级别断（静态 region > focusRegion > 全区）、零尺寸/不存在回退、regionScope 覆盖 |
| Electron 冒烟 | `focus-region-smoke.cjs`（自带夹具页 + mock 全部 preload 通道，凭 AGENTS.md 守则）：① 拾取端到端——注入拾取器→模拟点击播放器元素→断言返回 selector+rect 且页面无残留监听；② 运行时——workflow 带 focusRegion 跑夹具页：区域内目标命中且**区域外同形干扰物不触发命中**；③ 回退——无播放器元素页跑该 workflow：脚本走完、日志见 `focus-region-fallback` |
| 回归 | 既有 `test:automation`/`probe:deep` 全绿（兼容性）；`npm run i18n` 后 typecheck+lint |

## 边界与注意

1. **无 eval**：运行时解析与注入脚本中，选择器均 `JSON.stringify` 进 `querySelector`；
   拾取选择器经转义生成。用户手改工作流里的恶意 selector 最坏是解析不到 → 回退全区，
   不会执行任意代码。
2. **拾取会话单例**：主进程模块级守卫，防多页面/多会话交叉。
3. **页面导航中断拾取**：注入脚本随文档销毁，轮询读到 `null` 超时 → `TIMEOUT`；
   注入 try/catch，不残留 `window.__baoPickResult` 影响后续。
4. **click 抢占**：拾取确认点击吞掉捕获阶段 preventDefault+stopPropagation，
   只影响被点的那一击，不注入常驻页面逻辑；拾取结束即清。
5. **区域部分出视口**：元素矩形钳制到 CSS 视口（matcher 亦钳到设备尺寸）；
   出界部分不参与匹配。游戏比视口大时属预期（搜索框=可见播放器区域）。
6. **预览语义**：拾取返回的是"当时矩形"仅用于提示；**运行时一律重新解析**，
   布局变化不依赖快照。
7. **capability 声明**：使用 focusRegion 的包在 manifest 声明 `focus-region`，
   便于发布校验与旧版本兼容提示（`minimumAppVersion` 前置）。
8. **最小化运行**：元素矩形不受窗口状态影响；帧新鲜度沿用既有"标签保持活动"约束。

## YAGNI（本次不做）

- 多命名区域表（方案 3 扩展点：`focusRegion` 未来可演进为数组）
- 自动检测播放器元素（无拾取交互的启发式）——用户已明确走"直接选 HTML 元素"
- if-image / 条件节点的逐条件 regionScope
- 拾取器键盘浏览（Tab 遍历元素）、多选
- 运行时"已解析矩形"缓存策略（每匹配重解析已满足，先不做节流）