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

## OCR 跨平台 Sidecar（2026-08-31）

- Automation Core 的 OCR 依赖改为通用 `AutomationOcrEngine`，工作流、JavaScript API 和测试中心统一从 Provider 工厂取得实例；
- 接入 RapidOCR 3.9.2 + ONNX Runtime 1.29.0 + PP-OCRv6 small，自包含 Sidecar 通过 stdin 直接接收 BGRA 帧，不再写临时 BMP；
- Windows OCR包只携带Paddle baseline，Provider工厂不再选择Rapid；发布校验会拒绝任何混入Rapid目录的Windows成品；
- Sidecar 构建依赖位于 `.cache/ocr/rapidocr-venv-*`，不会写入系统 Python；Windows/Linux 必须各自在目标平台构建；
- Windows x64 冻结二进制 `ready` 自检通过，内存渲染 `TEST 123` 的真实 PP-OCRv6 推理通过；
- 标准包继续不携带OCR；Windows OCR包只携带PaddleOCR-json + PP-OCRv3。该记录后的Linux Paddle正式评估已替换Rapid打包策略，见本页末节。

```text
npm run typecheck                                      PASS
npm test -- --run                                      PASS，101 files / 572 tests
npm run build                                          PASS
RapidOCR protocol/provider/runtime integration         PASS，7 tests
verify source win32-x64 --ocr bundled                  PASS，22 files
verify source win32-x64/linux-x64 --ocr none           PASS，18 / 17 files
targeted ESLint（新增 TypeScript 文件）                 PASS
```

Linux 的 WSL 功能验证见下节。Windows 第一轮 56 张可控语料、3 轮 benchmark 显示 small 与 v3 准确率相同，但 warm p95 约为 728ms 对 31ms，因此 Windows 自动选择已改回 Paddle v3 优先；真实游戏 corpus、tiny 和恢复压力测试仍待执行。

### Windows 中文协议修复（2026-08-31）

首版 Sidecar 使用 `ensure_ascii=False` 将中文直接写入 Python stdout；Windows 冻结进程按活动代码页编码，而 Node 固定按 UTF-8 解码，导致正确 OCR 文本在 IPC 前变成 `���`。协议现改为 ASCII-only JSON Unicode 转义，由 `JSON.parse` 还原中文，与 Windows 代码页完全解耦。使用仓库内 Source Han Sans 渲染“开始游戏 123”的真实模型测试同时断言中文和数字均原样返回。

```text
Windows Sidecar rebuild/self-check                    PASS
真实 PP-OCRv6 中文 + 数字内存帧识别                   PASS
RapidOCR runtime/protocol tests                       PASS，5 tests
verify source win32-x64 --ocr bundled                 PASS，22 files
```

### Linux WSL 功能验证与发布基线（2026-08-31）

验证环境为 WSL2 Ubuntu 26.04 x64、Linux 6.18、Python 3.14.4。Linux onedir Sidecar 原生冻结、自检和真实 BGRA 协议均通过；使用 Source Han Sans 渲染“开始游戏 123”，PP-OCRv6 small 返回“开始游戏”（99.98%）与“123”（99.999%），首次模型推理约 946ms。冻结进程只通过 stdin/stdout 接收帧，不依赖目标机 Python。

该 WSL 发行版的 glibc 为 2.43，PyInstaller 将系统 Python/动态库带入产物；完整 ELF 扫描发现最高要求为 `GLIBC_2.43`，冻结目录约 355MB。因此结论严格拆分为：

- `PASS`：Linux x64 Sidecar 构建、启动、中文识别和二进制协议功能；
- `FAIL（拒绝发布）`：本机 WSL 产物不满足项目 `GLIBC_2.28` 上限，不能代表通用 Linux 包。

`verify-release` 已增加全目录 ELF glibc 扫描，当前诊断产物会明确失败并指出最高版本及文件，防止再次把“本机能运行”误判为跨发行版通过。正式产物需在 manylinux_2_28/等价旧基线容器中冻结，然后重复真实中文测试、源资源校验与 AppImage 验证。

```text
Linux Sidecar native build/self-check                 PASS
真实 PP-OCRv6 中文 + 数字 BGRA 识别                   PASS
verify source linux-x64 --ocr bundled                 FAIL（GLIBC_2.43 > 2.28，预期门禁）
Docker CLI                                            PRESENT
Docker Desktop Linux engine                           NOT RUNNING
```

