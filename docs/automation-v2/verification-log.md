# Automation 2.0 验证日志

> 状态：Complete  
> 最后更新：2026-08-30

## Phase 0 — 现状审计

### 验证环境

- Workspace：`D:\java_workspace\BaoFlashBrowser`
- Platform：Windows / PowerShell
- Date：2026-08-30
- Product code policy：Phase 0禁止修改产品代码

### P0-T01～P0-T04

使用只读的`rg`、`Get-Content`、`git status`和固定文件清单完成源码、调用链、统计、资源与安全审计。可复算命令和口径记录在`automation-v2-architecture-audit.md` §2、§22、§30、§46。

首次完整Vitest基线：

```text
Test Files  84 passed (84)
Tests       558 passed (558)
```

`npm run probe`的build freshness、config和log tail探针失败；已确认分别由陈旧Electron smoke bundle、本机没有config、本机没有main.log导致，不作为Automation产品逻辑失败。Phase 0未为消除这些环境状态而改写文件。

### P0-T05 收口复核

命令：

```powershell
npm test -- --run
git status --short
git diff --check
```

结果：

```text
Test Files  84 passed (84)
Tests       558 passed (558)
Duration    2.92s
```

工作树结果：

- `.idea/workspace.xml`：审计前已存在的用户修改。
- `src/main/modules/automation/browserview-driver.ts`：审计前已存在的用户修改。
- `docs/automation-v2/`：Phase 0文档新增/更新。
- 没有Phase 0产生的产品代码修改。
- `git diff --check`无内容错误；仅输出既有文件LF/CRLF提示。

### Phase 0 验证结论

`PASS / REVIEW`：审计范围、可复算统计、调用链、风险和测试基线已齐全；等待用户批准Phase 0后进入Phase 1。

## Phase 1 — Core数据模型设计

### 文档产物

- `automation-v2-core-design.md`
- `automation-v2-core-interfaces.draft.ts`
- `adr/0001`～`adr/0010`
- 更新后的`traceability.md`与`status.md`

### TypeScript草案验证

```powershell
.\node_modules\.bin\tsc.cmd --noEmit --strict --skipLibCheck --target ES2020 --module commonjs --lib ES2020,DOM docs/automation-v2/automation-v2-core-interfaces.draft.ts
```

结果：exit code 0，无类型错误。该草案位于`docs/`，不进入产品TypeScript build。

### 完整Vitest复核

```powershell
npm test -- --run
```

结果：

```text
Test Files  84 passed (84)
Tests       558 passed (558)
Duration    2.91s
```

### Phase 1验证结论

`PASS / REVIEW`：职责、依赖、场景、接口草案、ADR和Phase 2边界已齐全；没有产品代码变更。等待用户批准设计并授权Phase 2实现。

## Phase 2 — Coordinate / Surface

### 实现产物

- `src/shared/automation/core/geometry.ts`
- `surface.ts`、`coordinate-resolver.ts`、`frame-geometry.ts`、`index.ts`
- `browserview-coordinate-adapter.ts`
- `legacy-coordinate-adapter.ts`
- 6个新增Vitest文件

### 验证

```text
npm run typecheck                         PASS
npm run lint                              PASS，0 errors / 34 existing warnings
npm test -- --run                         PASS，90 files / 595 tests
npm run build                             PASS
npm run probe:automation-input            PASS
npm run probe:automation-viewport         PASS
```

Electron 11.5.0探针确认minimized CDP input、trusted mouse/keyboard、debugger detach、detach后navigation及large/windowed/narrow的非均匀viewport mapping全部通过。

### 工作树

- 保留审计前`.idea/workspace.xml`和Driver两行OCR日志。
- Phase 2新增Core/adapter/test/docs文件并修改Driver coordinate helper接入点。
- 未修改Blockly、Workflow schema、`.baoauto`或OCR provider。

### 结论

`PASS / COMPLETE`：Phase 2无架构偏差，进入Phase 3。

## Phase 3 — Locator + Action

### 实现与验证

