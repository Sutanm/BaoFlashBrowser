# Automation 2.0 状态

> 最后更新：2026-08-30

## 当前状态

| 项目 | 状态 |
|---|---|
| 主执行计划 | Complete |
| 当前 Phase | Phase 8 — Complete |
| 当前实现批次 | P8-T10 — cutover verification complete |
| 产品代码变更授权 | 已批准Core设计范围内连续执行 |
| 工作树基线 | 已存在用户未提交改动，执行时必须保护 |

## Phase 看板

| Phase | 状态 | 核心产物 | 进入实现的必要门禁 |
|---|---|---|---|
| 0 现状审计 | Approved | `automation-v2-architecture-audit.md` | 无；只读开始 |
| 1 Core 数据模型 | Approved | `automation-v2-core-design.md` + ADR + TS 草案 | Phase 0 Approved |
| 2 Coordinate / Surface | Complete | Phase 2 计划、实现、坐标验证矩阵 | Phase 1 Approved |
| 3 Locator + Action | Complete | Locator/Action Core 与扩展性测试 | Phase 2 Complete |
| 4 Vision/OCR/Input 解耦 | Complete | 能力服务、CaptureFrame 复用、OCR benchmark | Phase 3 Complete |
| 5 Runtime 2.0 | Complete | 受限 Workflow IR 与解释器 | Phase 4 Complete |
| 6 Blockly 2.0 | Complete | Blockly frontend/codec | Phase 5 Complete |
| 7 JavaScript API | Complete | 沙箱、权限与 `bao.*` API | Phase 5 Complete；安全 ADR Approved |
| 8 包格式/Recorder/清理 | Complete | 新 `.baoauto`、Recorder、Legacy 清零 | Phase 6/7 Complete |
| 后续 Pixel OCR | Out of Scope | 独立研究计划 | Automation 2.0 稳定后 |

## 已确认基线

- 当前 Workflow Step Type：34。
- 当前 Blockly Block Type：43。
- Runtime `step.type` 分支：34。
- 工作台 Automation IPC：37；页面助手 Automation IPC：16。
- Automation 专项测试：26 个文件，约 4,154 行。
- 2026-08-30 完整 Vitest：84 files / 558 tests passed。
- `npm run probe` 的构建新鲜度、config 和日志探针失败；原因分别为陈旧 smoke bundle、本机无 config、本机无 main.log，不视为产品逻辑失败。
- 当前 `.baoauto` 已使用 `formatVersion: 2`；Automation 2.0 新格式不得复用该版本号。
- 当前工作树包含用户对 `.idea/workspace.xml` 和 `browserview-driver.ts` 的未提交修改。

## 最近完成批次

`P0-T01：范围与源码清单`

完成证据：

1. 已枚举 shared/main/preload/renderer/userscript 的 Automation 文件和耦合集成点。
2. 已枚举测试、probe、构建、发布、OCR bundle 和历史设计文档。
3. 已记录模块职责、进程边界、主要入口/出口、依赖和代码规模。
4. 已创建 `automation-v2-architecture-audit.md`，写入可复算命令与 P0-T01 事实结论。
5. 未修改产品代码，未触碰用户已有的 `browserview-driver.ts` 修改。

## 最近完成批次

`P0-T02：四条调用链`

完成证据：

1. 已逐源码记录 Blockly 编辑/草稿/保存/运行链。
2. 已记录 JSON 与 Blocks 的双向转换、Apply/Save 和错误出口。
3. 已记录页面助手授权、运行、识别、素材捕获、坐标和 surface 链。
4. 已记录 `.baoauto` preview/commit、双重校验、持久化和启动恢复链。
5. 已补齐 Blockly → Workflow Schema → Service → Runtime → Driver → Vision/OCR/Input 主干图。
6. 已整理状态/资源所有权、取消/错误传播和对应测试证据。
7. 未修改产品代码，未触碰用户已有的 `browserview-driver.ts` 修改。

