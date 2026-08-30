# Automation 2.0 架构审计

> 状态：Approved  
> 当前完成批次：P0-T05 — 审计收口  
> 最后更新：2026-08-30  
> 审计原则：以源码、测试和构建配置为证据；Phase 0 禁止修改产品代码

## 1. 文档目的与边界

本文记录 BaoFlashBrowser Automation 1.x 的可复算现状，为 Automation Core + 多前端的设计提供事实基线。本文不是新架构设计，也不授权实现。

Phase 0 分批完成：

| 批次 | 状态 | 范围 |
|---|---|---|
| P0-T01 | Complete | 源码、集成点、测试、构建、发布和历史文档清单 |
| P0-T02 | Complete | Blockly、JSON、页面助手、包加载四条调用链 |
| P0-T03 | Complete | Step/Block/镜像能力/page-game/Driver/Runtime/OCR/坐标量化 |
| P0-T04 | Complete | 隐式状态、资源所有权、并发、失败和安全契约 |
| P0-T05 | Complete | 审计结论、风险、Phase 1 输入与评审关闭 |

P0-T01 只回答“代码在哪里、由谁承载、跨过哪些进程边界”。详细控制流和最终统计以之后批次为准。

## 2. 审计方法与基线

### 2.1 证据优先级

1. TypeScript/JavaScript/CJS 源码及构建配置。
2. Vitest 和 Electron smoke/probe。
3. 当前用户文档和历史设计文档。
4. README 仅用于发现入口，不作为架构结论的唯一依据。

### 2.2 可复算命令

以下命令均在仓库根目录执行，且不写产品文件：

```powershell
rg --files src tests tools build docs | rg "automation|Automation|ocr|OCR|coordinate|game-surface"
rg -n "automation:|userscript:automation-|GM_baoAutomation|baoAutomation" src tests
rg -n "^export (type |interface |class |function |const )" src/shared/automation src/main/modules/automation
rg -n "new Worker|spawn\(|BrowserView|debugger\.sendCommand" src/main/modules/automation src/main/modules/tabs.ts
git status --short
```

代码规模按文本行数统计，只用于识别审计面，不用来评价设计质量。生成物、依赖目录与二进制不计入源码行数。

### 2.3 工作树基线

审计开始前已存在用户未提交修改：

- `.idea/workspace.xml`
- `src/main/modules/automation/browserview-driver.ts`

Phase 0 不触碰这些修改。P0-T01 新增或修改的内容仅位于 `docs/automation-v2/`。

## 3. 系统边界总览

Automation 1.x 不是单一的 Blockly 模块。它横跨两个 renderer 场景、main process、worker thread、OCR child process、BrowserView 页面进程和本地包存储。

```text
主窗口 Renderer                         BrowserView 页面 Renderer
Blockly / JSON / Test Bench             Automation Assistant userscript
          │                                          │
          ▼                                          ▼
主窗口 preload contextBridge             webview preload / GM_baoAutomation
          │                                          │
          ├── automation:* IPC ───────┐              ├── userscript:automation-* IPC
          │                           │              │
          └───────────────────────────┴──────────────┘
                                      ▼
                              Main process
              Automation IPC / AutomationService / Runner / Driver
                    │               │                 │
                    │               │                 ├── TabManager / BrowserView / CDP
                    │               ├── Vision Worker thread
                    │               └── PaddleOCR-json child process
                    └── .baoauto / installed package / asset folders
```

初步事实：Blockly 是主要创作 UI，但 Automation 的运行入口还包括 JSON 编辑、`.baoauto` 安装/启动和拥有专用授权的页面助手；P0-T02 已逐条验证这些入口到 Driver 的完整调用链。

## 4. 源码清单

### 4.1 Shared：Schema 与跨进程数据

| 文件 | 行数 | 当前职责 | 主要依赖/消费者 |
|---|---:|---|---|
| `src/shared/automation/types.ts` | 537 | Condition、Step、Workflow、Manifest、Capability、消息与坐标相关类型 | main、preload API 类型、renderer、测试 |
| `src/shared/automation/schema.ts` | 592 | Zod schema、解析、包文档校验、Workflow 资产引用遍历 | service、package、Blockly editor、IPC、测试 |
| `src/shared/automation/game-surface-feature.ts` | 46 | 判断 Workflow 是否使用 game surface | service、renderer |
| `src/shared/automation/abort-controller.ts` | 38 | Automation 取消控制器 | service、runtime |

小计：4 个文件，1,213 行，40,202 bytes。

当前事实：类型与校验规则位于同一 shared 子系统，但所有动作、定位方式、控制流、page/game 以及包格式仍围绕 Step/Workflow 聚合。概念镜像和分支数量在 P0-T03 量化。

### 4.2 Main：Runtime、Driver 与能力实现

| 文件 | 行数 | 当前职责 | 关键出口/依赖 |
|---|---:|---|---|
| `runtime.ts` | 761 | XState 生命周期、Step 解释执行、条件、循环、变量与 Driver 协议 | `AutomationDriver`、`AutomationRunner` |
| `browserview-driver.ts` | 840 | 捕获、坐标变换、输入、图像/OCR 查找、导航与通知的 BrowserView 实现 | BrowserView、CDP、Vision matcher、OCR recognizer |
| `service.ts` | 1,087 | 包管理、运行会话、调试、Authoring、资产测试、surface 绑定、历史记录、能力装配 | IPC、TabManager、Runner、Driver、OCR/Vision/package |
| `game-surface-detector.ts` | 604 | 候选视觉区域探测、绑定信息和刷新 | WebContents、CDP lease |
| `vision-worker-matcher.ts` | 407 | OpenCV worker 生命周期、模板缓存、共享缓冲与请求超时 | worker_threads、runtime 图像请求类型 |
| `vision-worker.cjs` | 317 | worker 内 OpenCV 模板匹配 | OpenCV.js、SharedArrayBuffer 协议 |
| `paddle-ocr-engine.ts` | 200 | PaddleOCR-json 进程、临时 BMP、行协议和取消 | child_process、fs/os；反向依赖 Driver frame 类型 |
| `package.ts` | 172 | `.baoauto` ZIP 序列化/加载、能力推断、格式与资产校验 | fflate、schema、assets |
| `assets.ts` | 85 | 资产扫描、目录观察和校验 | fs/path/chokidar |
| `native-image-template-provider.ts` | 37 | 图片资产到 matcher 模板像素 | Electron nativeImage |
| `capture-geometry.ts` | 21 | 预览选区到源图区域换算 | IPC 与页面助手 |

小计：11 个文件，4,531 行，217,809 bytes。

当前边界问题仅作事实登记：

- `AutomationDriver` 协议定义在 `runtime.ts`，使 runtime 同时拥有执行器与底层端口定义。
- `paddle-ocr-engine.ts` 使用 `browserview-driver.ts` 的 `AutomationCapturedFrame` 类型，使 OCR 能力依赖具体 Driver 模块。
- `service.ts` 同时装配运行能力并承担包、资产、authoring、诊断与历史记录等应用服务职责。
- Vision 已有 worker 边界；OCR 已有 child-process 边界；Capture/Input/Coordinate 仍集中在 BrowserView Driver。

### 4.3 Main IPC 与生命周期集成

| 文件 | 行数 | 当前职责 |
|---|---:|---|
| `src/main/ipc/automation.ipc.ts` | 377 | 主工作台 Automation IPC、Zod 校验、文件对话框、状态广播、Service 单例 |
| `src/main/ipc/userscripts.ipc.ts` | 相关区段 | 页面助手授权校验、tab 解析和 `userscript:automation-*` IPC |
| `src/main/index.ts` | 相关区段 | 启动注册 Automation IPC；退出时关闭 AutomationService |
| `src/main/modules/tabs.ts` | 相关区段 | BrowserView 生命周期及 Automation viewport lease/handle |
| `src/main/ipc/tabs.ipc.ts` | 相关区段 | tab 操作与 automation 页面/视图协作入口 |

主工作台 preload 当前允许并暴露 37 个 `automation:*` invoke channel；页面助手链路包含 16 个 `userscript:automation-*` handler。该数字将在 P0-T03 与职责分类一起复核。

### 4.4 Renderer：Blockly 工作台及辅助界面

| 文件 | 行数 | 当前职责 |
|---|---:|---|
| `src/renderer/pages/AutomationPage.tsx` | 403 | Automation 页面外壳、包/工作流状态、Blockly/JSON/测试工作台入口 |
| `src/renderer/components/automation/AutomationBlocklyEditor.tsx` | 669 | Blockly workspace、block 定义、Workflow 双向转换与编辑交互 |
| `AutomationPanel.tsx` | 257 | 运行、调试、状态与日志控制 |
| `AutomationAssetTestBench.tsx` | 151 | 图片资产选取和匹配测试 |
| `AutomationOcrTestBench.tsx` | 91 | OCR 场景测试 |
| `automation-block-schema.ts` | 88 | Blockly block schema 辅助定义 |
| `automation-message.ts` | 108 | 运行消息格式化 |
| `src/renderer/styles/automation.css` | 259 | Automation 页面样式 |

上述主页面/automation component/style 统计口径为 7 个模块组文件，1,769 行，160,435 bytes。另有以下耦合集成点：

- `src/renderer/App.tsx`：惰性加载并路由 `about:automation`。
- `src/renderer/types/electron.d.ts`：声明 `window.electronAPI.automation` 公共接口。
- `src/renderer/hooks/useTabManager.ts`：tab 与 Automation 页面行为协作。
- `src/renderer/services/url-utils.ts`、`tab-session.ts`、`tab-initial-state.ts`、`tab-suspension.ts`：内部页面 URL、恢复与挂起规则。
- `src/renderer/i18n/zh-CN/index.ts`、`en/index.ts` 及生成类型：Automation UI 文案。

### 4.5 Preload 与页面助手前端

| 文件 | 行数 | 当前职责 |
|---|---:|---|
| `src/preload/index.ts` | 相关区段 | 白名单化主窗口 IPC；暴露 `electronAPI.automation` |
| `src/webview-preload/userscripts/gm-api.ts` | 相关区段 | 在获得 `GM_baoAutomation` grant 时暴露受限页面助手 API |
| `src/main/modules/userscripts/bundled-scripts/automation-frame-assistant.user.js` | 431 | BrowserView 页面内的选区、坐标、surface 和识别辅助 UI |

`GM_baoAutomation` 不是通用 userscript 权限。`userscripts.ipc.ts` 同时检查专用 assistant script id、注册视图、启用状态和 grant；这是现有安全边界的一部分，P0-T04 继续审计。

## 5. 进程与资源边界

| 边界 | 创建/持有者 | 通信方式 | 资源/生命周期事实 |
|---|---|---|---|
| 主窗口 renderer → main | preload + `automation.ipc.ts` | `ipcRenderer.invoke` / `ipcMain.handle` | channel 白名单与 Zod 输入校验 |
| BrowserView 页面 → main | GM API + `userscripts.ipc.ts` | `bridge.invoke` / IPC | 专用 grant 和 sender/tab 映射 |
| main → BrowserView | Driver / TabManager | Electron API、`webContents.debugger.sendCommand` | 受 viewport lease 与 BrowserView 生命周期约束 |
| main → Vision worker | `OpenCvWorkerMatcher` | worker_threads + shared buffer/message | worker 可重启；模板缓存最多 64 项（默认） |
| main → OCR sidecar | `PaddleOcrEngine` | stdin/stdout 行协议 + 临时 BMP | `PaddleOCR-json.exe -cpu_threads=4`，支持取消与 close |
| main → package storage | `AutomationService` / package/assets | fs、fflate、chokidar | 安装包、运行历史、链接资产目录 |

这说明未来 Automation Core 的端口至少需要区分应用层入口、BrowserView adapter、Capture、Coordinate、Input、Vision、Text Recognition 和持久化；具体接口不在 Phase 0 决定。

## 6. 包格式与构建/发布清单

### 6.1 当前 `.baoauto`

`src/main/modules/automation/package.ts` 的当前格式事实：

- ZIP 根目录必须包含 `manifest.json` 与 `workflow.json`。
- 图片位于 manifest 指定的 assets 目录。
- manifest 和 workflow 的 `formatVersion` 都必须严格等于 `2`。
- `manifest.id` 必须等于 `workflow.id`。
- Workflow 引用的图片资产必须存在。
- 加载路径名为 `migratePackageDocuments`，但当前实现没有跨版本迁移，只接受版本 2 并补算 capabilities。

因此，产品架构名称“Automation 2.0”与文件格式版本是不同维度。新断代包格式不得继续使用 `formatVersion: 2`；最终版本号由 Phase 1/8 的设计和 ADR 决定。

### 6.2 OCR 发布路径