- 开放`LocatorSpecMap`、冻结LocatorRegistry、LocatedTarget、selection/anchor/offset。
- Coordinate/Image/Text/firstOf resolver与Recognition port。
- Click/Move/Drag独立Action executor和ActionRegistry。
- Find/Exists/Wait query service。
- Color测试Locator通过module augmentation加入，三种Action零修改运行。
- `LEGACY-P3-001`把旧pointer Step单向翻译为Core plan；未修改旧schema/Blockly。

```text
npm run typecheck        PASS
npm run lint             PASS，0 errors / 34 existing warnings
npm test -- --run        PASS，92 files / 606 tests
npm run build            PASS
```

`PASS / COMPLETE`：Action × Locator架构约束已由编译和运行测试证明，进入Phase 4。

## Phase 4 — Capability Decoupling

### 实现与职责搜索

- Driver不存在`lastFrame`，Image/Text match携带`CaptureFrameGeometry`。
- Paddle OCR与Vision worker只依赖`capability-contracts.ts`，不再导入Driver。
- Capture、Vision、Text Recognition、Input分别成为独立服务；Driver保留旧`AutomationDriver` facade。
- OCR request deadline为30秒；timeout/abort kill sidecar并清空实例，下一请求重新启动。
- provider-neutral OCR benchmark harness与三候选manifest已建立；因v6 sidecar/model未入仓库，未生成虚假对比结果、未切换baseline。

### 验证

```text
npm run typecheck                 PASS
npm run lint                      PASS，0 errors / 34 existing warnings
npm test -- --run                 PASS，95 files / 614 tests
npm run build                     PASS
npm run probe:automation-input    PASS
npm run probe:automation-viewport PASS
git diff --check                  PASS（仅既有LF/CRLF提示）
```

`PASS / COMPLETE`：Phase 4能力边界和故障恢复门禁完成；OCR候选实测仍是切换默认provider前的强制门禁，不阻塞Runtime Core，进入Phase 5。

## Phase 5 — Runtime 2.0

- 新增Workflow IR、validator、expression evaluator、Query registry和Runtime/RunHandle。
- 解释器仅分支`sequence/if/loop/break/continue/wait/action/query/let/set/with`；职责搜索未发现`action.kind`、`locator.kind`或旧`step.type`分支。
- 测试用module augmentation加入`record` Action和`fixture` Query，Runtime零修改执行。
- cancellation测试确认RunHandle等待resource barrier；Context body总是释放lease。
- 旧Workflow桥接标记为`LEGACY-P5-001`，不支持的旧Step显式失败并继续由1.x Runtime执行。

```text
npm run typecheck   PASS
npm run lint        PASS，0 errors / 34 existing warnings
npm test -- --run   PASS，99 files / 634 tests
npm run build       PASS
git diff --check    PASS（仅既有LF/CRLF提示）
```

`PASS / COMPLETE`：Runtime 2.0控制流、扩展边界、预算和资源生命周期完成，进入Phase 6。

## Phase 6 — Blockly 2.0

- 22个核心block（目标≤24，旧系统43）；Click/Move/Drag与Coordinate/Image/Text正交组合。
- Action block只持有`BaoLocator` value input，不持有Locator专属字段或page/game。
- Context、控制流、基础变量/表达式和Exists Query直接生成Workflow IR v3。
- headless Blockly测试覆盖taxonomy、断线拒绝、IR validation和workspace round-trip。
- 新editor与旧XML/draft完全隔离；Activation与旧editor删除留在Phase 8格式断代的同一原子批次。

```text
npm run typecheck   PASS
npm run lint        PASS，0 errors / 34 existing warnings
npm test -- --run   PASS，100 files / 638 tests
npm run build       PASS
```

`PASS / COMPLETE`：Blockly 2.0 frontend/codec已就绪，不扩张为完整语言，进入Phase 7。

### Phase 6 产品可用性纠偏（2026-08-30）

原“22个核心block即完整”的验收结论只证明了架构正交性，没有证明Automation 1.x面向普通用户的功能入口已经等价覆盖。Phase 8在此基础上删除旧Blockly后，造成图片/OCR/坐标等能力虽然仍在Core，却无法从工作台方便使用；分类颜色和flyout收起状态也未纳入真实DOM验收。现将Phase 6的产品完成口径修正如下：