## 最近完成批次

`P0-T03：量化与镜像能力矩阵`

完成证据：

1. 已固定口径复核 34 Step、6 Condition、43 Block、34/34/33 个主要 switch case。
2. 已建立 Image/Text/Coordinate 动作、等待、条件、拖动和位置比较矩阵。
3. 已统计 10 个 page/game 显式条件点和 Driver 23 个协议方法的七类职责。
4. 已统计 4 个 Capture 调用点、2 个 OCR recognize 调用点及前端/IPC后处理重复。
5. 已画出 normalized point、recognition region、Image match、OCR box、authoring reverse 和 capture crop 转换路径。
6. 已用固定清单复核 Automation 命名测试为 26 文件、4,154 行。
7. 未修改产品代码，未触碰用户已有的 `browserview-driver.ts` 修改。

## 最近完成批次

`P0-T04：隐式契约、并发、资源与安全边界`

完成证据：

1. 已画出 active/probe/authoring、matcher cache、OCR、surface map 的状态与所有权图。
2. 已建立主要入口的互斥矩阵，并确认 surface wait 在 session 占位前且不可被 Service cancel。
3. 已审计 BrowserView viewport token、CDP lease、WebContents replacement、navigation 和 password capture 边界。
4. 已审计 Frame/Match generation 缺口、Vision 每实例预算和 OCR 全局队列/超时/重启行为。
5. 已统计 package/capture/test scene/assistant/linked-folder 临时对象的 TTL 与上限。
6. 已区分 manifest capability、主工作台可信 IPC 和页面助手专用 grant，不把 capability 误判为权限。
7. 已登记 11 项 Phase 0 风险、12 项 Phase 1 不变量候选和后续测试空洞。
8. 未修改产品代码，未触碰用户已有的 `browserview-driver.ts` 修改。

## 最近完成批次

`P0-T05：审计收口`

完成证据：

1. 已对照用户指定的14个调查域完成coverage checklist，无遗漏域。
2. 已固定最终数字基线，并区分事实、平台合同、隐式合同、推断、风险和设计输入。
3. 已按P0/P1/P2依赖顺序汇总架构债务，整理Phase 1四组开放问题。
4. 已创建traceability与verification log，记录Phase 0来源和验证证据。
5. 2026-08-30重新运行完整Vitest：84 files / 558 tests passed。
6. 工作树复核确认产品文件只有审计前已存在的两处用户修改。

## 最近完成批次

`P1-T01～P1-T08：Automation 2.0 Core设计`

完成证据：

1. 已冻结Action、Locator、Value、Space、Surface、Region、Context、Recognizer和Operation唯一职责。
2. 已设计ratio/logical geometry、generation-branded Space和SurfaceSpec/ResolvedSurface。
3. 已设计统一LocatedTarget，使Click/Move/Drag不判断Locator kind。
4. 已分离TextLocator、ReadText、ReadNumber及其错误语义。
5. 已设计不可变CaptureFrame、FrameTransform和Context内capture reuse。
6. 已设计有限Runtime IR、冻结registry、RunHandle、budget和error taxonomy。
7. 已设计Blockly/JS/Recorder合同、sandboxed renderer与Host Capability Broker。
8. 已固定`.baoauto` format v3并分离features/permissions/grant。
9. 已形成10项ADR和独立TypeScript interface草案。
10. 已走通六个强制场景和新增ColorLocator零Action修改合同。
11. 草案通过strict TypeScript编译；完整Vitest 84 files / 558 tests通过。
12. 未修改产品代码，用户原有工作树修改保持不变。

## 最近完成批次

`P2-T01～P2-T07：Coordinate / Surface重建`

完成证据：