| 位置 | 事实 |
|---|---|
| `package.json` | Windows x64 分为 standard 与 OCR 构建；OCR 构建先运行 `prepare:ocr` |
| `build/prepare-ocr-runtime.cjs` | 下载/准备 PaddleOCR-json 与模型到 `native/ocr/win64` |
| `build/electron-builder.config.cjs` | `BAO_OCR_BUNDLE=1` 时把 OCR runtime 加入 `extraResources/native/ocr` |
| `build/verify-release.cjs` | 校验 OCR exe 架构、LICENSE、模型文件和 standard 包不含 OCR |
| `paddle-ocr-engine.ts` | 开发态读取 `native/ocr/win64`；打包态读取 `resources/native/ocr` |

当前本地 OCR 目录约 262,586,584 bytes（约 250.4 MiB），基线为 PaddleOCR-json 1.4.1 + PP-OCRv3。RapidOCR/ONNX Runtime 与 PP-OCRv6 small/tiny 是 Phase 4 benchmark 候选，不属于 Phase 0 实现范围。

### 6.3 Automation 专用脚本和 smoke 入口

`package.json` 提供以下相关入口：

- `probe:automation-input`
- `probe:automation-viewport`
- `probe:automation-viewport-engines`
- `probe:automation-visual`
- `probe:automation-blockly`
- `probe:automation-flash`
- `probe:automation-workbench`
- `probe:automation-m2`
- `probe:automation-m4`
- `probe:automation-m5-engines`
- `demo:automation`

部分 Electron smoke 需要先运行自己的 build script；仅运行普通 `npm run build` 不会刷新 `release/tests/` 产物。

## 7. 测试与验证资产清单

按文件名和目录职责识别的 Automation 专项测试共 26 个文件、约 4,154 行；当前用于源码聚合的 glob 捕获 25 个文件、4,109 行，差异来自一个间接命名的相关测试。最终数量在 P0-T03 以固定清单重新计算，避免模糊 glob。

覆盖面包括：

- Workflow schema、包和依赖兼容性。
- Runtime Step 行为、取消、条件、循环和失败。
- BrowserView Driver 坐标、输入、捕获、视觉/OCR 行为。
- Service 会话、资产和历史记录。
- Vision worker、模板缓存和匹配。
- game surface 探测与 viewport。
- Blockly 工作台、主窗口页面和 Ruffle/Flash Electron smoke。
- 页面助手 GM grant 与 userscript admin smoke。

已知基线（审计开始前执行）：

- Vitest：84 files / 558 tests passed。
- `npm run probe`：6 个 probe 中 3 pass、3 fail；失败分别来自陈旧 smoke bundle、本机缺少 config、本机缺少 main.log，不作为 Automation 产品逻辑失败。

P0-T01 是文档批次，不重新运行 Electron smoke。后续涉及运行时事实的批次必须记录所运行命令、平台和构建新鲜度。

## 8. 文档与历史设计清单

### 8.1 当前用户/模块文档

| 文档 | 行数 | 角色 |
|---|---:|---|
| `docs/automation-blockly-beginner-guide.md` | 975 | Blockly 用户教程 |
| `docs/automation-user-guide.md` | 269 | Automation 用户指南与包使用 |
| `docs/modules/03-automation.md` | 93 | 模块级架构摘要 |
| `docs/modules/00-overview.md` | 相关区段 | 全局模块入口 |
| `docs/modules/01-browser-shell-tabs.md` | 相关区段 | BrowserView/tab 边界 |
| `docs/modules/07-screenshots.md` | 相关区段 | 截图能力边界 |

### 8.2 已冻结的旧提案

以下提案描述了真实痛点，但仍以旧 Step、Runtime switch 与兼容迁移为设计边界，不能直接驱动 Automation 2.0 实现：

- `docs/superpowers/specs/2026-08-29-recognition-target-unification-design.md`
- `docs/superpowers/specs/2026-08-29-text-target-in-pointer-blocks-design.md`
- `docs/superpowers/specs/2026-08-29-automation-continue-on-image-timeout-design.md`

P0-T02～P0-T05 会提取其中仍可复用的问题描述，但 Action、Locator、Context、错误语义和兼容策略由 Phase 1 重新设计。

## 9. P0-T01 事实结论

1. Automation 当前已经有多个入口，但没有独立于 Workflow Step 的 Automation Core 模型。
2. `AutomationService` 是主应用服务和装配中心；`AutomationRunner` 解释 Step；`BrowserViewAutomationDriver` 集中了多种底层能力。
3. Vision 与 OCR 已跨出独立执行边界，但其类型和 Frame 所有权仍与 Driver/Service 耦合。
4. page/game、surface、viewport lease 与 BrowserView 生命周期横跨 shared、service、driver、detector、tabs 和 renderer，不是单文件重构问题。
5. 包、authoring、运行、调试、识别测试和页面助手共享同一 Service，却通过两套 IPC 前端进入。
6. 现有测试面较广，可以作为重构保护网；但必须先建立稳定的能力/契约映射，不能只按旧 Step 测试迁移。

## 10. P0-T02 执行契约（已完成）

P0-T02 必须基于本清单画出并逐节点引用源码：

1. Blockly 编辑、保存、启动、执行链。
2. JSON 编辑、校验、保存、启动、执行链。
3. BrowserView 页面助手识别/选区/启动链。
4. `.baoauto` 打开、安装、加载、资产解析、启动链。

同时必须给出要求的主干图：

```text
Blockly
  ↓
Workflow Schema
  ↓
Runtime
  ↓
Driver
  ↓
Vision / OCR / Input
```

本批按上述契约记录入口、IPC、校验、状态所有者、资源所有者、取消路径、错误出口和测试证据；仍未进入新 Core 设计。

## 11. P0-T02 调用链审计方法

本批从用户可触发入口向下追踪，不用目录结构代替调用关系。每条链按以下问题记录：

1. 谁生成或选择 Workflow？
2. 在哪里做语法/语义校验？
3. 保存的是草稿、内存对象还是安装包？
4. 谁持有运行会话、BrowserView、Frame、Vision/OCR 和取消信号？
5. 错误是同步返回、IPC reject、状态事件还是轮询可见？
6. 哪些测试直接或间接保护这条链？

源码行号是 2026-08-30 工作树快照中的审计定位点；以后代码移动时，以符号名为稳定检索依据。

## 12. 共同运行主干

四个入口最终共享同一个已安装 `LoadedEntry`、`AutomationService`、`AutomationRunner` 和 `BrowserViewAutomationDriver`。要求的主干图如下：

```text
Blockly Blocks
  │  AutomationBlocklyEditor.compile()
  ▼
Workflow Schema ──────────────────────────────────────────────┐
  │  automationWorkflowSchema / parseAutomationWorkflow      │
  ▼                                                          │
Installed .baoauto / AutomationService package map            │
  │  start(packageId, tabId)                                  │
  ├── prepareWorkflowGameSurface()                             │
  ├── TabManager.beginAutomation() → AutomationTabHandle       │
  ├── acquire Vision matcher（按 capability）                  │
  ├── create BrowserViewAutomationDriver                       │
  └── create AutomationRunner                                  │
                       │                                       │
                       ▼                                       │
                  Runtime.execute(step)                        │
                       │                                       │
                       ▼                                       │
                AutomationDriver protocol                      │
             ┌─────────┼──────────┬──────────┐                 │
             ▼         ▼          ▼          ▼                 │
           Vision     OCR       Input     Browser/Nav           │
        worker thread sidecar   CDP        BrowserView          │
             └─────────┴──────────┴──────────┘                 │
                       │                                       │
                       ▼                                       │
              logical → display transform                     │
                       │                                       │
                       ▼                                       │
                    BrowserView                                │
```

JSON editor 和 `.baoauto` 入口从 Workflow Schema/installed package 汇入；页面助手不生成 Workflow，而是选择同一 package map 中的脚本并直接调用 `start`。

### 12.1 Service 到 Runtime

| 顺序 | 调用与证据 | 事实 |
|---:|---|---|
| 1 | `AutomationService.start`，`service.ts:458` | 检查 feature、解析 packageId、准备 workflow game surface |
| 2 | `ensureSession`，`service.ts:638` | 强制全局单 active session；检查 OCR edition capability |
| 3 | `TabManager.beginAutomation`，`tabs.ts:126` | 只允许活动且存活的 BrowserView；创建 viewport lease |
| 4 | `acquireRuntimeMatcher`，`service.ts:658` | 只有 capability 包含 vision 才取得 OpenCV matcher |
| 5 | `createDriver`，`service.ts:778` | 注入 viewport、surface refresh、OCR 和 current-target guard |
| 6 | `new AutomationRunner`，`service.ts:662` | Runner 构造时再次 `parseAutomationWorkflow` |
| 7 | `runner.run`，`service.ts:466` | readiness、countdown、root sequence、完成/失败/取消 |
| 8 | `disposeSession`，`service.ts:1070` | release BrowserView lease；Vision matcher 进入短时 idle cache |

### 12.2 Runtime 到能力实现

`AutomationDriver` 定义在 `runtime.ts:75`。`AutomationRunner.execute` 从 `runtime.ts:513` 开始，并在 `runtime.ts:522` 对 Step type 分派：

- 图像条件/动作调用 `findImage`，再视动作调用 `click`、`moveTo` 或 `drag`。
- 文字条件/动作调用 `findText`，`click-text` 再调用同一个 `click`。
- 坐标动作绕过识别，调用 `clickPoint`、`moveToPoint` 或混合 `dragTargets`。
- 键盘、文本和滚轮调用 Driver Input 方法。
- navigate/reload 调用 Driver Browser 方法。
- sequence、if、wait、loop、break、region 和 coordinate-space 留在 Runtime 内解释。

`BrowserViewAutomationDriver` 的能力落点：

| 能力 | 入口 | 最终落点 |
|---|---|---|
| Capture | `findImage` / `findText`，`browserview-driver.ts:268/371` | `webContents.capturePage`；capturer count 包围资源 |
| Vision | `findImage` | `OpenCvWorkerMatcher` → worker_threads/OpenCV.js |
| OCR | `findText` | 注入的 `PaddleOcrEngine.recognize` → PaddleOCR-json child process |
| Pointer | `click/move/drag/clickPoint` | 短时 CDP lease → `Input.dispatchMouseEvent` |
| Keyboard/Text | `keyDown/keyUp/typeText` | 短时 CDP lease → `Input.dispatchKeyEvent` / `Input.insertText` |
| Navigation | `navigate/reload` | `webContents.loadURL/reload`，要求 debugger 未被占用 |
| Coordinate | `relativePointToLogical` → `logicalPointToDisplay` | page/game surface → logical viewport → live display transform |

## 13. 调用链 A：Blockly 编辑、保存与运行

### 13.1 编辑与草稿

```text
about:automation
  ↓
AutomationPage loads selected package via automation:get-package
  ↓
AutomationBlocklyEditor.loadIntoWorkspace(workflow)
  ↓
Blockly workspace edits
  ├── localStorage baoauto:draft:<packageId>（每次非 UI change）
  └── AutomationPage dirty=true
```

证据节点：

| 节点 | 位置 | 行为 |
|---|---|---|
| 页面入口 | `App.tsx:24,181,281` | `about:automation` 惰性加载 `AutomationPage` |
| 包读取 | `AutomationPage.tsx:63-69` | `getPackage` 后设置 Workflow、assets 与 JSON 文本 |
| Workflow → Blocks | `AutomationBlocklyEditor.tsx:655-665` | 创建唯一 start block，并递归创建 Step/Condition blocks |
| 草稿恢复 | `AutomationBlocklyEditor.tsx:588-592` | packageId 作为 localStorage draft key；草稿优先覆盖 workspace |
| 草稿写入 | `AutomationBlocklyEditor.tsx:593-604` | 非 UI/FINISHED_LOADING 事件序列化 Blockly XML |

草稿不是 `.baoauto`，也不进入 Service package map。它属于主窗口 renderer 的 localStorage；正式保存成功才清除。

### 13.2 Blocks → Workflow → 持久化

```text
Save / Ctrl+S
  ↓
AutomationPage.saveBlocks()
  ↓
AutomationBlocklyEditor.compile()
  ↓
AutomationWorkflow object (formatVersion 2)
  ↓
preload automation.validateWorkflow()
  ↓ automation:validate-workflow IPC
automationWorkflowSchema.safeParse()
  ↓
preload automation.updateWorkflow()
  ↓ automation:update-workflow IPC
AutomationService.updateWorkflow()
  ↓ parseAutomationWorkflow + serialize preflight
persistEntry()
  ↓
<userData>/automation/packages/<id>.baoauto
```

关键契约：

