# BaoFlashBrowser Automation 2.0 文档驱动执行计划

> 状态：Complete  
> 日期：2026-08-30  
> 模式：Document-Driven Development  
> 总目标：把以 Blockly Workflow 为中心的自动化系统重构为 Automation Core + Blockly / JavaScript / Recorder 多前端平台。

## 1. 目标架构

```text
                    Automation Frontends
          ┌──────────────┼──────────────┐
       Blockly       JavaScript       Recorder
          └──────────────┼──────────────┘
                         ↓
                   Automation Core
          ┌──────────────┼──────────────┐
       Actions         Locators        Context
          └──────────────┼──────────────┘
                         ↓
       Vision │ Text Recognition │ Input │ Browser
                         ↓
                 Coordinate Resolver
                         ↓
              Viewport / Resolved Surface
                         ↓
                     BrowserView
```

Blockly 只负责编译/反编译受限 Workflow IR；JavaScript 通过受限 `bao.*` API 调用同一 Core；Recorder 只产生 Core 能理解的数据，不拥有独立执行语义。

## 2. 总体交付策略

本重构不是一个连续大补丁，而是九个带门禁的阶段。每个 Phase 分为四种活动：

1. **Document**：事实、需求、设计、ADR 和详细执行计划。
2. **Implement**：仅执行已批准批次。
3. **Verify**：自动化测试、Electron smoke、benchmark、人工验证。
4. **Close**：追踪矩阵完整、风险关闭、临时代码登记、状态更新。

Phase 0/1 只有 Document、Review 和 Close，不包含产品代码实现。

## 3. 全局架构约束

### 3.1 平台约束

- Electron 固定为 11.5.0 / Chromium 87，不升级。
- BrowserView 是唯一页面执行目标，不改为 BrowserWindow 或 `<webview>`。
- PPAPI 与 Ruffle 的隔离配置保持既有约束。
- CDP 输入继续与密码捕获使用显式租约，导航前不得保持 debugger attached。
- 所有坐标最终解析到 BrowserView 的实时逻辑/CSS坐标，再映射到 CDP 所需坐标。

### 3.2 Core 约束

- Action 不知道 Locator 的具体类型。
- Locator 不直接发送输入。
- Point、Region、Match 不允许脱离 Space/Frame 解释。
- 持久化 Surface 描述和运行时 ResolvedSurface 必须是不同类型。
- CaptureFrame 不可变；识别结果必须绑定产生它的 Frame/Transform。
- Context 使用作用域继承，不由 Driver 暴露可变 `page/game` 开关。
- Vision、Text Recognition、Input、Capture、Browser Adapter 之间只通过明确接口协作。
- Blockly、JavaScript、Recorder 不复制 Core 语义。

### 3.3 断代约束

- “Automation 2.0”是产品架构名；新 `.baoauto` 文件格式建议使用 `formatVersion: 3`。
- 可在重构期间使用有删除期限的内部适配器维持主分支可运行。
- 每个适配器创建时必须登记 owner、用途、搜索标记和 Phase 8 删除条件。
- Phase 8 后不保留旧 Step、page/game 类型、旧 Blockly blocks、迁移代码或 deprecated API。
- Pixel OCR 不进入本计划。

## 4. 文档与追踪编号

使用以下稳定编号，避免只靠章节标题追踪：

- `REQ-xxx`：产品或架构需求。
- `INV-xxx`：现状审计事实。
- `ADR-xxx`：已决定的架构选择。
- `RISK-xxx`：风险及关闭条件。
- `P0-Txx` ... `P8-Txx`：阶段任务。
- `TEST-xxx`：自动化、benchmark 或人工验证。
- `LEGACY-xxx`：必须在 Phase 8 删除的临时或旧能力。

`traceability.md` 至少包含：

```text
Requirement → Audit Evidence → ADR/Design → Phase Task → Code → Test → Verification
```

## 5. Phase 0 — 现状审计

### 目标

从源码和测试建立可复核事实，不根据 README 推断，不修改产品代码。

### 任务批次

#### P0-T01：范围与源码清单

- shared types/schema/abort/game-surface feature。
- runtime/driver/service/package/assets。
- vision worker/matcher/OCR/capture geometry/game surface detector。
- Blockly、AutomationPage、侧栏、store/workspace/localStorage。
- preload、Automation IPC、Userscript IPC、页面助手。
- `.baoauto`、测试、probe、构建和发布脚本。

输出：文件清单、LOC、依赖方向、入口与出口。

#### P0-T02：四条调用链

分别追踪并画图：