Docker Desktop 启动后，使用 `Dockerfile.manylinux` 在官方 manylinux_2_28 x86_64 基线上安装共享库 Python 3.11.13并重新冻结。构建过程输出可复用归档，再由受目标路径校验保护的脚本安装到本地 runtime 目录。最终产物在 glibc 2.28 容器和较新的 WSL Ubuntu 中都完成了真实中文推理：

```text
manylinux_2_28 freeze + ready self-check              PASS
容器内真实“开始游戏 123”推理                           PASS，OCR 约 864ms
WSL Ubuntu 26.04真实“开始游戏 123”推理                 PASS，OCR 约 1024ms
全目录 ELF 最高要求                                   GLIBC_2.28
verify source linux-x64 --ocr bundled                 PASS，19 files
冻结目录                                               354MB
```

因此 Linux x64 的功能链路和 glibc 发行基线均已通过；仍未完成的是正式 corpus 的 small/tiny/v3 准确率、warm p95、RSS 与连续1000次稳定性 benchmark，不能把单图冷启动时间当作最终性能指标。

### OCR Headless依赖收口（2026-08-31）

RapidOCR声明依赖完整`opencv-python`，会在Linux OCR包中隐式带入Qt/X11等GUI动态库；Windows headless wheel还包含OCR不用的29.4MB FFmpeg视频解码DLL。构建现统一在依赖解析后替换为锁定的`opencv-python-headless==5.0.0.93`，并删除Windows视频DLL；发布校验拒绝Qt或`opencv_videoio_ffmpeg`重新进入OCR包。

```text
Linux runtime                         353.1MB → 309.1MB（-44.0MB）
Linux gzip archive                    146.8MB → 131.0MB（-15.8MB）
Windows runtime                       247.0MB → 217.1MB（-29.9MB）
Windows真实中文/数字推理              PASS
WSL真实中文/数字推理                  PASS
glibc 2.28容器真实中文/数字推理       PASS
Windows/Linux OCR发布校验             PASS，22 / 19 files
```

该修改不触碰页面图片识别的OpenCV.js worker；只收口OCR Sidecar的构建依赖。

### Linux Paddle PP-OCRv3 PoC（2026-08-31）

使用只读、断网、无 capabilities 的 Python 3.11 Docker 容器直接加载现有 PP-OCRv3 模型。模型路径、中文字典和语料均来自项目现有资源，没有在线下载模型。

```text
Linux Paddle 初始化                                  PASS，约486ms
3张中文冒烟                                          PASS
56张可控语料                                         PASS，56/56
热态 mean / p50 / p95                                约38 / 38 / 55ms
真实像素字“赶走”                                     PASS
真实像素字“收线、拉杆”                               未检出（与Windows模型边界一致）
```

诊断发现 Paddle 2.6.2 wheel 先加载时会与 pyclipper 发生 zlib 符号冲突；PoC 通过预加载 pyclipper绕开。该绕过不会进入最终运行时。正式 Linux Paddle 实现继续走 Paddle Inference C++ Sidecar，并在 glibc 2.28 基线上接受体积、RSS、协议、取消/恢复和1000次稳定性验收。

### Linux Paddle Inference C++正式接入（2026-08-31）

使用官方PaddleOCR release/2.7固定提交与SHA256锁定的Paddle Inference 2.6.2 CPU/MKL库，在manylinux_2_28容器中编译BAO1 Sidecar。Paddle初始化日志永久路由stderr，stdout只保留协议JSON；Electron侧持续消费stderr，避免管道写满造成假死。Linux Provider与正式OCR包均只使用Paddle。

```text
C++ BAO1 ready / UTF-8中文协议                        PASS
56张可控语料                                         PASS，56/56
真实钓鱼像素字                                       “赶走”正确，模型边界与Windows一致
1008次连续请求                                       PASS，mean 67.7ms / p95 158.8ms
峰值RSS                                              约321.9MiB
原生文件系统初始化                                  约350–390ms
解压目录 / gzip归档                                 约404MiB / 120MiB
全目录ELF最高要求                                   GLIBC_2.28
verify source linux-x64 --ocr bundled                PASS，24 files
electron-builder linux-unpacked                      PASS
verify unpacked linux-x64 --ocr bundled              PASS，15 files
成品目录内Sidecar真实中文推理                         PASS
TypeScript三端类型检查                               PASS
Vitest全量                                           PASS，100 files / 571 tests
生产构建                                             PASS
ESLint                                               PASS（0 error，既有34 warning）
```