- `compile` 要求恰好一个 start block（`AutomationBlocklyEditor.tsx:617-620`）。
- game entry 或 game coordinate scope 必须同时具有可解码 game-surface feature（`:628-633`）。
- compile 固定产生 `formatVersion: 2`，并把 blocks 递归转换为 `SequenceStep`（`:634-645`）。
- 页面先通过 IPC `automationWorkflowSchema.safeParse`（`automation.ipc.ts:82-86`）。
- Service 不信任 renderer 的已校验结果，重新 `parseAutomationWorkflow`，再尝试完整 package serialize 以验证资产引用（`service.ts:334-344`）。
- `persistEntry` 使用 temp + backup + rename；失败时恢复内存 Workflow/Manifest 和磁盘原文件（`service.ts:922-943`）。
- 保存成功关闭该 package 的 runtime matcher，防止模板/Workflow 资源继续沿用旧版本（`service.ts:345`）。

### 13.3 运行不是编辑器的直接下游

Blockly 页面只保存。实际运行入口位于 `AutomationPanel`：

```text
AutomationPanel selects installed package + active web tab
  ↓
automation:start(packageId, tabId, countdownMs)
  ↓
AutomationService.start()
  ↓
共同运行主干
```

`AutomationPanel.tsx:71-76` 调用 check/start，`:97-107` 调试启动/继续，`:253` 调用 cancel。运行读取 Service 中最后一次成功持久化的 Workflow，不会隐式编译 AutomationPage 当前未保存的 Blockly workspace。

因此当前存在明确的双状态：renderer Blockly draft 与 Service installed package。用户必须保存后再到目标 BrowserView 运行，否则执行的是上一次保存版本。

## 14. 调用链 B：JSON 编辑、校验与运行

JSON 模式不是独立 DSL，也不拥有独立 Runtime；它直接编辑同一个 `AutomationWorkflow` JSON。

### 14.1 Blocks → JSON

`showJsonEditor` 先调用当前 Blockly `compile`，再 `JSON.stringify`（`AutomationPage.tsx:208-214`）。这一步只更新 renderer state，不持久化。

### 14.2 JSON → Blocks（未保存切换）

```text
JSON textarea dirty
  ↓ switch to Blocks
JSON.parse
  ↓ automation:validate-workflow IPC
automationWorkflowSchema.safeParse
  ↓
setWorkflow + editor.load(validated workflow)
  ↓
dirty=true（仍未持久化）
```

证据为 `AutomationPage.tsx:217-230`。失败停留在 JSON 页面并把 parse/schema error 写入 notice。

### 14.3 JSON Apply/Save → 持久化

```text
Apply JSON / Ctrl+S while jsonDirty
  ↓
JSON.parse(json)
  ↓ automation:validate-workflow
schema.safeParse
  ↓ automation:update-workflow
AutomationService.updateWorkflow
  ↓
installed .baoauto
  ↓
editor.load(saved) + clear Blockly draft
```

证据为 `AutomationPage.tsx:276-290`。`applyJson` 与 `saveBlocks` 共享同一 main-process 更新路径，因此 schema、资产存在性、运行中禁止更新和原子持久化规则相同。

### 14.4 JSON 特有错误出口

| 失败 | 发生位置 | 可见结果 |
|---|---|---|
| 非法 JSON | renderer `JSON.parse` | catch 后写页面 notice，不发 IPC |
| Schema 不合法 | `automation:validate-workflow` | 返回 `{valid:false, issues}`；页面拼接 path/message |
| 资产引用缺失 | Service serialize preflight | IPC reject；页面 notice |
| 正在运行/测试 | `AutomationService.updateWorkflow` | 拒绝更新当前运行 package |
| 磁盘写入失败 | `persistEntry` | 恢复内存对象和磁盘 backup，再通过 IPC reject |

运行链与 Blockly 完全相同：JSON 保存到 installed package 后，由 AutomationPanel 或页面助手调用 `start`。

## 15. 调用链 C：BrowserView 页面助手

页面助手是注入目标页面的 userscript frontend，覆盖 package 选择、运行状态、图片/OCR 测试、素材捕获、坐标拾取和 game surface 绑定；它不编辑 Workflow。

### 15.1 注入与授权边界

```text
built-in automation-frame-assistant.user.js
  │ @grant GM_baoAutomation
  ▼
webview preload grantGmApi()
  │ only when explicit grant exists
  ▼
GM.baoAutomation methods
  │ bridge.invoke userscript:automation-*
  ▼
userscripts.ipc.ts
  │ assistant script id + registered sender + enabled + grant + tab mapping
  ▼
shared AutomationService singleton
```

证据：

- userscript 声明 grant 并在缺失 API 时直接退出（`automation-frame-assistant.user.js:14,24-26`）。
- preload 仅在 grants 包含 `GM_baoAutomation` 时暴露现代 API（`gm-api.ts:122`）。
- main 侧 `automationGrant` 同时检查固定 assistant id、sender registration、安装/启用状态和 metadata grant（`userscripts.ipc.ts:31-35`）。
- 需要目标页面的操作还用 `event.sender.id` 反查 tabId；错误统一为 `automation assistant access denied`。

### 15.2 页面助手启动链

```text
assistant refreshPackages()
  ↓ GM.baoAutomation.listPackages()
userscript:automation-list
  ↓ AutomationService.listPackages()
用户点击启动
  ↓ GM.baoAutomation.start(packageId, 0)
userscript:automation-start
  ↓ sender → tabId + grant + service status guard
void AutomationService.start(packageId, senderTabId)
  ↓
共同运行主干
```

助手 UI 在 `automation-frame-assistant.user.js:384-385` 启动/停止，并每 600ms 轮询 status（`:186,430`）。IPC 启动 handler 位于 `userscripts.ipc.ts:152-160`。

这里存在与主窗口不同的异步错误语义：handler 在完成授权和忙碌检查后以 fire-and-forget 方式调用 `service.start(...).catch(() => {})`，立即返回 `{started:true}`。随后发生的 surface timeout、Driver 或 Runtime 错误不会 reject 最初的 start 调用，而是由 Service 写入共享 status/log，再被助手轮询看到。主窗口 `automation:start` 则直接返回 `service.start` Promise。

`userscript:automation-cancel` 调用全局 `AutomationService.cancel`，没有把取消限定为发起该 run 的 tab；权限仍限定为专用助手。

### 15.3 图片/OCR 测试链

```text
助手 compare image/text
  ↓ optional bound game-surface CSS region
userscript:automation-match / automation-ocr-test
  ↓
AutomationService.captureReferenceFrame(retainViewport=true, cssRegion?)
  ↓ BrowserView native capture
  ├── image: testAssetOnImage → cached OpenCV matcher
  └── text:  testTextOnImage → PaddleOCR engine
  ↓
preview data URL + candidates/timing → assistant overlay
```

图片链位于 `userscripts.ipc.ts:59-90`，OCR 链位于 `:93-143`。两者各自发起 capture；它们不复用 Runtime Driver 的 scoped frame。提供 bound surface 时按 live CSS region 原生裁剪；否则缩放到固定 1280×720 logical canvas。

### 15.4 素材捕获链

```text
assistant captureFrame()
  ↓ captureReferenceFrame(retainViewport=true)
  ↓ normalize to 1280×720
main assistantCaptures[token]（2 分钟，最多 3 项）
  ↓ data URL preview
页面 overlay 框选 preview rect
  ↓ saveCapture(token, rect, name, overwrite)
previewRectToSource → crop → logical normalization
  ↓ AutomationService.importAssets
persist installed .baoauto
```

临时 capture 由 `registerUserscriptsIPC` 闭包的 `assistantCaptures` Map 持有（`userscripts.ipc.ts:37-42`）；生成在 `:196-211`，消费在 `:266-286`。renderer 页面只持有 token、preview 和 selection；成功保存后 main 删除 token。

### 15.5 坐标与 game surface 链

- `detectGameSurfaces` 调用 Service 探测并缓存 candidates；`bindGameSurface` 只能绑定最近一次探测中的 candidate id。
- binding 由 Service 以 `tabId → {webContentsId, fingerprint, candidate}` 持有；WebContents 变化会使旧 binding 失效。
- `beginCoordinatePick` 创建/复用 1280×720 authoring viewport lease；页面 overlay 把 client point 相对 page 或 bound surface 换成 0–10000 坐标并复制文本。
- `endCoordinatePick` 或 pagehide 释放 authoring viewport；Service 另有 5 分钟 idle release。
- 助手复制的是 game-surface feature string，用户再把它导入 Blockly entry；binding 本身不会自动写入 Workflow。

证据分别位于 `userscripts.ipc.ts:214-263`、`service.ts:139-235`、`automation-frame-assistant.user.js:285-372,421-428`。

## 16. 调用链 D：`.baoauto` 打开、安装、加载与运行

### 16.1 交互式导入分为 Preview 与 Commit

```text
AutomationPage / AutomationPanel: openPackage()
  ↓ automation:open-package IPC
native file dialog (.zip/.baoauto)
  ↓ size ≤ 32 MiB compressed
loadAutomationPackage(bytes)
  ├── safe archive paths
  ├── ≤ 1200 files
  ├── ≤ 64 MiB uncompressed
  ├── manifest.json + workflow.json
  ├── formatVersion === 2
  ├── manifest.id === workflow.id
  ├── image-only assets
  └── all referenced assets exist
  ↓
pendingPackageImports[token]（2 分钟，最多 3 项）
  ↓ preview metadata / user confirms replacement
automation:install-package(token, replace)
  ↓
AutomationService.loadPackage(bytes, replace)
  ↓ validate again + persistEntry + package map replace
```

证据：`automation.ipc.ts:88-135`、`package.ts:71-77,117-146`、`service.ts:354-367`。

Preview token 防止 renderer 直接提交任意路径或任意 bytes，但 Service 在 commit 时再次 `loadAutomationPackage`，不是复用 renderer 可篡改的 preview metadata。替换正在运行或测试中的同 id package 会被拒绝；成功替换会关闭 image test session 和 runtime matcher。

### 16.2 安装包持久化与启动恢复

- storage root 在 `registerAutomationIPC` 创建 Service 时固定为 `<userData>/automation/packages`（`automation.ipc.ts:28-34`）。
- 每个安装项以 `<manifest.id>.baoauto` 保存（`service.ts:917-919`）。
- 普通覆盖使用 `.tmp` 与 `.bak` 原子替换/回滚策略（`service.ts:922-943`）。
- Service 初始化会清理/恢复残留 backup/tmp，扫描 `.baoauto`，重新调用 `loadAutomationPackage`，并要求文件名等于 manifest id（`service.ts:888-914`）。
- 无效安装包只记录 warning 并跳过，不阻止 Service 加载其他包。

### 16.3 包选择到运行

安装完成后，AutomationPage/Panel/助手通过 `listPackages/getPackage` 访问 Service 内存 map。运行时只传 `packageId + tabId + countdownMs`，不会再次从 renderer 传 Workflow；`ensureSession` 从 package map 取得受信的 parsed Workflow，并建立共同运行主干。

因此 `.baoauto` 是当前运行的权威 Workflow 来源，Blockly localStorage 和未 Apply 的 JSON 都不是。

## 17. 状态、资源与所有权矩阵

| 状态/资源 | 当前所有者 | 创建 | 释放/失效 |
|---|---|---|---|
| Blockly workspace | `AutomationBlocklyEditor` | component inject | unmount/dispose |
| Blockly draft XML | renderer localStorage | workspace change | successful save/JSON apply；或坏草稿自清理 |
| JSON text/dirty | `AutomationPage` React state | package load / tab switch | successful apply or package change |
| Installed package map | `AutomationService.packages` | startup scan/import/create | delete/shutdown process |
| Package import preview | `automation.ipc` closure Map | open-package | install、2 分钟、容量淘汰 |
| Active run | `AutomationService.active` | `ensureSession` | `disposeSession` finally |
| Runtime state/cancel controller | `AutomationRunner` | run/checkReady | run finally/cancel |
| BrowserView viewport lease | `TabManager.automationTargets` | beginAutomation | handle.release；target change causes guard failure |
| Authoring viewport | `AutomationService.authoringViewport` | coordinate/capture warm | explicit end、失败、tab transfer、5 分钟 |
| Bound game surface | `AutomationService.boundGameSurfaces` | assistant bind/workflow locate | clear、WebContents change、reacquire failure |
| Runtime Vision matcher | Service + `OpenCvWorkerMatcher` | capability-driven session | 30 秒 idle cache 后 close；package update closes |
| Condition-scoped frame | `BrowserViewAutomationDriver.scopedFrames` | `withFreshFrame` | operation scope ends |
| Driver last frame | `BrowserViewAutomationDriver.lastFrame` | image/text capture | navigation/reload/next frame；Driver disposal |
| OCR child process | singleton `PaddleOcrEngine` in Service | first recognize | Service shutdown/process failure |
| Assistant capture | `userscripts.ipc` closure Map | capture-frame | save、2 分钟、容量淘汰 |
| Status/log/history | `AutomationService` | Runtime events | status overwritten；history bounded/persisted |

该矩阵只记录现状。Frame、Context、Surface 和 capability 的新所有权由 Phase 1 设计。