1. 新增纯Core geometry、Surface、CoordinateResolver和Frame geometry模块。
2. Point/Region均绑定Space；target/viewport/surface generation失效会typed reject。
3. BrowserView logical/display mapping与capture outward rounding已独立成adapter。
4. 旧0..10000、page/game和lastFrame桥接集中登记为LEGACY-P2-001/002/003。
5. Driver原有行为、OCR调试日志和Blockly均保持不变。
6. 新增6个测试文件、37项测试；完整基线90 files / 595 tests通过。
7. typecheck通过；lint 0 errors（34个仓库既有warnings）；production build通过。
8. Electron input和fixed viewport探针通过，debugger detach/navigation正常。

## 最近完成批次

`P4-T01～P4-T08：Vision / OCR / Input / Capture解耦`

1. Image/Text识别结果绑定自身FrameGeometry，Driver删除`lastFrame`。
2. CaptureService统一截图归一化和兼容Context同帧复用。
3. Vision、Text Recognition、Input和provider contracts从Driver拆出。
4. Paddle OCR与Vision worker不再反向导入Driver；OCR请求具备deadline与restart。
5. TextLocator与ReadText/ReadNumber语义在服务层分离。
6. 新增OCR benchmark harness和候选corpus manifest；未切换baseline。
7. 完整验证为95 files / 614 tests；typecheck、lint、build与Electron探针通过。

## 最近完成批次

`P5-T01～P5-T10：Automation Runtime 2.0`

1. Workflow IR、Value/Expression、validator和evaluator不依赖旧Step。
2. Runtime只解释受限控制节点，Action/Query/Locator由冻结registry扩展。
3. 实现循环、break/continue、wait、变量、Context lease、预算和yield。
4. RunHandle的cancel完成即资源barrier完成，event history有界。
5. `LEGACY-P5-001`只作为Phase 8前的单向执行桥接。
6. 完整验证99 files / 634 tests；typecheck、lint、build通过。

## 最近完成批次

`P6-T01～P6-T10：Blockly 2.0`

1. 33个通用block替代旧43个镜像taxonomy；唯一入口显式选择页面视口/游戏区域，Action × Locator仍用空value槽组合，默认不填充识别条件。
2. Context嵌套表达viewport/game/region作用域，动作无page/game字段。
3. workspace与Workflow IR v3直接双向codec，静态validator复核。
4. v3 editor使用独立draft key，不读取旧XML；Phase 8再原子切换页面入口和包格式。
5. 产品可用性纠偏恢复7个中文能力分类、独立分类颜色、0–10000坐标、OCR读取、键盘/页面/调试入口；修复Region Context和Surface默认截图范围，并通过真实DOM入口、空目标槽和flyout收起残影验收。

## 最近完成批次

`P7-T01～P7-T10：JavaScript Automation API / Sandbox`

1. 19个固定method与7项capability，三层grant只能收紧。
2. Broker验证token/route/payload/budget/deadline并复用Core服务。
3. preload只暴露冻结`bao`；renderer拒绝Node/Electron/IPC/network/navigation/permissions。
4. timeout/cancel完成即window/route/pending call资源barrier完成。
5. Electron 11不兼容`sandbox:true`的事实和残余风险已进入security review。
6. 完整验证102 files / 648 tests；typecheck、lint、build和Electron smoke通过。

## Phase 8 完成摘要

1. `.baoauto` v3支持workflow、多个scripts、assets与profiles共存；旧版本明确`UNSUPPORTED_FORMAT`。
2. Blockly、JavaScript与Recorder直接生产/消费Core IR；侧栏显式选择frontend/profile运行。
3. install grant独立持久化，导入时确认；manifest/profile不能自行授予权限。
4. BrowserView Core session统一Coordinate/Surface/Locator/Action/Capture/Vision/OCR/Input。
5. 旧Workflow/Step/Runtime/Driver/service/package/Blockly与assistant compatibility adapter已删除；页面悬浮助手保留为v3原生frontend，并直接复用Core Capture/Vision/OCR/Input能力。
6. Pixel OCR仍为后续独立Phase，默认OCR provider未在无benchmark证据时切换。