从Windows DrvFS挂载目录直接启动约2.4秒，复制到容器原生文件系统后约0.35秒；这验证了WSL挂载开销，不应把前者当成AppImage正常启动性能。Paddle自包含目录比headless Rapid目录更大，但AppImage输入归档更小（约120MiB），且推理延迟显著更低。

本轮在Windows宿主直接生成`linux-unpacked`成功，随后创建AppImage时因Windows未获创建Linux图标软链接权限而报`EPERM`。这是宿主文件系统打包限制；unpacked成品及其中OCR资源已通过发布校验和真实推理。最终AppImage应在Linux文件系统/CI中执行electron-builder，不能把该软链接错误归因于OCR。

### Windows Paddle C++ BAO1正式接入（2026-08-31）

使用PaddleOCR-json 1.4.1对应的C++推理源码、Paddle Inference 2.3.2、OpenCV 4.10与现有PP-OCRv3模型构建x64 Sidecar。Windows现在与Linux一样直接接收BAO1 BGRA内存帧；旧`PaddleOCR-json.exe`、临时BMP与`image_path`行协议已退出正式运行时。

```text
56张可控语料文字/数字准确率                         100% / 100%，与旧引擎一致
真实钓鱼素材输出                                   14/14与旧引擎完全一致
旧引擎 warm mean / p50 / p95                       24.8 / 25.0 / 35.1ms
C++ BAO1 warm mean / p50 / p95                     17.6 / 15.5 / 27.8ms
旧引擎 / C++正常cold start                         583 / 565ms
旧引擎 / C++峰值RSS                                233.9 / 234.0MiB
1000次连续BAO1请求                                 PASS，0失败
正常close / 请求中强杀 / 重启恢复                   PASS
PE x64、subsystem 6.0、依赖边界                    PASS
TypeScript三端类型检查                             PASS
Provider、路径、协议与真实runtime定向测试           PASS，9 tests
生产构建 / OCR源资源发布校验                        PASS，21 files
electron-builder win-unpacked                       PASS
verify unpacked win32-x64 --ocr bundled              PASS，13 files
成品目录Sidecar 100次真实请求                        PASS，0失败
```

预编译Sidecar固定SHA-256为`b79b17e29515397ee37b52549d87d0d98ae8862777696b4d583e0d4b2ad9b8a7`。发布准备脚本仍从官方PaddleOCR-json归档取得经过验证的DLL和模型，但只复制DLL，不再复制旧EXE；许可证改为仓库内固定副本，避免构建因额外的raw.githubusercontent.com请求失败。

### 助手OCR区域、候选与耗时修复（2026-08-31）

助手绑定游戏画面后改为直接捕获并识别该ROI，预览与OCR复用同一帧，不再先对完整1280×720逻辑画面识别再过滤。捕获器优先请求固定逻辑像素尺寸，降低窗口化与最大化时由不同原始栅格重采样造成的置信度波动。文本候选先按查询相关度筛选：完全无关的高置信度文字不再冒充最佳候选；相关但未达条件的候选使用黄色框，命中才使用绿色框。助手同时分别展示OCR置信度、文字相关度、截图/位图/OCR/其他耗时。

```text
Automation能力与捕获定向测试                       PASS，13 tests
无关高置信度文字候选回归                           PASS
TypeScript三端类型检查                             PASS
定向ESLint                                         PASS
真实Electron BrowserView取帧与窗口缩放烟测          PASS
Windows C++ BAO1 Sidecar真实集成                    PASS
生产构建及助手3.3.4 hash校验                       PASS
```

### OCR遗留清理与统一（2026-08-31）

生产Provider统一为Windows/Linux Paddle Inference + PP-OCRv3。通用BAO1进程客户端从带有候选实现含义的`RapidOcrSidecarEngine`更名为`Bao1OcrSidecarEngine`；删除Rapid Provider回退、构建入口、专属运行时工具与本地缓存，旧PaddleOCR-json路径/BMP引擎也不再存在于正式源码。Benchmark工具只运行当前Paddle BAO1实现，历史Rapid数据保留在评估文档中。

```text
当前Paddle BAO1 56张基准                            PASS，文字/数字100%，p95 24ms
TypeScript三端类型检查                             PASS
Vitest全量                                         PASS，102 files / 576 tests
ESLint                                             PASS，0 error（既有34 warning）
生产构建                                           PASS
Windows OCR源资源发布校验                          PASS，21 files
Linux OCR源资源发布校验                            PASS，24 files
真实Electron BrowserView/Automation烟测             PASS
```