1. Blockly/JSON 保存与运行。
2. 页面助手取材与坐标选择。
3. 运行时 Image Locator → Click。
4. OCR 测试与运行时 Text 查找。

每条链必须标注进程边界、IPC、数据单位、缓存、CDP attach/detach 和错误传播。

#### P0-T03：量化矩阵

统计并解释：

- Step Type、Condition Type、Block Type。
- Image/Text/Coordinate 动作与流程镜像。
- page/game 分支和 search region 继承。
- Runtime/Schema/Service/Blockly switch 或穷举点。
- Driver 职责和公共接口。
- Capture、Vision、OCR 重复路径。
- Coordinate conversion 的每一步和舍入规则。
- IPC 能力面及其调用者。

#### P0-T04：隐含合同与缺口

- 从单元测试、Electron smoke、文档和旧设计中提取不可破坏行为。
- 明确哪些合同属于业务要求，哪些只是旧实现偶然行为。
- 标注测试空洞，例如不同 ROI 的多个 Match、Frame stale、Surface 重定位、OCR 匹配语义差异。

#### P0-T05：审计评审

形成 `automation-v2-architecture-audit.md`，状态依次为 `In Progress → Review → Approved`。审计包含事实，不提前确定 Core 接口。

### Phase 0 出口门禁

- 用户指定范围全部覆盖。
- 所有统计可从源码复算。
- 调用链能解释实际截图到 CDP 输入的完整路径。
- 已区分事实、推断、风险和建议。
- 无产品代码变更。

## 6. Phase 1 — Automation 2.0 Core 设计

### 目标

冻结后续所有实现共同遵守的语义模型；禁止实现。

### 必须回答的设计问题

#### P1-T01：空间与几何

- `ViewportSpace` 与 `SurfaceSpace` 如何标识和引用。
- Point/Region 的坐标单位、边界、舍入、序列化格式。
- 持久化 `SurfaceSpec` 与运行时 `ResolvedSurface` 的生命周期。
- iframe/container/Flash/Ruffle/Canvas/用户区域的组合关系。
- Surface 消失、移动、缩放和重新定位时如何处理旧 Frame/Match。

#### P1-T02：Locator 与结果

- `CoordinateLocator`、`ImageLocator`、`TextLocator`。
- Locator 返回 Point、Region 还是统一 `LocatedTarget`。
- timeout/retry/visibility 属于 Locator、Query 还是控制节点。
- offset、anchor、alternatives、threshold、match mode 的归属。
- Match 必须如何携带 frameId、space、bounds、confidence 和 evidence。

#### P1-T03：Action 与 Query

- `ClickAction`、`MoveAction`、`DragAction`、keyboard/text/scroll/navigation。
- `Find`、`Exists`、`ReadText`、`ReadNumber` 的不同返回值和错误语义。
- TextLocator 与 ReadText/ReadNumber 明确分离。
- Action 如何只消费统一 LocatorResult，不判别 Locator kind。

#### P1-T04：Value、Expression、Context

- Boolean/Number/String/Point/Region/recognition result 等 Value 边界。
- 变量作用域、只读/可写、未定义值和类型错误。
- Context 的 Surface/Region/timeout/cancellation/frame reuse 继承规则。
- `with surface`、`with region` 嵌套、遮蔽和退出恢复规则。

#### P1-T05：Recognizer 与 Capture

- `CaptureRequest`、`CaptureFrame`、`FrameTransform`。
- 一帧被 Vision/OCR/复核复用的条件和失效策略。
- `VisionService` 与 `TextRecognizer` 的提供者接口。
- Paddle baseline、RapidOCR/ONNX 和未来 PixelGlyphRecognizer 的边界。

#### P1-T06：Runtime IR

- sequence/if/loop/break/continue/wait/action/variable/basic expression。
- Workflow IR 与 Action/Locator 数据的边界。
- 错误分类、软超时、取消、预算、最大深度和无限循环让出。
- 为什么 Blockly 不提供 try/catch、class、closure、复杂对象与高级数组。

#### P1-T07：前端与安全边界

- Blockly codec、JavaScript API、Recorder 各自输入输出。
- `bao.*` capability、网络、文件、通知、导航和敏感操作权限。
- Electron 11 下的沙箱威胁模型；Node `vm` 不作为安全边界。
- 新 `.baoauto` manifest、workflow/scripts/assets/profiles 的寻址和权限声明草案。

#### P1-T08：ADR 与接口草案评审

至少形成以下 ADR：