## 18. 取消、错误和完成传播

```text
UI / Assistant cancel
  ↓
AutomationService.cancel()
  ├── probe.controller.abort()，或
  └── active.runner.cancel()
           ↓ AbortController.abort + release step permit
Runtime/Driver loops observe AbortSignal
           ↓
Runner state = cancelled
           ↓ Runtime event
Service status/log/history
           ↓
main window push event / assistant polling
           ↓
Service finally disposeSession → BrowserView lease release
```

| 场景 | 传播方式 | 资源清理 |
|---|---|---|
| 主窗口 start 失败 | IPC Promise reject + Service failed status/log/history | `start` finally dispose session |
| 页面助手 start 后失败 | 初始 IPC 已返回；通过轮询 status 看见 | fire-and-forget Promise finally 仍 dispose |
| 用户 cancel | Service 设置 cancelled；Runtime signal 中止 | Runner finally + Service dispose |
| target tab 被切换/销毁 | `AutomationTabHandle.assertCurrent` 抛错 | Service 记录 failed 并 release |
| navigation 时 debugger 被占用 | Driver 同步 guard 抛错 | Service failed + dispose |
| OCR edition 不可用 | `ensureSession` 在 lease 前拒绝 | 无 active session/lease |
| game surface 定位超时 | `prepareWorkflowGameSurface` 在 session 前失败 | 没有运行 lease；可能保留/更新 binding 状态 |
| Step timeout/budget/depth | Runtime 抛错并进入 failed | Service status/history + dispose |
| held key wait 被取消/失败 | Runtime finally 使用独立 signal 发 keyUp | 然后继续原错误传播 |
| drag 中途失败 | Driver finally 尝试 mouseReleased | 然后继续原错误传播 |

## 19. P0-T02 测试证据与空白

| 链路 | 直接证据 | 当前空白 |
|---|---|---|
| Blockly codec/UI | `automation-block-schema.test.ts`、`automation-blockly-field.test.ts`、`automation-m0-blockly-smoke.cjs`、`automation-m1/m4-workbench-smoke.cjs` | 没有看到覆盖所有 Block ↔ Step 往返的独立 codec 测试 |
| JSON/schema | `automation-schema.test.ts` | AutomationPage JSON/Blocks dirty-state 切换主要依赖 UI smoke，缺少组件级错误路径测试 |
| Package | `automation-assets-package.test.ts`、`automation-service.test.ts`、`automation-dependencies.test.ts` | interactive preview token/replace/expiry 的专用测试未在现有清单中发现 |
| Runtime | `automation-runtime.test.ts` | 保护旧 Step switch 行为，不证明未来 Action × Locator 扩展约束 |
| Driver/坐标/Input | `automation-browserview-driver.test.ts`、m0 input/visual/viewport/Flash、m5 Ruffle smoke | 现有测试把多项能力集中通过 Driver 验证 |
| 页面助手 | `gm-api-grants.test.ts`、`userscripts-admin-smoke.cjs` | main 侧专用 grant + sender/tab 拒绝矩阵和 fire-and-forget 失败传播缺少聚焦测试 |
| Surface | `automation-game-surface-detector.test.ts`、`automation-game-surface-smoke.ts` | workflow locator、临时 binding、authoring lease 三者的端到端所有权仍分散 |

P0-T02 没有新增或修改测试，因为 Phase 0 禁止产品代码变更。本表用于 Phase 1 设计验证策略与后续 Phase 的回归计划。

## 20. P0-T02 事实结论

1. Blockly 与 JSON 是同一 Workflow Schema 的两个编辑前端；它们没有独立 Runtime。
2. 页面助手是第三个前端，但目前同时承担运行控制、识别测试、capture、coordinate 和 surface authoring。
3. `.baoauto` installed package 是运行的权威数据；草稿和未保存 JSON 不参与执行。
4. 四个入口最终共享一个 main-process `AutomationService` 单例和一个全局 active session。
5. Service 在 frontend 校验之后仍会重验 Workflow/package，运行构造时 Runner 再解析 Workflow，形成多层不信任边界。
6. Runtime 控制流与 Driver capability protocol 同文件；Driver 再集中落地 Capture/Coordinate/Vision/OCR/Input/Browser。
7. 页面助手与主窗口的启动错误语义不相同：一个轮询终态，一个直接等待 start Promise。
8. BrowserView lease、authoring lease、surface binding、condition frame、last frame、matcher cache 和 OCR process 各有不同所有者与生命周期。

## 21. P0-T03 执行契约（已完成）

P0-T03 基于已经确认的调用链做固定口径量化：

- Step Type、Condition Type、Block Type。
- Image/Text/Coordinate 动作与条件的镜像矩阵。
- page/game 分支出现位置和作用域恢复路径。
- Driver 方法与职责分类。
- Runtime/Service/schema switch cases。
- OCR/Vision capture、匹配、测试和预览重复逻辑。
- 从 normalized coordinate / match / OCR box 到 BrowserView/CDP 的全部 conversion path。

本批只统计并解释现状，没有提出 TypeScript Core interface；后者仍属于 Phase 1。

## 22. P0-T03 统计口径

统计以 discriminated union、Blockly JSON block definition、具体 switch 和实际调用点为单位：

- Step Type：`AutomationStep` union 中的成员，不把 union 名自身计入。
- Condition Type：`AutomationCondition` union 成员。
- Block Type：`buildBlockDefinitions` 返回数组中行首的 `bao_*` block definition；不把 input/field 类型计入。
- switch cases：指定 `switch (step.type)` 花括号内的 `case` label；合并 case 仍逐 label 计数。
- page/game branch：Automation 源码中对 coordinate space 字符串的显式 `===/!== 'page'/'game'` 条件；排除 CDP target type 的 `'page'`。
- Capture/OCR 重复：独立源码调用点和独立预处理/后处理实现，不把循环运行次数当作源码数量。

可复算的核心命令：

```powershell
rg -n "^export type AutomationStep =|^export type AutomationCondition =" src/shared/automation/types.ts
rg -n "^\s*\{ type: 'bao_" src/renderer/components/automation/AutomationBlocklyEditor.tsx
rg -n "switch \(step\.type\)|case '" src/main/modules/automation/runtime.ts src/main/modules/automation/service.ts src/shared/automation/schema.ts
rg -n "=== 'game'|!== 'game'|=== 'page'|!== 'page'" src/shared/automation src/main/modules/automation src/renderer/components/automation
rg -n "\.capturePage\(|\.recognize\(" src/main/modules/automation src/main/ipc/automation.ipc.ts src/main/ipc/userscripts.ipc.ts
```

## 23. 总量结果

| 项目 | 数量 | 权威位置/说明 |
|---|---:|---|
| Automation Step Type | 34 | `types.ts:408-442` |
| Automation Condition Type | 6 | image、text、all、any、not、position-relation |
| Blockly Block Type | 43 | 5 个 entry + 31 个 statement/action/control + 6 个 condition + 1 个 position statement，按定义数组统计 |
| Runtime `step.type` case | 34 | `runtime.ts:522-741`，覆盖全部 Step |
| Service `describeStep` case | 34 | `service.ts:1032-1067`，再次枚举全部 Step |
| Schema asset traversal case label | 33 | `schema.ts:528-587`；`break` 不进入 switch，因为无资产/子节点 |
| Condition evaluator leaf/compound kind | 6 | Runtime 用 if-chain 而非 switch |
| Automation Driver protocol 方法 | 23 | `runtime.ts:75-116` |
| 主工作台 invoke channel | 37 | `preload/index.ts` 白名单与 API；另有 1 个 `automation:status-changed` push event |
| 页面助手 handler | 16 | `userscript:automation-*` |
| Automation 命名测试文件 | 26 | root Vitest 14 + Electron/probe/build 12 |
| Automation 命名测试行数 | 4,154 | 固定文件清单逐文件文本行数 |
| page/game 显式条件点 | 10 | 详见 §26；不含 CDP target type `page` |
| Automation 范围直接 `capturePage` 调用点 | 4 | Driver 2 + Service 2 |
| OCR engine `recognize` 调用点 | 2 | Runtime Driver 1 + Service test path 1 |

### 23.1 34 个 Step Type

```text
sequence
delay
wait-image
wait-image-state
click-image
click-coordinate
wait-text-state
click-text
random-click-region
vision-region
coordinate-space
key-press
key-hold-until-image
move-to-image
move-to-coordinate
drag-image
drag
text-input
scroll
navigate
reload
log
notification
if-image
if-condition
wait-condition
wait-condition-branch
end
repeat
forever
break
repeat-until-image
repeat-until-condition
position-compare
```

### 23.2 43 个 Blockly Block Type 的构成

| 类别 | 数量 | Block |
|---|---:|---|
| Entry | 5 | unconditional、game、region、image readiness、combined-condition readiness |
| Recognition/context | 6 | wait image、wait image state、wait text state、vision region、coordinate page、coordinate game |
| Pointer/Input | 11 | click target、click text、move target、drag target、delay、key、key combo、hold-key-until-image、text input、scroll、random click region |
| Browser/output | 4 | navigate、reload、log、notification |
| Branch/condition | 9 | if-image、if-condition、image/text/and/or/not/position condition、position-compare statement |
| Wait/control/loop/end | 8 | wait condition、wait condition branch、repeat、forever、break、repeat-until-image、repeat-until-condition、end |

精确求和是 `5 entry + 6 recognition/context + 11 pointer/input + 4 browser/output + 9 branch/condition + 8 control = 43`。

Blockly 数量与 Step 数量不是一一映射：

- 5 个 entry block 映射 Workflow 根字段，而不是 Step。
- page/game 两个 block 映射同一个 `coordinate-space` Step。
- key/key combo 两个 block 映射同一个 `key-press` Step。
- 一个 click target block 可编译为 `click-image` 或 `click-coordinate`。
- 一个 move target block可编译为 `move-to-image` 或 `move-to-coordinate`。
- 一个 drag target block可编译为旧 `drag-image` 或较新的 `drag`。
- `sequence` 没有独立 statement block，由 Blockly connection 链隐式生成。

## 24. Image/Text/Coordinate 镜像能力矩阵

符号说明：`✓` 为直接支持，`△` 为通过 generic condition/target 间接支持，`—` 为当前没有对应语义。

| 概念操作 | Image | Text | Coordinate/Region | 当前数据结构结果 |
|---|---|---|---|---|
| 可见性 Condition | `ImageCondition` ✓ | `TextCondition` ✓ | position relation △ | 两个识别 Condition + 一个位置 Condition |
| 等待出现/消失 | `wait-image-state` ✓ | `wait-text-state` ✓ | — | 两个镜像 Step |
| 单纯等待找到 | `wait-image` ✓ | visible state △ | — | Image 另有专用 Step |
| Click | `click-image` ✓ | `click-text` ✓ | `click-coordinate` ✓ | 三个 Action×Target Step |
| Move | `move-to-image` ✓ | — | `move-to-coordinate` ✓ | 两个 Action×Target Step |
| Drag endpoint | `drag-image` / `drag` ✓ | — | `drag` ✓ | 旧专用 Step 与 generic target 并存 |
| Position compare target | `PositionCompareTarget` ✓ | — | `PositionCompareTarget` ✓ | 与 drag 使用另一套 target union |
| If | `if-image` ✓ + generic △ | generic `if-condition` △ | generic position △ | Image 有专用和 generic 两条路 |
| Repeat until | `repeat-until-image` ✓ + generic △ | generic condition △ | generic position △ | Image 再次有双路径 |
| Hold key until state | `key-hold-until-image` ✓ | — | — | Action 与 Image condition 焊接 |
| Random click | — | — | `random-click-region` ✓ | Action 与 Region 焊接 |
| Read value | — | — | — | 没有 ReadText、ReadNumber 或 Value 模型 |

### 24.1 直接镜像 Step 数量

按“type 名或字段直接绑定识别/坐标方式”统计：

- Image 专用 Step：8 个——`wait-image`、`wait-image-state`、`click-image`、`key-hold-until-image`、`move-to-image`、`drag-image`、`if-image`、`repeat-until-image`。
- Text 专用 Step：2 个——`wait-text-state`、`click-text`。
- Coordinate/Region 专用 Step：3 个——`click-coordinate`、`move-to-coordinate`、`random-click-region`。
- 已开始 generic 化但范围有限：`drag` 和 `position-compare` 的 target 只接受 image/coordinate；`if-condition`、`wait-condition*`、`repeat-until-condition` 接受 condition union。

### 24.2 字段重复