- Core仍坚持Action × Locator，不恢复`click-image/click-text/click-coordinate`旧类型或旧Runtime；
- Blockly扩展为33个通用block（包含唯一入口）；Action目标槽默认留空，由用户插入图片、文字或坐标Locator；
- 入口明确选择“页面视口/游戏区域”，0–10000坐标、图片识别与OCR继承同一Context；
- 恢复键盘、输入文字、滚动、页面打开/刷新、日志/通知、OCR ReadText/ReadNumber等普通用户入口；
- 恢复熟悉的0–10000相对坐标输入，保存时仍编译为Core ratio；
- 真实DOM验收覆盖7类独立颜色、中文分类内容和收起后两层flyout均`display:none/filter:none/width=0`。

## Phase 7 — JavaScript API / Sandbox

- typed `bao.*`protocol、capability map、三层grant、Host Broker和Core service adapter完成。
- Broker负向测试覆盖token、默认deny、payload、protocol、concurrency、cancel drain和grant提权。
- 真实Electron smoke覆盖无Node/Electron/IPC、冻结transport、CSP/session network deny、原生JS控制流、permission error和infinite-loop timeout。
- `sandbox:true`在Electron 11下崩溃；采用并记录`nodeIntegration:false + contextIsolation:true`兼容边界与残余风险。

```text
npm run typecheck                       PASS
npm run lint                            PASS，0 errors / 34 existing warnings
npm test -- --run                       PASS，102 files / 648 tests
npm run build                           PASS
npm run probe:automation-js-sandbox     PASS
```

`PASS / COMPLETE`：JavaScript frontend的API、权限和隔离执行边界完成，进入Phase 8原子cutover。

## Phase 8 — Package / Recorder / Product Cutover

- `.baoauto` v3 round-trip覆盖workflow + scripts + assets + profiles、integrity tamper、unsafe/undeclared path、limits和旧版本拒绝。
- v3 repository覆盖持久化、重载、替换、删除及旧文件不迁移。
- Recorder只输出WorkflowDocumentV3；profile变量覆盖与Surface绑定由同一Core validator/runtime执行。
- 产品只注册v3 IPC；工作台激活Blockly 2.0/JS editor，游戏侧栏显式选择frontend/profile。
- JavaScript install grant保存在包外，导入确认后才授权；Electron 11 contextBridge错误使用data error保留稳定code。
- 旧schema/types/Runtime/Driver/service/package/Blockly/assistant compatibility adapter和对应旧smoke/fixtures删除；页面悬浮助手已重接v3/Core专用IPC。

```text
npm run typecheck                       PASS
npm test -- --run                       PASS，95 files / 541 tests
npm run lint                            PASS，0 errors / 34 existing warnings
npm run build                           PASS
npm run probe:automation-authoring      PASS（真实BrowserView；禁用原生AbortController）
npm run probe:automation-js-sandbox     PASS
npm run test:ruffle                     PASS
git diff --check                        PASS（仅既有LF/CRLF提示）
```

authoring smoke使用真实BrowserView/Core session验证截图、OCR provider调用和Canvas Surface检测，并在`global.AbortController = undefined`的Electron 11环境下运行。Ruffle smoke额外验证悬浮助手存在、可展开、可拖拽，并通过受限`GM_baoAutomation` bridge完成Core包读取、图片识别、OCR、捕获拖框保存、坐标取点和游戏Surface选择。

### Surface CDP租约回归修复（2026-08-30）

`userscript:automation-v3-surfaces`曾绕过TabManager，直接调用`detectGameSurfaces(event.sender)`，因此在密码捕获持有CDP时稳定报`CDP is already leased by password-capture`。现已强制路由到`tabManager.inspectAutomationTarget`，由统一的短时检查屏障按`teardown password capture → Automation inspection → restore password capture`顺序执行。真实Electron探针验证检查前后租约owner均为`password-capture`，检查期间Canvas Surface识别成功；静态回归测试禁止该IPC恢复为直接调用。

`PASS / COMPLETE`：Automation 2.0核心重构与断代完成；Pixel OCR保持Out of Scope。