- 新包格式版本。
- 坐标单位与 Space identity。
- SurfaceSpec/ResolvedSurface 分离。
- CaptureFrame/Match 所有权。
- LocatorResult 统一形态。
- Runtime dispatch 模型。
- Capture reuse policy。
- JavaScript sandbox/capability model。
- OCR provider 与 benchmark 决策规则。

输出 `automation-v2-core-design.md` 和 TypeScript interface 草案。草案放在文档代码块或独立 `.draft.ts` 文档附件中，不进入 `src/`。

### Phase 1 出口门禁

- Action、Locator、Value、Space、Surface、Region、Context、Recognizer 均有唯一且不循环的定义。
- 至少用坐标点击、图片点击、文字点击、ReadNumber、跨 Surface、Frame stale 六个例子走通模型。
- 新增 Locator 不要求修改 Action 的设计约束可由接口测试表达。
- JS 权限和包格式对 Core 的影响已提前解决。
- 没有阻塞 Phase 2 的核心开放问题。
- 设计状态为 `Approved`，仍无产品实现。

## 7. Phase 2 — Coordinate / Surface 重建

### 实现批次

1. 纯类型与纯函数：Space、Point、Region、Transform、CoordinateResolver。
2. SurfaceSpec/ResolvedSurface 与现有 game-surface detector 的适配边界。
3. BrowserView viewport/display transform adapter。
4. CaptureFrame geometry 和 Match→Point 转换。
5. 用临时适配器接回 Automation 1.x，保持行为可比较。
6. 属性测试和 Electron 矩阵验证。

### 验收重点

- Viewport/Surface 往返误差有明确上限。
- DPI、Zoom、窗口尺寸、区域截图和嵌套 iframe 覆盖。
- 上层不再读取 `page/game`。
- Match 不再通过全局 `lastFrame` 解释。
- Phase 2 不修改 Blockly UI 和新 Workflow 语义。

## 8. Phase 3 — Locator + Action

### 实现批次

1. Locator 类型、LocatedTarget 与 LocatorResolver。
2. Coordinate/Image/Text 三种 resolver。
3. Click/Move/Drag 接受 Locator。
4. Wait/Exists/Find 查询语义。
5. Automation 1.x Step → Core 调用的临时 adapter。
6. 扩展性合同测试。

### 核心验收

测试注册一个仅用于测试的新 Locator，Click/Move/Drag 不修改实现即可使用。禁止出现 `click-image`、`click-text`、`click-coordinate` 对应的 Core Action 类。

## 9. Phase 4 — Vision / OCR / Input 解耦

### 实现批次

1. 提取 BrowserViewAdapter 与 CaptureService。
2. 提取 InputService，集中 CDP 输入、按键释放与导航租约。
3. 提取 VisionService 和 worker provider。
4. 提取 TextRecognitionService 与 TextRecognizer provider。
5. 统一运行、组合条件、复核、测试台、页面助手的 CaptureFrame 获取。
6. 建立 OCR benchmark harness 和代表性数据集。
7. 根据数据决定默认 OCR；旧 PaddleOCR-json 在新方案通过前保留 baseline。

### OCR 决策门

同时评估 RapidOCR/ONNX + PP-OCRv6 small、PP-OCRv6 tiny 和当前 PaddleOCR-json + PP-OCRv3。记录冷/热延迟、ROI/全帧、中文/数字/低分辨率、内存、安装体积、取消与崩溃恢复。未经 benchmark 不切换默认提供者。

### 核心验收

- 同一 Context 中兼容的 Image/Text/复核请求共享一个 Frame。
- Service 之间无反向依赖。
- Driver 不再同时承担 Capture、Recognition、Input 和 Navigation。

## 10. Phase 5 — Runtime 2.0

### 实现批次

1. Workflow IR schema 和 expression/value evaluator。
2. Runtime lifecycle、预算、取消和事件模型。
3. sequence/if/loop/break/continue/wait。
4. Action dispatcher 与 Query evaluation。
5. variable/basic expression。
6. 调试事件、日志和 step mode。
7. Core conformance tests 与旧 Runtime 行为对照。

### 约束

允许对少量控制节点进行清晰分派，但 Action 和 Locator 必须通过各自注册表/接口扩展，不能恢复为按 Image/Text/Coordinate 增长的大 switch。

### 验收

- 所有支持节点有确定性测试。
- break/continue 只作用于最近循环。
- 取消、无限循环让出、步数/深度预算稳定。
- Blockly DSL 明确不实现完整 JavaScript 语言能力。

## 11. Phase 6 — Blockly 2.0

### 实现批次