- Image match 字段 `asset/alternatives/threshold/region/scales/mask` 出现在 `ImageCondition`，并直接复制到多种 Image Step 与 `PositionCompareTarget`。
- Text match 字段 `text/match/minScore/region` 出现在 `TextCondition`、`WaitTextStateStep` 和 `ClickTextStep`。
- `AutomationPointerTarget` 与 `PositionCompareTarget` 都表达 image/coordinate 二选一，但类型形状不同：前者包裹 `condition`，后者展开 image 字段并额外包含 offset。
- Runtime 因此需要 `waitForImage`、`waitForText`、`resolvePointerTarget`、`resolveTargetPoint` 四种相邻但不统一的解析路径。

### 24.3 Blockly 的局部统一不等于 Core 统一

当前 Blockly 已把 image/coordinate click、move、drag 合并到单个可切换 target block。这降低了部分 UI block 数，但 codec 仍根据 target 分裂回旧 Step Type（`AutomationBlocklyEditor.tsx:395-416`）。Text click 仍为独立 block；Text 也不能插入 move/drag/position target。

这证明 UI 层已经尝试隐藏镜像复杂度，但复杂度仍由 Workflow Schema、Runtime switch、Service description 和资产遍历承担。

## 25. Runtime 与 Service 分支量化

### 25.1 Runtime

`AutomationRunner.execute` 有 34 个 `case`，与 34 个 Step Type 一一对应。另有：

- condition evaluator 处理 6 个 Condition kind。
- position relation 有 3 个 relation case：vertical/horizontal/overlap。
- image 和 text 各有独立 polling 函数与 state polling 函数。
- generic condition wait 形成第三套 polling wrapper。
- `coordinate-space` case 手工保存/恢复 Driver space 与 `activeSearchRegion`。
- `vision-region` case手工保存/恢复 `activeSearchRegion`。

增加一个全新的 Locator，如果沿用现状，至少可能触及 Step union/schema、Runtime execute、Condition evaluator/polling、Service describe、capability inference、asset traversal 和 Blockly codec，而不是只注册 Locator。

### 25.2 Service 与 Schema

- `AutomationService.describeStep` 再次完整列出 34 个 Step，用于状态和日志文案。
- `collectWorkflowAssetIds` 的 switch 有 33 个 case label；只省略了没有资产或子节点的 `break`。
- `inferAutomationCapabilities` 不是 exhaustive switch，而是多组 `if`、`'asset' in step` 和 type array；新增 Step/Locator 可能静默漏算 capability。
- Service diagnostics 另有递归 if-chain统计 step/depth，形成又一套 Workflow traversal。

## 26. page/game 分支量化

固定搜索口径得到 10 个 coordinate-space 显式条件点：7 个 `=== 'game'`、2 个 `!== 'game'`、1 个 `=== 'page'`。另一个 `type === 'page'` 位于 CDP target type 判断，与坐标空间无关，已排除。

| 层 | 条件点 | 数量 | 职责 |
|---|---|---:|---|
| Schema | `workflow.coordinateSpace === game`、nested step game、locator refine | 3 | 发现 game usage并要求 feature |
| Blockly | Step → game/page block、Workflow → game entry | 2 | UI codec 分支 |
| Driver | Image capture、OCR capture、page surface、game refresh | 4 | 捕获/坐标实际分支 |
| Service | describe coordinate-space 文案 | 1 | 展示分支 |
| 合计 |  | 10 | 仅显式字符串条件，不含默认赋值与类型声明 |

此外还有未计入条件数但构成模型的状态点：

- Workflow 根字段 `coordinateSpace?: 'page'|'game'`。
- nested `CoordinateSpaceStep`。
- Runtime 构造和每次 run 都以 `?? 'page'` 设置 Driver mutable state。
- Runtime 单独维护 `activeSearchRegion`；跨 coordinate space 时清空并在 finally 恢复。
- Driver 单独维护 `coordinateSpace` 与 `viewportRevision`。
- Service 单独维护 `boundGameSurfaces`；Workflow 保存的是 locator feature，不是当前 rect。
- 页面助手又维护一份当前 `state.gameSurface` 用于 overlay 和 CSS-region capture。

因此 page/game 不是一个枚举分支，而是 Workflow scope、Runtime mutable scope、Driver capture/input scope、Service binding 和 Assistant UI state 五层状态的组合。

## 27. BrowserViewAutomationDriver 职责量化

`AutomationDriver` 公开 23 个方法，分类如下：

| 职责 | 方法数 | 方法 |
|---|---:|---|
| Recognition / Frame | 3 | `findImage`、`findText`、`withFreshFrame` |
| Target / Coordinate context | 3 | `resolveTargetPoint`、`getCssViewport`、`setCoordinateSpace` |
| Pointer input | 6 | `click`、`moveTo`、`moveToPoint`、`drag`、`dragTargets`、`clickPoint` |
| Keyboard/Text/Scroll input | 5 | `pressKey`、`keyDown`、`keyUp`、`typeText`、`scroll` |
| Browser navigation | 2 | `navigate`、`reload` |
| Output | 2 | `log`、`notify` |
| Time | 2 | `sleep`、`now` |
| 合计 | 23 |  |

具体 Driver 还承担协议外职责：

- BrowserView capture 和 nativeImage/bitmap normalization。
- Frame id、`lastFrame` 与 condition-scoped frame cache。
- logical/display/device/region coordinate conversion。
- page/game coordinate surface和 viewport revision refresh。
- CDP lease、debugger ownership guard、mouse release recovery。
- OCR box过滤与 TextMatch 构造。
- Vision performance logging。
- BrowserView current-target guard与导航事件等待。

Driver 的 23 个协议方法和上述内部职责横跨用户目标中拟拆分的 BrowserView Adapter、Coordinate Resolver、Input、Vision、Text Recognition、Capture 与 Runtime support。

## 28. Vision/OCR/Capture 重复逻辑

### 28.1 直接调用点

Automation 范围共有 4 个 `capturePage` 源码调用点：

1. `BrowserViewAutomationDriver.findImage`。
2. `BrowserViewAutomationDriver.findText`。
3. `AutomationService.captureAssetFrame`。
4. `AutomationService.captureReferenceFrame`。

OCR engine 有 2 个 `recognize` 调用点：Driver runtime path 与 Service offline/test path。

### 28.2 重复层次

| 重复内容 | 实现位置 | 数量/表现 |
|---|---|---|
| Runtime capture preparation | Driver `findImage` vs `findText` | 两段独立 region、display region、frame key、capturer count、resize、bitmap、frame metadata 代码 |
| Offline recognition service | `testAssetOnImage` vs `testTextOnImage` | 两个入口，各自构造 frame-like object和 controller |
| Workbench test orchestration | `automation:test-asset-on-scene` vs `test-text-on-scene` | 两套 matcher/OCR result adapter |
| Assistant test orchestration | `userscript:automation-match` vs `automation-ocr-test` | 两套 capture、resize、preview 和 timing adapter |
| OCR box normalization/filter | Driver、workbench IPC、assistant IPC | 3 处从 polygon box计算 x/y/right/bottom 和匹配语义 |
| Asset preview | main workbench IPC与 assistant IPC | 两套 decode/resize/data URL 路径，尺寸预算不同 |
| Asset capture | main workbench与 assistant | 两套 token Map、preview rect、crop/normalize/save 流程 |

### 28.3 已有复用及其边界

- `withFreshFrame` 能在一次 condition evaluation 内，以相同 logical capture region key 让 Image 和 OCR 共用 Driver frame。
- `testScenes/liveTestScenes` 允许工作台在同一已导入/捕获场景上分别运行多次测试，但每次仍重复 `toBitmap` 与 recognizer adapter。
- `captureReferenceFrame` 被工作台和助手复用，但只返回 PNG/size，不返回有所有权和元数据的共享 Frame。
- OpenCV test matcher 有 30 秒 session cache；runtime matcher 也有 idle cache；两者不是同一 session。
- `lastFrame` 只服务于 match → input 坐标换算，不是跨 Service/IPC 的 capture reuse contract。

### 28.4 明确存在的重复截图场景

- `click-image` 先在 `waitForImage` 捕获；启用 `verifyBeforeClick` 后又直接调用 `findImage`，不在同一 `withFreshFrame` scope，通常再次截图。
- 页面助手分别点击图片测试和 OCR 测试会分别调用 `captureReferenceFrame`。
- 工作台分别捕获资产、捕获测试场景和 Runtime 识别时各自获得 Frame。
- 普通 polling 每个周期重新截图是预期行为；问题是同一逻辑操作内没有统一 Frame 所有权可表达“复用或刷新”。

## 29. Coordinate conversion path 全图

当前同时存在三种未带品牌标识的几何数据：

- `AutomationCoordinate`：0–10000 normalized point。
- `AutomationRelativeRegion`：0–10000 normalized corners。
- `AutomationRegion`：x/y/width/height integer；类型本身不注明 logical、display、bitmap 或 preview space。

### 29.1 坐标 Action：normalized point → CDP

```text
AutomationCoordinate (0..10000)
  ↓ Runtime click-coordinate / move-to-coordinate / drag target
Driver.clickPoint / moveToPoint / dragTargets
  ↓ ensureCoordinateSurfaceCurrent
coordinateSurfaceLogical()
  ├── page: logical viewport {0,0,1280,720}
  └── game: live CSS rect ÷ viewport scale → logical surface
  ↓ relativeCoordinateToCssPoint(surface-local)
  ↓ add logical surface origin
full logical point
  ↓ logicalPointToDisplay(scaleX/scaleY)
live BrowserView display point
  ↓ transient CDP lease
Input.dispatchMouseEvent
```

### 29.2 Recognition region：normalized region → Capture

```text
Workflow searchRegion / vision-region (0..10000 corners)
  ↓ Runtime activeSearchRegion intersection
FindImage/FindText.relativeRegion
  ↓ Driver.relativeRegionToLogical
coordinateSurfaceLogical(page/game)
  ↓ relativeSearchRegionToCssRegion + surface origin
logical capture region
  ↓ optional intersect with game surface
  ↓ logicalRegionToDisplay(floor origin / ceil far edge)
live CSS/DIP capturePage rect
  ↓ native image normalize back to logical capture size
Frame bitmap + logical deviceOrigin + regionCssSize
```

`ImageCondition.region`/`TextCondition.region` 使用 `AutomationRegion`，会绕过 normalized `activeSearchRegion`，直接作为 logical requested region；在 game space 中再与 game surface求交。类型本身没有标记这一语义。

### 29.3 Image match → Pointer

```text
OpenCV match (frame bitmap-local pixels)
  ↓ Driver.lastFrame
toCssPoint()
  ├── full frame: deviceMatchToCssPoint(deviceSize → logical cssSize)
  └── region frame: bitmap → regionCssSize + logical deviceOrigin
  ↓ optional action offset
full logical point
  ↓ logicalPointToDisplay
CDP mouse point
```

这条路径依赖隐式契约：input Action 接收的 `ImageMatch` 必须对应 Driver 当前 `lastFrame`。`ImageMatch` 自身不携带 Frame 引用或 coordinate space。

### 29.4 OCR box → Pointer

```text
PaddleOCR polygon (frame bitmap-local pixels)
  ↓ Driver.findText calculates bounding rectangle
TextMatch (仍使用 ImageMatch-shaped x/y/width/height)
  ↓ same Driver.lastFrame
toCssPoint()
  ↓ region/full-frame branch
logical point → display point → CDP
```

OCR 与 Vision 在最后复用同一 `toCssPoint`，但 OCR polygon → rectangle 在 Driver、workbench IPC和 assistant IPC 各实现一次。

### 29.5 Authoring 逆向路径：页面点击 → normalized coordinate

```text
Assistant pointer clientX/clientY (live page CSS)
  ↓ optional visible bound-game rect
page/surface-local point
  ↓ account for live innerWidth vs 1280×720 step
normalize to 0..10000
  ↓ clipboard text "x,y"
Blockly field parser
  ↓ AutomationCoordinate
```

此逆向转换在 `automation-frame-assistant.user.js:292-301` 自行实现，没有调用 Driver 导出的 `cssPointToRelativeCoordinate`。Driver 文件虽导出该 helper（`browserview-driver.ts:226-234`），当前页面助手跨进程无法复用。

### 29.6 Capture selection：preview → source → logical asset

```text
Renderer/assistant selection rect in displayed preview
  ↓ previewRectToSource(preview size, source image size)
source bitmap crop rect
  ↓ crop
  ↓ source-to-1280×720 normalization ratio
stored asset bitmap
```

主工作台和页面助手各自维护 token/preview metadata，再调用相同 `previewRectToSource` helper；归一化计算仍各自存在于 IPC handler。

## 30. P0-T03 测试基线复核

固定清单为：

- 14 个根目录 `automation*.test.ts`。
- 12 个 `tests/electron/automation-*` 或 `build-automation-*` 文件。
- 合计 26 文件、4,154 行、232,597 bytes。

间接相关的 `userscripts-admin-smoke.cjs` 与 `userscripts/gm-api-grants.test.ts` 不计入这 26 个“Automation 命名测试”，但在 P0-T02 页面助手证据中单独登记。

量化结果对应的主要测试：

- 34 Step/schema：`automation-schema.test.ts`、`automation-runtime.test.ts`。
- Block/Step 映射：`automation-block-schema.test.ts`、Blockly/Workbench smokes。
- Driver 23 方法涉及的行为：`automation-browserview-driver.test.ts` 与 Electron input/visual smokes。
- page/game/坐标：driver test、game surface detector test、fixed viewport/Flash/Ruffle smokes。
- Capture crop：`automation-capture-geometry.test.ts`。
- Vision worker：`automation-vision-worker.test.ts`。

现有测试证明旧模型的大量行为，但没有架构测试保证“新增 Locator 不新增 Action/Block/Runtime case”；这是 Phase 3 必须新增的约束测试。

## 31. P0-T03 事实结论

1. 34 Step、43 Block 和多套 traversal 的增长单位仍主要是“动作 × 目标 × 控制流特例”。
2. Blockly 已局部合并 image/coordinate UI，但 codec 会还原为分裂 Step，因此 Core 复杂度未下降。
3. Text 只进入 Condition、Wait 和 Click，尚不能成为通用 Pointer target；系统没有 ReadText/ReadNumber/Value。
4. page/game 有 10 个直接条件点，但实际状态分散在五层，显式条件数低估了生命周期复杂度。
5. Driver protocol 有 23 个方法，并且具体实现还承担 Capture、Frame、Coordinate、CDP 与识别后处理。
6. Runtime Image/OCR 可在有限 condition scope 共用 Frame，但同一 Action 的复核、不同前端测试和 authoring 仍会重复 Capture。
7. 三类 geometry type 没有携带 Space；`AutomationRegion` 在不同边界代表 logical、display、bitmap 或 preview region，只靠调用位置解释。
8. match → click 依赖 Driver `lastFrame`，Frame 归属没有进入 Match 类型。

## 32. 下一批输入：P0-T04

P0-T04 将审计隐式契约与风险，不设计新接口：

- active/probe/authoring 的互斥和竞争。
- BrowserView、CDP lease、viewport revision 与 navigation 生命周期。
- Frame、matcher cache、OCR process、临时 token和 package storage所有权。
- surface locator、临时 binding与 WebContents replacement。
- cancellation、timeout、fire-and-forget与错误可见性。
- capability/security/grant 边界和脚本权限面。
- 哪些隐式契约必须在 Phase 1 变成不变量或 ADR。

## 33. P0-T04 状态、互斥与所有权图

### 33.1 Service 实际持有的运行状态

`AutomationService` 不是单一 session 状态机，而是同时维护以下状态槽：

| 状态槽 | 基数 | 主要资源 | 主要释放路径 |
|---|---:|---|---|
| `active` | 全局 0..1 | package、tab、BrowserView handle、Runner、runtime matcher、history | `disposeSession` |
| `probe` | 全局 0..1 | AbortController、BrowserView handle、独占 matcher | `testAsset` 的 `finally` |
| `authoringViewport` | 全局 0..1 | tab、BrowserView handle、5 分钟 timer | 显式 end、超时或转交给 runtime |
| `imageTests` | 每 package 0..1 | matcher、串行 Promise queue、30 秒 idle timer | idle close、package mutation |
| `runtimeMatchers` | 每 package 0..1 | runtime 用过的 matcher、60 秒 idle timer | idle close、package mutation |
| `detectedGameSurfaces` | 每 tab | 最近一次候选列表 | clear/re-detect；无 tab-destroy hook |
| `boundGameSurfaces` | 每 tab | `webContentsId`、fingerprint、candidate | clear/refresh；无 tab-destroy hook |
| `PaddleOcrEngine` | Service 单例 | child process、startup、pending request、global queue | engine close 或 cancel 当前 request |

证据集中于 `service.ts:108-114`。这些槽之间没有共同的 owner token 或统一 dispose graph；互斥由每个入口各自检查若干字段实现。

### 33.2 当前互斥矩阵

下表记录 Service 层显式检查。`BrowserView lease` 表示即使 Service 未检查，同 tab 的 `TabManager.beginAutomation` 仍可能拒绝第二个 viewport owner。

| 新操作 | active | probe | authoring | offline image test | 说明 |
|---|---|---|---|---|---|
| runtime `start/checkReady/debugStart` | 同 package+tab 复用；其他拒绝 | 拒绝 | 同 tab 转交；其他 tab 拒绝 | 允许 | surface preparation 在 session 占位之前发生 |
| live `testAsset` | 拒绝 | 拒绝 | Service 未显式拒绝；同 tab lease 会拒绝 | 允许 | 创建独立 matcher/probe |
| `captureAssetFrame` | 拒绝 | 拒绝 | 拒绝 | 允许 | 是少数显式检查三者的入口 |
| authoring viewport | 拒绝 | 拒绝 | 同 tab续期；其他 tab先释放 | 允许 | 5 分钟自动释放 |
| game-surface detection | 拒绝 | 拒绝 | 同 tab复用；其他 tab释放 | 允许 | detection 自身没有占用 Service 状态槽 |
| offline `testAssetOnImage`/warmup | 未检查 | 未检查 | 未检查 | 同 package queue 串行 | 可与 runtime 并行，使用不同 matcher |
| offline `testTextOnImage` | 拒绝 | 拒绝 | 未检查 | 不适用 | 与 image offline test 策略不对称 |
| workflow/package mutation | 同 package 运行时拒绝 | 多数入口全局拒绝 | 多数未阻止 | matcher 会按入口关闭 | 不同 package 可修改 |

这张矩阵是当前行为，不代表新 Core 应保留相同策略。

### 33.3 隐式 session 状态机

```text
idle
  ├─ beginAuthoringViewport ──> authoring
  │      ├─ same-tab start ──> transfer handle ──> active
  │      └─ end/5 min timer ──> idle
  ├─ testAsset ──> probe ──> finally close matcher/release handle ──> idle
  ├─ checkReady ──> active/checking ──> finally dispose ──> idle
  ├─ start ──> active/running ──> finally dispose ──> idle
  └─ debugStart ──> active/running-or-paused
                         └─ detached Promise finally ──> idle

orthogonal caches:
  package → imageTests matcher (30 s)
  package → runtimeMatchers matcher (60 s)
  service → OCR child + global request queue
  tab → detected/bound surface state
```

`ensureSession` 在已有 `active` 且 package/tab 相同时直接返回同一 session（`service.ts:638-645`）。因此“同一 start 请求的幂等复用”与“两个调用者并发驱动同一个 Runner”没有类型或 token 区分；正确性依赖 UI 状态门禁和 Runner 自身状态检查。

### 33.4 Service shutdown 的覆盖范围

`shutdown()` 当前只执行：

```text
cancel active/probe
  ↓
await OCR close
```

它没有显式：

- 等待 active/probe 的 `finally` 完成；
- 释放 authoring viewport；
- 关闭 `imageTests` 和 `runtimeMatchers`；
- 清除这些 matcher 的 idle timer；
- 清除 detected/bound surface maps。

应用退出会终止进程，因此不能仅凭此断言跨进程永久泄漏；但 `shutdown()` 本身不是可验证的“Service 所有资源均已释放”契约。Phase 1/4 不能把进程退出当作 Core 生命周期模型。

## 34. BrowserView、viewport 与 CDP 生命周期

### 34.1 BrowserView viewport lease

`TabManager.beginAutomation` 建立每 tab 独占 lease：

1. 只允许当前 active tab，且必须已有 live BrowserView/display rect。
2. 同 tab 已有 `automationTargets` 立即拒绝。
3. 生成 symbol token，保存原 bounds，暂停 password capture。
4. 设置固定 automation viewport并等待页面测量稳定。
5. handle 每次通过 token、active tab、当前 WebContents 与 destroyed 状态检查有效性。
6. release 仅在 token仍匹配时恢复 bounds，并恢复 password capture。

`refreshVersion` 在窗口 bounds/zoom 变化时递增。Driver 通过 viewport revision 重新获取/刷新 game surface，说明 surface resolution 已经隐含依赖 viewport lease revision，但该版本没有进入 `Frame`、`Match` 或 `Surface` 类型。

### 34.2 WebContents 替换与 tab 切换

- engine switch、tab recreation 或 WebContents destroyed 后，旧 handle 的下一次 `assertCurrent` 失败。
- active tab 切换不会主动向 Service 发出 cancel；错误通常延迟到下一次 Driver/handle 操作。
- 纯 sleep/poll 间隔只观察 AbortSignal，不一定立即观察 active-tab/WebContents 变化。
- `destroyAll()` 直接清空 `automationTargets`；它不逐一调用 Service owner 的 release/dispose，但发生在应用整体 teardown。
- surface binding 保存 `webContentsId`，refresh 时可检测 replacement 并清除；map 项本身没有 tab destroyed 通知驱动的及时回收。

因此当前 target invalidation 是“下次使用时发现”，不是事件驱动的 session invalidation。

### 34.3 CDP lease

`cdp-lease.ts` 规定每个 WebContents 最多一个 debugger owner，owner 仅有：

- `password-capture`
- `automation`

租约用内部 symbol token保证旧 owner不能 detach 新 owner；release 幂等；若 debugger 已被 DevTools或其他未登记 client attach，则 acquisition 拒绝。Automation input 每次动作使用 transient lease 并在 `finally` 释放；game surface detector 则在一次检测过程内持有 lease，结束时移除 message listener并释放。

这是必须保留的产品级约束：Electron 同一 WebContents 只有一个 debugger client，而且长期 attach 会破坏现有导航/JSONP 行为。未来 Input/Browser Adapter 拆分不能各自发明 debugger ownership。

### 34.4 Navigation 生命周期

Workflow schema仅允许最大 2048 字符的 `http(s)` URL。Driver 导航前要求 debugger detached，然后监听 load outcome并使用默认 30 秒 timeout。

隐式顺序为：

```text
previous input transient CDP lease released
  ↓
Driver assert no debugger owner
  ↓
loadURL / navigation wait
  ↓
BrowserView lifecycle reapplies automation viewport
  ↓
surface revision/fingerprint refresh on later use
```

如果 surface discovery 正在持有 CDP，或 unmanaged debugger 已 attach，导航会失败。这里的正确性来自调用顺序，而不是 Runtime 类型系统。

## 35. Frame、Vision 与 OCR 资源边界

### 35.1 Frame 所有权缺口

`AutomationCapturedFrame` 同时携带 image、bitmap、logical/device size、origin 等数据，但 OCR engine 直接从 `browserview-driver.ts` 导入该类型。结果是 Text Recognition 的输入契约依赖具体 Driver，而非独立 Capture/Core contract。

当前 Match 只保存几何和 score；点击映射依赖 Driver 可变 `lastFrame`。因此实际不变量是：

> Match 必须在同一个 Driver 实例中、且在 `lastFrame` 被其他 capture 覆盖前消费。

该不变量没有由类型、frame id 或 revision校验。跨 service、缓存或并行执行后都可能失效。

### 35.2 Vision worker

`VisionWorkerMatcher` 的主要资源规则：

- 单 matcher 默认 request timeout 15 秒；
- 同一 matcher 同时超过一个 pending request会拒绝；
- abort、timeout、shared channel异常会 restart worker并拒绝所有 pending；
- worker template cache默认 32 entries / 64 MiB；
- shared buffer默认 64 MiB；
- Service template provider另有 64-entry LRU；
- offline image test同 package使用 Promise queue串行；runtime Runner通常也串行。

不同 matcher实例可并行，因此一次 runtime 和一次 offline image test可能各自持有 worker/cache/shared buffer。当前预算是“每实例”，不是 Automation 平台全局资源预算。

### 35.3 OCR sidecar

`PaddleOcrEngine` 是 Service级单例：

```text
recognize
  ↓ global Promise queue (strictly serial)
ensure child started (30 s startup timeout)
  ↓
mkdtemp(os.tmpdir/bao-ocr-*)
  ↓ write capture.bmp
pipe JSON request
  ↓ one pending response
parse stdout line
  ↓
best-effort remove temp directory
```

已确认的边界：

- 一个 abort会 kill共享 OCR child，并清空 child/startup；后续请求重启进程。
- startup 有 30 秒 timeout，但单次识别响应没有自己的 timeout；sidecar不响应会阻塞全局 queue，直到 abort或 shutdown。
- startup timeout callback只 reject startup Promise，未在该 callback 中 kill/reset child；若进程仍存活且不再发 ready，后续请求可能继续获得同一 rejected startup状态。
- `stderr` 设置了编码，但没有 data consumer；若 sidecar大量写 stderr，存在 pipe backpressure 风险。
- 临时目录清理是 best effort，失败不会反馈给调用者。
- OCR cancel 的粒度是“杀共享进程”，不是取消某个独立 request。