1. Blockly frontend contract 和 Workflow IR codec。
2. Locator value blocks：Coordinate/Image/Text。
3. Action blocks：Click/Move/Drag 等接收 Locator input。
4. Context blocks：Surface/Region。
5. Control/value/expression blocks。
6. 旧 Blocks 删除和 toolbox/i18n/guide 重写。
7. round-trip 与 Chromium 87 Electron smoke。

### 验收

- 点击、移动、拖拽不再按 Locator 类型复制积木。
- page/game 下拉从动作积木消失。
- Block 总量和镜像矩阵较 Phase 0 明显下降，并在审计对照表中量化。
- Blockly 编译结果通过 Core schema；反编译保持语义。

## 12. Phase 7 — JavaScript Automation API

### API 范围

```text
bao.input
bao.vision
bao.ocr
bao.page
bao.time
bao.log
bao.notify
```

### 实现批次

1. 沙箱执行宿主和销毁模型。
2. capability manifest 与授权 UI/策略。
3. `bao.*` bridge，映射到同一 Core。
4. 网络/文件/导航/通知默认权限策略。
5. 超时、取消、调用预算、输出限制与审计日志。
6. 恶意与故障脚本测试。
7. API 文档、类型声明和示例。

### 安全验收

- 脚本无法访问 Node、Electron、任意 IPC 或宿主文件系统。
- 默认无法任意联网；授权遵循 manifest/capability。
- 强制取消后执行环境和未完成调用被释放。
- JS 和 Blockly 对相同 Core 行为通过 conformance suite。

## 13. Phase 8 — `.baoauto`、Recorder 与旧系统清理

### 实现批次

1. 新 manifest/package schema 与安全限制。
2. workflow + scripts + assets + profiles 共存。
3. Recorder event → Core Locator/Action/Context 输出。
4. 导入、导出、诊断、权限展示和包测试。
5. 删除 Automation 1.x Workflow/Step/Blocks/page-game/adapter/migration/deprecated API。
6. IPC、文档、i18n、测试、构建和发布脚本清理。
7. 全仓死代码搜索和最终 Electron 验证。

### 最终清零搜索

`legacy-removal-inventory.md` 为唯一清单。至少搜索旧 Step literal、旧 Block ID、`AutomationCoordinateSpace`、旧 parser/migration、旧 driver methods 和 compatibility 标记。每项必须是零结果或有经批准的非 Legacy 同名解释。

### 最终验收

- 旧 `.baoauto` 明确报 unsupported version，不静默迁移。
- Blockly 与 JS 可在一个新包中共存。
- Recorder 输出直接由 Runtime 2.0 执行。
- 全套 typecheck/lint/Vitest/build/Electron smoke 通过。
- Automation 1.x 代码、测试和文档入口清零。

## 14. 验证层级

每个实现 Phase 按以下层级验证：

1. 纯函数/类型单测。
2. Core contract 和 property tests。
3. Service integration tests。
4. BrowserView/Ruffle/PPAPI Electron smoke。
5. 窗口尺寸、DPI、Zoom、最小化和 Surface 重定位矩阵。
6. 必要的真实 Flash/Ruffle 游戏人工验证。
7. `npm run check` 总回归。

Electron smoke 的构建产物必须按 `AGENTS.md` 对应脚本重建，不能测试陈旧 `release/tests` bundle。

## 15. 变更控制

以下变化必须先新增或修订 ADR：

- Space/Point/Region 的单位或序列化。
- Surface identity 或重新定位策略。
- LocatorResult/Match 结构。
- CaptureFrame 生命周期或复用策略。
- Runtime 控制流与错误恢复语义。
- JS 沙箱或 capability 边界。
- `.baoauto` 版本、目录或执行内容。
- OCR 默认 provider。

普通实现细节只需更新 Phase 计划；若批次发现设计错误，应停止实现，把状态退回 `Review`，不得在代码中隐式决定。

## 16. 完成定义

Automation 2.0 只有同时满足以下条件才完成：

- 三个前端共享同一个 Core，而非共享文件名但复制语义。
- Coordinate/Surface/Frame/Locator/Action/Context 的边界由类型和测试强制。
- 增加 Locator 不要求增加成套 Action。
- TextLocator 与 ReadText/ReadNumber 语义分离。
- CaptureFrame 能跨 Vision/OCR/复核安全复用。
- Runtime 2.0 是受限 Workflow 解释器，不是劣化版 JavaScript。
- JavaScript 环境有可验证的权限边界。
- 新包格式不与当前 formatVersion 2 混淆。
- Automation 1.x 和所有临时适配层已经删除。
- Pixel OCR 仍保持独立后续项目。