这些是当前实现审计结论；RapidOCR/PP-OCRv6 方案评估必须把响应 timeout、队列公平性、进程重启和资源预算纳入 benchmark，而不只比较识别率与平均延迟。

### 35.4 Capture reuse 的并发含义

`withFreshFrame` 只在一次 condition evaluation中复用 frame；它不是跨 Action、跨前端或跨 recognizer 的 transaction。未来共享 CaptureFrame 必须回答：

- 谁创建并 dispose frame；
- frame是否绑定 target、viewport revision、surface revision和时间戳；
- 哪些 consumer允许并发读；
- 何时强制 refresh；
- stale frame如何报错；
- recognition result在 frame释放后是否仍可使用。

## 36. 临时 token、package 与 Surface 状态所有权

### 36.1 IPC 临时对象预算

| Map | TTL | 上限 | token/关联 |
|---|---:|---:|---|
| pending package imports | 2 分钟 | 3 | random token；保存 bytes/packageId |
| workbench captures | 2 分钟 | 3 | random token；保存 NativeImage/preview metadata |
| test scenes | 10 分钟 | 2 | random token；保存 NativeImage |
| live test scenes | 10 分钟 | 2 | random token；保存 NativeImage |
| assistant captures | 2 分钟 | 3 | 128-bit hex；保存 NativeImage/preview metadata |
| linked asset folders | 无 TTL | 16 | 128-bit hex；绑定 packageId/root |

有 TTL 的 timer均 `unref()`，超限按插入顺序淘汰。这些 Map 位于 IPC registration closure，不属于 `AutomationService.shutdown()`，也没有统一 revoke/cleanup API。

主工作台 token按“可信 renderer”处理；页面助手 capture token在保存时仍要求专用 grant，但 token本身没有绑定 sender WebContents/tab/package。它相当于专用 grant范围内的短期 bearer token。

### 36.2 package/storage 边界

现有 package loader已有的重要防御：

- archive path安全检查；
- 最多 1,200 files、64 MiB uncompressed；打开对话框另有 32 MiB compressed限制；
- assets只接受支持的图片扩展；
- manifest/workflow id一致、引用资产必须存在；
- workflow/schema严格 Zod校验；
- package id受 schema约束，storage固定在 userData automation packages目录；
- 更新采用临时文件/backup与回滚路径。

当前 `.baoauto` 没有签名或发布者信任模型；语义是本地用户显式导入后执行。manifest `capabilities` 会在 load缺失时推导、serialize/export时重写，不能作为不可篡改授权声明。

### 36.3 Surface binding

持久 workflow可保存 game surface locator；运行时 Service另存 detected candidates与bound fingerprint/candidate。binding通过 `webContentsId` 防止直接复用到 replacement renderer，并用 fingerprint/replacement heuristic重新定位。

当前隐式问题：

- detection是异步长操作，却没有自己的 Service operation slot或 AbortSignal；
- `start` 在 `ensureSession` 之前最多等待 30 秒寻找 surface，此时 `cancel()` 看不到 active/probe，无法取消这段等待；
- 两个调用者可能同时进入 surface preparation，互斥最终由 BrowserView/CDP的较低层租约碰撞实现；
- bound candidate与viewport revision没有共同 generation id。

Phase 1 必须区分持久 `SurfaceSpec`、一次 resolution attempt、运行时 `ResolvedSurface` 和失效 generation。

## 37. 取消、timeout、fire-and-forget 与错误可见性

### 37.1 取消覆盖矩阵

| 操作 | 可被 `AutomationService.cancel()` 取消 | 机制 | 缺口 |
|---|---|---|---|
| active Runner | 是 | `runner.cancel()` → AbortSignal | cancel不等待完成/dispose |
| live asset probe | 是 | probe controller abort | cancel立即 return，释放在 probe finally |
| pre-session surface wait | 否 | 无 controller | 最长等待约30秒 |
| authoring viewport | 否 | end或5分钟timer | cancel无影响 |
| offline image test/warmup | 否 | 局部 controller不外露 | 可与 active并行 |
| offline OCR test | 间接/不稳定 | active/probe时入口拒绝；自身 controller不外露 | 单次 sidecar hang无request timeout |
| pending capture/import token | 否 | TTL/eviction | 与 run cancel无关 |

`cancel()` 优先 abort probe，否则 cancel active；正常不应两者共存。若互斥不变量被未来代码破坏，它一次只会取消其中一个。

### 37.2 timeout 分散

timeout由多个层各自定义：surface wait、navigation、vision worker、OCR startup、workflow wait/repeat、viewport settle、临时 token TTL。它们没有统一 deadline/context传播，也不能区分用户 timeout、资源 timeout与目标失效。

新 Core 不一定需要企业级调度框架，但必须至少统一：

- operation id；
- parent AbortSignal；
- deadline/timeout原因；
- finally/dispose完成语义；
- user-visible error category。

### 37.3 fire-and-forget

- `start()` 的 IPC Promise覆盖完整 run，调用者可直接看到完成/失败。
- `startDebug()` 启动 detached Promise并立即返回 `true`；失败通过 status/log/history暴露。
- 页面助手 start handler也以后台运行形式返回启动结果，主要依赖全局 status观察。
- `main/index.ts` 使用 `void automationService?.shutdown()`，应用退出不等待 Service shutdown完成。

因此 status事件在 debug/assistant路径上不仅是 UI telemetry，也是主要 completion/error channel。Phase 5 Runtime API必须明确 start acknowledgement 与 run completion 是一个 Promise、两个事件，还是 RunHandle。

### 37.4 错误与日志数据

validated IPC会记录 invalid arguments；handler错误会记录 channel与 error message再抛回 renderer。Service又把运行错误写入 status/log/history。

当前 OCR Driver debug日志会记录完整识别文本、score和box。页面视觉文本可能包含账号、聊天或其他敏感信息；即使并非密码捕获通道，也需要 Phase 1/4 明确 Automation 日志的数据分级、默认 redaction 和 debug opt-in。未来 JavaScript API尤其不能默认获得或持久化所有 OCR evidence。

## 38. Capability、IPC 与脚本授权边界

### 38.1 manifest capability 是描述，不是权限

当前 capability union共 8 项：

```text
vision, ocr, alpha-mask, image-groups, multi-scale,
trusted-input, navigation, combined-conditions
```

它们由 workflow静态推导。执行时已发现的实际 gate主要是：

- `ocr`：标准版无 sidecar时拒绝 session；
- `vision`：决定是否创建 matcher。

`trusted-input`、`navigation` 等没有用户批准、origin policy或per-run consent。故 capability当前是兼容/诊断 metadata，不是 security permission。Phase 7不能沿用其名称后直接当沙箱权限系统。

### 38.2 主工作台 IPC

main preload以 channel whitelist限制 renderer可 invoke的范围，Automation暴露 37 个 invoke channel；每个 Automation handler使用 Zod验证 payload。`safeInvoke` 只验证 channel名，main通用 `createValidatedHandler`不验证 `event.sender`身份。

这符合当前“内置 main renderer是可信管理前端”的边界，但它不是可供任意 Automation frontend复用的 capability security boundary。未来 JS脚本不能得到同一个 `electronAPI.invoke`。

### 38.3 页面助手专用授权

Userscript Automation IPC 额外要求：

1. 固定 `AUTOMATION_ASSISTANT_SCRIPT_ID`；
2. sender WebContents在 UserscriptManager中有 registration；
3. 对应 script已安装且 enabled；
4. metadata声明 `GM_baoAutomation`；
5. 需要 tab的操作从 `event.sender.id`解析当前 tabId。

这比主工作台边界窄，但 status/cancel/list等是 Service全局操作，不绑定某个 run owner；获授权的助手可观察或取消另一入口启动的全局 run。该行为可能是产品需要的“全局控制器”，也可能是旧实现偶然范围，需在 Phase 1/7做显式决定。

### 38.4 未来 JavaScript sandbox 的最低边界输入

当前仓库尚无 JavaScript Automation API，因此这里不是现有漏洞结论。Phase 7至少需要独立设计：

- 不暴露 Node、Electron、raw IPC、filesystem或任意 CDP；
- 按 API capability授权 input、navigation、capture、vision、OCR、clipboard、notification与网络；
- run绑定 package/script/origin/tab和owner；
- 限制 CPU/time/memory、并发、日志和输出大小；
- cancellation与resource disposal由 host控制；
- OCR/capture evidence默认不跨权限边界泄漏；
- capability manifest、用户批准与运行时 enforcement分别建模。

## 39. 隐式合同分类

### 39.1 必须保留的业务/平台合同

| 合同 | 原因 |
|---|---|
| BrowserView是自动化目标，Electron/Chromium版本不变 | 产品平台约束 |
| active tab和当前 WebContents校验 | 防止把输入送到错误标签页 |
| password capture与automation共享唯一CDP lease | Electron debugger限制与已知导航冻结问题 |
| navigation前debugger必须detached | 已有站点兼容性硬约束 |
| fixed logical viewport与live transform可刷新 | 当前确定性坐标/截图基线 |
| package path/size/count/schema/asset安全检查 | 本地文件与资源防御边界 |
| assistant需专用grant且tab来自sender | Userscript权限隔离 |
| cancellation最终必须释放viewport/CDP/matcher/capture资源 | 正确性与可恢复性 |

### 39.2 需要显式决策、不能默认继承的行为

| 当前行为 | 为什么不能直接当需求 |
|---|---|
| 全应用只有一个 active session | 可能是旧 UI/Driver限制，而非平台必然要求 |
| 同 package+tab调用复用同一 Runner | 没有定义幂等或多调用者语义 |
| offline image test可与run并行、OCR test不可 | 实现不对称 |
| cancel只处理active/probe | 状态槽拼接的结果 |
| assistant可查看/取消全局run | 可能是管理功能，也可能权限过宽 |
| OCR abort杀整个sidecar | 单 pending实现选择 |
| 30/60秒 matcher cache TTL | 性能调优值，不是Core语义 |
| `lastFrame`解释Match | Driver实现偶然合同，必须删除 |
| page/game两值space | 当前模型限制，已被新目标否定 |

## 40. P0 风险登记

| ID | 风险 | 证据 | 影响阶段 | 关闭条件 |
|---|---|---|---|---|
| RISK-P0-01 | Match与可变`lastFrame`错配 | §29.3、§35.1 | P1/P2/P3 | result携带frame/space/generation并验证 |
| RISK-P0-02 | surface wait发生在session占位前且不可取消 | `service.ts:183-204,458-482` | P1/P2/P5 | resolution成为可取消operation并受统一owner管理 |
| RISK-P0-03 | 同package/tab并发调用共享Runner | `service.ts:638-645` | P1/P5 | 明确RunHandle/idempotency/并发拒绝策略并测试 |
| RISK-P0-04 | shutdown未收束全部资源 | `service.ts:134-137`及资源map | P1/P4 | dispose graph测试证明零live lease/worker/timer/process |
| RISK-P0-05 | OCR响应无request timeout，可能阻塞全局queue | `paddle-ocr-engine.ts:79-178` | P4 | per-request deadline、restart与queued cancellation测试 |
| RISK-P0-06 | Capture/recognizer全局资源无总预算 | matcher/scene/capture多实例 | P4/P7 | host级并发和memory预算 |
| RISK-P0-07 | manifest capability被误当security permission | `package.ts:26-65` | P1/P7 | capability/approval/enforcement三层ADR |
| RISK-P0-08 | status/cancel缺少run owner scope | main/assistant IPC | P1/P5/P7 | RunId/owner/token与管理权限策略 |
| RISK-P0-09 | surface binding无generation，target替换延迟发现 | TabManager + service maps | P1/P2 | target/surface/frame统一generation invalidation |
| RISK-P0-10 | OCR与Automation日志可能持久化页面敏感文本 | Driver OCR debug log + IPC error logging | P1/P4/P7 | data classification/redaction/debug policy与测试 |
| RISK-P0-11 | 新格式若继续使用`formatVersion: 2`产生歧义 | 当前package已为v2 | P1/P8 | ADR固定新格式版本，建议3 |

## 41. Phase 1 必须建立的不变量候选

以下是审计输入，不是已批准接口设计：

1. 每个长操作拥有唯一 Operation/Run ID、owner、target、AbortSignal和deadline。
2. 一个资源必须有唯一 owner或显式共享 lease；dispose可等待且幂等。
3. `SurfaceSpec`、`ResolvedSurface`、`CaptureFrame`、`LocatedTarget`共享可校验的 target/surface generation。
4. Point/Region/Match不允许脱离 Space；Match不依赖任何 Driver全局可变状态。
5. target/WebContents/viewport/surface失效应主动终止依赖 operation，不只在下次输入时发现。
6. CDP由单一 host adapter协调，Input与surface detector不能绕过租约。
7. CaptureFrame不可变，并明确共享读取、刷新与释放规则。
8. TextLocator、ReadText与ReadNumber分别拥有定位、读取和数值解析错误语义。
9. manifest capability、用户授权和runtime enforcement是三个不同概念。
10. `cancel()` completion表示已完成清理，而非仅发出 abort信号；若保留非等待版本必须另命名。
11. shutdown必须能证明没有active operation、BrowserView lease、CDP lease、worker、sidecar pending request或owned timer。
12. 前端只能获得Core facade，不能获得BrowserView/WebContents/raw IPC/Node/Electron对象。

## 42. 测试空洞与后续验证矩阵

现有 26 个 Automation命名测试覆盖大量旧行为，但以下架构合同未形成测试：

| 空洞 | 最早补齐阶段 |
|---|---|
| 同 package/tab两个并发start的明确结果 | P5 |
| surface wait期间cancel立即生效并清理 | P2/P5 |
| target/WebContents替换主动invalidate run/frame/match | P2 |
| 不同ROI连续识别后旧Match不能映射到新Frame | P2/P3 |
| viewport revision变化后旧ResolvedSurface/Match拒绝 | P2 |
| shutdown后所有lease/worker/timer/sidecar为零 | P2/P4 |
| OCR单请求hang timeout、sidecar restart、queued request继续/取消 | P4 |
| Vision与OCR对同一Frame只capture一次 | P4 |
| 新增Locator不新增Action/Runtime/Blockly镜像case | P3/P6 |
| assistant status/cancel的owner权限边界 | P5/P7 |
| capability声明不等于授权，host逐项enforce | P7 |
| OCR/log evidence默认redaction | P4/P7 |

## 43. P0-T04 事实结论

1. 当前生命周期由至少七类Service状态槽、TabManager viewport lease、模块级CDP lease和IPC closure token map共同构成，不存在统一operation/resource owner。
2. active/probe/authoring的互斥是入口级条件拼接；offline Image/OCR测试策略并不一致。
3. surface discovery发生在active session创建之前，最长30秒的等待不受Service cancel控制。
4. BrowserView token与CDP token都能防止旧owner误释放新owner，这是应保留并上移为Core合同的有效机制。
5. Match依赖`lastFrame`、Surface依赖隐式viewport revision，Frame/Match/Surface之间缺少共同generation。
6. Vision有每实例timeout与cache预算；OCR只有startup timeout，没有recognize response timeout，且取消会重启共享进程。
7. `shutdown()`不是完整resource barrier；debug/assistant路径又以status作为主要completion channel。
8. 主工作台的Zod+channel whitelist建立了可信renderer边界；页面助手另有固定script/grant/sender-tab gate。
9. 现有8项manifest capability是静态描述，不是权限系统；JavaScript frontend必须另建sandbox、approval与enforcement。
10. package/archive安全检查值得保留，但临时token、matcher、surface binding与operation没有统一revoke/cleanup模型。

## 44. 下一批输入：P0-T05 审计收口

P0-T05 不新增产品设计，负责：

- 按用户指定范围逐项做coverage checklist；
- 复核所有数字、源码证据、事实/推断/风险标签；
- 补充审计摘要、架构债务优先级和Phase 1问题清单；
- 对照完整测试基线与工作树，确认Phase 0没有产品代码变更；
- 将审计状态从 `In Progress` 提交为 `Review`，等待用户批准后再进入Phase 1。

## 45. P0-T05 用户指定范围覆盖清单

| 用户指定调查域 | 主要证据章节 | 覆盖结论 |
|---|---|---|
| `shared/automation/types` | §4.1、§23、§24、§29 | 34 Step、6 Condition、geometry/capability已枚举 |
| Runtime | §4.2、§12、§25、§37 | Driver protocol、34 case、scope、cancel/error已覆盖 |
| BrowserView Driver | §4.2、§12.2、§27、§29、§34 | 23方法、7类职责、capture/input/coordinate/CDP已覆盖 |
| Vision worker | §4.2、§28、§35.2 | worker、timeout、cache、shared buffer、restart已覆盖 |
| OCR | §4.2、§6.2、§28、§35.3 | 发布基线、sidecar协议、queue、timeout/cancel缺口已覆盖 |
| Blockly | §4.4、§13、§23.2、§24.3 | workspace/draft、codec、43 blocks、保存链已覆盖 |
| workspace/store | §13.1、§17 | component workspace、localStorage draft、installed package双状态已覆盖 |
| `.baoauto` | §6.1、§16、§36.2 | preview/commit、format v2、storage、校验和恢复已覆盖 |
| Capture | §12.2、§15.3/15.4、§28、§35.4、§36.1 | 4个调用点、复用边界、token和Frame ownership已覆盖 |
| Game Surface | §15.5、§26、§33/34、§36.3 | detection/binding/fingerprint/revision/等待竞态已覆盖 |
| Coordinate Space | §24、§26、§29 | page/game五层状态及六条转换路径已覆盖 |
| IPC | §4.3、§12、§16、§36、§38 | 37个工作台通道、validation、token和可信边界已覆盖 |
| Automation Assistant | §4.5、§15、§36.1、§38.3 | grant/sender-tab、运行/测试/取材/坐标/surface已覆盖 |
| Tests | §7、§19、§30、§42 | 26个专项文件、现有保护面和架构测试空洞已覆盖 |

结论：用户点名范围全部有源码或测试证据，没有以 README 替代源码调查。`workspace/store` 在当前实现中不是独立 Automation store：Blockly workspace属于组件实例，草稿在 renderer localStorage，权威 installed package在 main Service/磁盘；这一“没有独立 store”的结论本身也是审计事实。

## 46. 最终可复算数字基线

| 指标 | 最终值 | 审计口径 |
|---|---:|---|
| Step Type | 34 | `AutomationStep` union成员 |
| Condition Type | 6 | `AutomationCondition` union成员 |
| Blockly Block Type | 43 | Blockly定义数组对象 |
| Runtime Step switch cases | 34 | `AutomationRunner.execute`的Step分派 |
| Service describe cases | 34 | Step消息穷举 |
| Schema asset traversal cases | 33 | 34 Step中排除无资产的默认/结构处理口径，详见§25 |
| Image专属/含Image Step | 8 | §24固定口径 |
| Text专属 Step | 2 | wait/click text；不含Condition |
| Coordinate/Region专属 Step | 3 | click coordinate、move coordinate、random region |
| page/game显式条件点 | 10 | 排除CDP target type的`page`判断 |
| Driver protocol方法 | 23 | `AutomationDriver` interface |
| Automation范围直接capturePage调用点 | 4 | Driver 2 + Service 2 |
| OCR recognize调用点 | 2 | Driver runtime + Service offline |
| 工作台 Automation invoke channel | 37 | preload whitelist + registered handler面 |
| 页面助手 Automation IPC | 16 | `userscript:automation-*` handlers |
| Automation命名测试文件 | 26 | root Vitest 14 + Electron/build 12 |
| Automation命名测试行数 | 4,154 | 固定文件清单文本行 |
| 完整 Vitest基线 | 84 files / 558 tests | 2026-08-30 `npm test -- --run`通过 |

这些数字描述旧系统规模，不作为新架构KPI。新架构的约束是消除“新增Locator必须复制Action/Block/Runtime case”的增长模式，而不是单纯追求更少LOC。

## 47. 审计结论的证据类型

为避免 Phase 1 把推断当作事实，本文采用以下解释规则：

| 类型 | 含义 | 示例 |
|---|---|---|
| 事实 | 可由当前源码/测试直接复算 | 34 Step、`cancel()`只看probe/active |
| 平台合同 | 由Electron 11/BrowserView/站点兼容性决定 | debugger唯一owner、导航前detach |
| 隐式合同 | 正确性依赖，但类型/API没有表达 | Match必须对应Driver `lastFrame` |
| 推断 | 从多个事实推导，尚未有失败复现 | 多matcher实例使内存预算按实例叠加 |
| 风险 | 尚未造成已知故障，但迁移时可能放大 | OCR无response timeout阻塞global queue |
| 设计输入 | Phase 1必须回答，不是Phase 0决定 | RunHandle、Surface generation、permission模型 |

文中使用“可能”“存在风险”的位置不等同于已复现缺陷；使用“已确认”“当前执行”的位置均有源码路径支撑。

## 48. 架构债务优先级

### P0：新Core设计前必须冻结语义

1. Space/Surface/Point/Region的单位、generation和失效规则。
2. Frame/LocatedTarget/Match所有权，删除`lastFrame`隐式关联。
3. Operation/Run owner、取消完成和resource barrier。
4. Action × Locator正交边界，以及TextLocator与ReadText/ReadNumber分离。
5. capability metadata、用户授权与runtime enforcement分层。

### P1：底层实现阶段必须解决

1. surface resolution可取消且在session owner内运行。
2. BrowserView target变化主动invalidates dependent resources。
3. CaptureFrame共享与Vision/OCR同帧复用。
4. OCR response timeout、sidecar restart、队列取消和全局资源预算。
5. Capture/Surface/Input/Recognizer从BrowserView Driver拆出明确端口。

### P2：前端与清理阶段解决

1. Blockly镜像Step与block数量膨胀。
2. 工作台/页面助手重复的capture、OCR box与preview adapters。
3. status/cancel全局作用域与frontend run ownership。
4. 临时token/revoke/TTL统一。
5. 旧`.baoauto` v2、旧Step、page/game和compatibility adapter在Phase 8清零。

优先级表示依赖顺序，不表示P2可以永久保留。Phase 8断代约束仍要求删除旧世界。

## 49. Phase 1 开放问题清单

Phase 1不得在未回答这些问题时开始写实现：

### 49.1 Geometry / Space / Surface

1. 持久Point/Region使用normalized、logical unit还是带单位的可选表达？
2. ViewportSpace与SurfaceSpace的identity/generation如何序列化与运行时解析？
3. iframe/container/Canvas/Flash/Ruffle/用户区域是Surface kind、resolver hint还是可组合spec？
4. surface移动、缩放、消失、WebContents替换后，旧Frame/LocatedTarget如何失败？
5. rounding只允许在哪个边界发生，region far edge采用什么规则？

### 49.2 Locator / Action / Value

1. Locator统一返回Point、Region还是带anchor的`LocatedTarget`？
2. offset、anchor、search region、timeout/retry分别属于Locator、Query还是Action？
3. Click/Move/Drag如何只消费统一target而不switch locator kind？
4. TextLocator的匹配文本与ReadText返回文本如何分离？
5. ReadNumber的locale、货币、千分位、OCR纠错和解析失败语义是什么？
6. Value/Expression支持哪些primitive和运算，如何明确不演化成完整语言？

### 49.3 Context / Runtime

1. `with surface`、search region、timeout、variables的继承/遮蔽规则是什么？
2. run是否允许多tab/多package并行，Host policy与Core capability如何分开？
3. start返回完成Promise还是RunHandle；status/log/history如何绑定RunId？
4. cancel何时算完成；break/continue如何做静态scope校验？
5. locator miss、timeout、target stale、permission denied和recognizer unavailable如何分类？

### 49.4 Recognizer / Security / Package

1. CaptureFrame由谁拥有、何时复用、何时强制刷新？
2. Vision/TextRecognizer是否共享Host级并发与memory budget？
3. OCR候选引擎benchmark的模型、数据集、冷/热启动、包体和失败恢复门槛是什么？
4. JS API capability、用户批准、run grant和host enforcement如何建模？
5. 新`.baoauto`固定为`formatVersion: 3`是否批准；manifest如何同时容纳workflow/scripts/assets/profiles？
6. Blockly和JS共存时谁是入口，Recorder产物如何声明frontend/entrypoint？

这些问题将在 `automation-v2-core-design.md` 和对应ADR中逐项给出推荐方案、备选项与取舍；Phase 0只负责证明它们不能继续隐式存在。

## 50. Phase 0 最终结论

```text
Blockly / JSON / Assistant / .baoauto
                    ↓
        Workflow Schema (34 Step)
                    ↓
      AutomationService + Runner
                    ↓
 BrowserViewAutomationDriver (23 methods)
   ├─ Capture + Coordinate + Surface
   ├─ Vision + OCR result adaptation
   ├─ Input through transient CDP lease
   └─ Browser navigation / notification
                    ↓
         BrowserView / WebContents
```

当前系统已经具备可用的vision worker、OCR sidecar、固定viewport、CDP租约、package校验、Blockly编辑器和页面助手，但这些能力以Workflow Step和BrowserView Driver为聚合中心。主要复杂度不是某个文件太长，而是Action、target kind、coordinate space、capture frame和frontend语义没有正交边界。

因此重构顺序必须保持：先冻结Core语义，再做Coordinate/Surface，再做Action × Locator；不能先重画Blockly，也不能先把旧Step机械搬到新目录。Phase 0状态现提交为`Review`。用户批准本审计后，下一步进入Phase 1文档设计；仍然禁止实现产品代码。
