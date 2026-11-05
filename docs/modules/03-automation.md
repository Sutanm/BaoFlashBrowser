# 03 · 视觉自动化平台（Automation 2.0 / `.baoauto` v3）

> 状态：按 **1.1.2（2026-11-02）** 源码核对，取代 `docs/archive/modules-v1/03-automation.md`。
> 行号随代码演进会漂移，以语义为准；与旧文档冲突时以本文和源码为准。

## 1 范围与目标

自动化平台只控制**应用内指定的 BrowserView 标签**，不控制桌面或其他应用。它用统一的
Coordinate / Surface / Locator / Action / Capture Core 连接 Blockly 工作流、受限
JavaScript/TypeScript frontend 和 Recorder，使用 OpenCV 模板匹配、颜色候选与结构复核、
可选 OCR 定位可见目标，再向目标 `webContents` 发送可信输入。

密码捕获与自动化都需要 CDP：两者通过 `cdp-lease.ts` 互斥。不长期持有句柄的短时检查
可用 `transient-cdp-inspection.ts`（暂停密码捕获 → 取租约 → 执行 → 释放 → 恢复捕获），
但不要让短时检查与长期句柄叠租约。导航、引擎切换、取消和标签销毁都必须让旧
generation 失效并完成资源回收。

**边界**：截图原语见 07，密码侧 CDP 见 05；页面助手的用户脚本通道见 04，
原生通道（preload 直装）不依赖用户脚本的安装与授权。

## 2 静态结构

### 2.1 包、运行与工作台

| 路径 | 职责 |
| --- | --- |
| `src/shared/automation/core/` | 几何、坐标空间、Surface、Locator、Action、Workflow IR、校验器与运行时 |
| `src/shared/automation/package-v3.ts` | `.baoauto` v3 manifest、frontend、profile 与素材元类型 |
| `src/shared/automation/javascript-api.ts` | 沙箱可调用的固定 `bao.*` 合同 |
| `src/main/modules/automation/service-v3.ts` | 包管理、运行编排、状态日志、取材与识别测试 |
| `src/main/modules/automation/package-v3.ts` | v3 ZIP 解析/序列化、完整性、路径与预算校验 |
| `src/main/modules/automation/package-v3-repository.ts` | 已安装包的原子持久化；只接受 v3 |
| `src/main/modules/automation/browserview-core-session.ts` | 把 Core registry 绑到当前 BrowserView 的截图、识别、OCR、输入与页面操作 |
| `src/main/modules/automation/browserview-capture-service.ts` | 截图归一化、区域裁剪、`FrameGeometry` 与兼容帧复用 |
| `src/main/ipc/automation-v3.ipc.ts` | 主工作台 `automation-v3:*` IPC 与 zod 校验 |
| `src/renderer/components/automation/` | Automation 页面、Blockly v2 编辑器/codec、游戏画面字段与样式 |

旧 `service.ts`、`runtime.ts`、`browserview-driver.ts`、`package.ts`、`assets.ts`、
`automation.ipc.ts` 和旧 Blockly schema 已在 Phase 8 删除，不是扩展入口。

### 2.2 视觉、OCR 与调度

| 路径 | 职责 |
| --- | --- |
| `automatic-vision-matcher.ts` | 模板、颜色与结构复核的自动路由 |
| `vision-service.ts`、`vision-worker-matcher.ts`、`vision-worker.cjs` | OpenCV 模板匹配与 Worker |
| `vision-scheduler.ts` | 视觉任务串行队列，深度上限 64；超出抛 `QUEUE_FULL` |
| `color-*.ts`（matcher / tracker / worker / structure） | 颜色定位、连续追踪、结构复核与 Worker 池 |
| `native-image-template-provider.ts` | 基于 `nativeImage` 的 `AutomationTemplateProvider` 实现 |
| `game-surface-detector.ts` | CDP 探测可绑定的游戏画面：`flash` / `ruffle` / `canvas` / `frame`，带指纹 |
| `transient-cdp-inspection.ts` | 短时 CDP 检查封装：暂停密码捕获、取租约、执行后恢复 |
| `region-change-detector.ts` | 区域像素变化轮询（基线/前帧），用于"等画面变化" |
| `asset-keyout.ts` | 素材背景剥离与抠图键控 |
| `automation-warm-start.ts` | OpenCV、颜色 Worker、OCR 与素材签名的共享预热/关闭 |
| `ocr-provider.ts` | OCR 引擎选择（见 3.3） |
| `bao1-ocr-sidecar-engine.ts` | Paddle 与 Tesseract 共用的 `BAO1` 子进程协议客户端 |
| `paddle-ocr-sidecar-engine.ts`、`tesseract-ocr-sidecar-engine.ts` | 两种运行时探测与启动 |
| `text-recognition-service.ts` | 定位文字、读全文、读数字三种语义 |

### 2.3 JavaScript 沙箱与页面助手

| 路径 | 职责 |
| --- | --- |
| `javascript-*.ts`（grant / broker / host-ports / sandbox-host） | 权限 grant、能力 broker、宿主端口与隔离沙箱 |
| `src/webview-preload/native-automation-assistant.ts` | **原生助手**：preload 直接安装，不依赖用户脚本授权 |
| `src/webview-preload/automation-assistant-api.ts` | 助手侧 `baoAutomation` API 封装 |
| `src/main/modules/userscripts/bundled-scripts/automation-frame-assistant.user.js` | 助手 UI 的唯一源码（同时供原生与用户脚本两条通道） |
| `src/main/ipc/automation-assistant-bridge.ts` | 两条通道共享的 11 个窄端点 |
| `src/main/ipc/automation-userscript-bridge.ipc.ts` | 用户脚本通道，按 `scriptId` 授权 |

## 3 核心流程

### 3.1 编辑、安装与运行

```text
AutomationPage（主窗口 preload 白名单）
  / 页面助手（窄桥，不经过主窗口白名单）
  → automation-v3:* / automation-assistant:* / userscript:automation-v3-*
  → AutomationV3Service
  → BrowserViewAutomationCoreSession
  → Workflow Runtime 或 JavaScript Sandbox
  → Core Action / Locator / Query registry
  → Capture / Vision / OCR / trusted Input
```

Blockly 编辑器直接编解码 `WorkflowDocumentV3`，不维护旧 JSON/Step 运行时。包可同时包含
Blockly workflow、多个 JavaScript/TypeScript frontend、素材和 profiles；运行时显式选择
`frontendId`，可再选 profile。TypeScript 在进入沙箱前用 `ts.transpileModule` 转为
ES2019（`module: None`、`strict: true`），存在 Error 级诊断即拒绝运行。

运行状态机固定为 `idle → preparing → running → completed | failed | cancelled`，
取消时先进入 `cancelling`，资源 barrier 完成后才落到 `cancelled`。运行日志最多保留
200 条，`system` 标记区分系统消息与脚本自身日志；英文界面只本地化系统消息。

### 3.2 坐标、画面与截图

持久化坐标用 `ratio` 或 `logical` 单位，并绑定明确的 Space/Surface generation；运行时
解析为当前 viewport 或视觉画面。窗口尺寸、缩放、导航或 WebContents 更换会刷新
generation，旧结果不能继续用于输入。

`browserview-capture-service.ts` 产生带 `FrameGeometry` 的不可变捕获帧；区域识别只捕获
解析后的显示区域，并保留其在完整 viewport 中的映射；同一 Context 可复用兼容帧。
图片、文字和颜色结果始终绑定产生它们的帧，输入前再映射到当前 viewport。

游戏画面由 `game-surface-detector` 通过 CDP 枚举，候选带 `fingerprint`；绑定后若指纹
或 id 变化则视为失效，必须重新检测。

### 3.3 视觉与 OCR（1.1.2 现状）

图片定位支持 `template`、`color`、`auto`。`auto` 由颜色候选召回 + 结构复核判定，失败
诊断候选不会反向变成成功结果。图片组共享场景帧，颜色 Worker 池共享只读像素；取材
记录 viewport transform，运行时优先由参考倍率推导快速档，未命中再进邻档与常规回退。

**OCR 在 1.1.2 是正式制品的默认能力，不再是可选项**：

| 平台 / 架构 | 默认发布包 | 引擎 | 运行时目录（开发态 → 打包后） |
| --- | --- | --- | --- |
| Windows x64 | `build:win64` | Paddle Inference / PP-OCRv3 | `native/ocr/win64` → `resources/native/ocr` |
| Windows ia32 | `build:win32` | Tesseract 5.3.0 x86 | `native/ocr/win32` → `resources/native/ocr` |
| Linux x64 | `build:linux` | Paddle Inference / PP-OCRv3 | `native/ocr/paddle/linux-x64` → `resources/native/ocr/paddle` |
| macOS x64（实验） | `build:mac` | 无 | — |

`ocr-provider.ts` 的 `auto` 顺序是 Tesseract → Paddle，但两者都有平台硬门槛：
Tesseract 要求 `win32 + ia32`，Paddle 要求 `win32/linux + x64`，因此每个平台实际只会
命中一个。都不可用时返回 `UnavailableOcrEngine`，报"当前安装包未包含 OCR 运行时"——
这是运行时兜底（自定义构建、不支持的架构、被裁剪的运行时），不代表 1.1.2 的默认发布形态。
请求与启动超时各 30 秒。

OCR 语义分成三个**独立**操作，不要混用：

- `locate`：按 `contains` / `exact` + 最低置信度找文字框，返回位置；
- `readText`：读出区域内全部文字并拼接；
- `readNumber`：从文本中提取第一个数值。

取材/测试场景另提供 `locateBestRecognized`：即使未达判定条件，也返回最接近的候选
（相似度下限 0.25）用于诊断，但**不会**把它当成匹配成功。

### 3.4 `.baoauto` v3

包根有 `manifest.json`，可含 `workflow.json`、`scripts/`、`assets/`、`profiles/`。
manifest 固定 `format: "baoauto"`、`formatVersion: 3`，列出 frontends、features、
permissions，并通过 `integrity`（路径 → 散列）记录每个内容项的完整性；grant 独立存在
包外，manifest 不能自行授权。

预算：压缩包 64 MiB、最多 2,000 项、单项 16 MiB、解压总量 128 MiB。路径必须是安全的
相对 POSIX 路径；绝对路径、反斜杠、盘符、空段、`.`、`..` 全部拒绝。v1/v2 包返回
`UNSUPPORTED_FORMAT`，不静默迁移。

## 4 主要接口

主工作台（`automation-v3:`）：

- 包与 frontend：`list` / `get` / `create` / `open` / `install` / `export` / `delete`、
  `update-workflow`、`validate-workflow`、`upsert-script`、`delete-script`、`set-main-entry`；
- 执行：`status` / `start` / `cancel`；
- 素材与测试：`asset-preview`、`import-assets`、`import-asset-folder`、`delete-asset`、
  `capture-asset-frame`、`save-captured-asset`、`open-test-scene`、在线/离线
  `test-asset*` 与 `test-text*`；
- 其他：`read-clipboard`、`show-assistant`。

页面助手（同一份 UI，两条 transport）：

| 通道 | prefix | 授权条件 |
| --- | --- | --- |
| 原生（preload 直装） | `automation-assistant:` | `identity === 'native'` 且 wc 对应某个标签 |
| 用户脚本（内置脚本） | `userscript:automation-v3-` | `scriptId` 通过 `automationAssistantAllowed` |

两条通道共享 11 个端点：`list` / `status` / `start` / `cancel` / `asset-preview` /
`warm` / `capture` / `save-capture` / `match` / `ocr` / `surfaces`。原生助手只在
`http(s)|file` 主框架安装，监听 `ui:language-changed` 做**实时**语言切换。

## 5 安全边界与不变量

1. 只有当前有效 BrowserView/WebContents 可以持有自动化句柄；导航前先释放 CDP，旧
   generation 的目标必须拒绝。
2. Action / Query registry 在运行前 `freeze()`；工作流受节点数、循环、超时与变量预算
   约束；取消完成意味着资源 barrier 已完成。
3. JavaScript 只能调用安装时批准且落在 grant 集合内的能力（越界抛 `PERMISSION_DENIED`）；
   包内 profile/manifest 不能自行提权。脚本不能直接访问 Node、Electron IPC、网络、
   文件系统。
4. 包内容必须过 schema、完整性散列、路径和大小校验；仓库写入使用临时文件 + 原子 rename。
5. 助手两条通道都不复用主窗口完整 IPC 面；原生助手不安装用户脚本、不发布特权 API 到页面。
6. 自动识图仍是实验能力。账号、交易、删除等不可逆动作不能因定位成功而省略人工确认。

## 6 构建、发布与验证

```bash
npm run build                      # 模块裁剪 + 可选资产 + main/preload + renderer
npm run build:win64                # 全模块 + Paddle OCR（= build:win64:ocr）
npm run build:win32                # 全模块 + Tesseract OCR（= build:win32:ocr）
npm run build:linux                # 全模块 + Paddle OCR（= build:linux:ocr）
npm run build:win64:standard       # 无 OCR 包
npm run prepare:ocr                # Paddle（Windows）
npm run prepare:ocr:paddle-linux   # Paddle（Linux，需 Docker + bsdtar）
npm run prepare:ocr:tesseract      # Tesseract（Win32，需 MSVC x86）
```

> CI 的 package job 直接调用 `build:win64` / `build:win32` / `build:linux`
> （`.github/workflows/ci.yml:69,75,81`），因此正式制品必然带 OCR；无 OCR 的
> `build:win64:standard` / `build:win32:standard` / `build:linux:standard` 只用于手动构建。

- `build:automation-assistant` 维护内置助手源码的 `@updateHash`；`build-optional-assets`
  在启用 `automation` 时调用它，不要求同时启用 userscripts。`build/native-assistant-i18n.mjs`
  是 esbuild 插件：编译期按 `src/shared/automation/assistant-ui-en.json` 生成英文变体，
  原生通道运行时按 locale 选择中/英实现。
- `BAO_MODULES`：`core`、`userscripts`、`automation`、`passwords`、`screenshot`、
  `download`、`diagnostics`、`memory-monitor`、`js-patch`。原生助手只依赖 `automation`；
  把助手作为**内置用户脚本**注册（可在管理页编辑/禁用）还需要 `userscripts`。
- 单元层：`npm test -- --run`，覆盖 core、workflow、package-v3、视觉策略、grant 与取消。
- 重型层：`npm run test:integration`（OpenCV worker、OCR sidecar）。
- 专项探针：`probe:automation-input`、`probe:automation-viewport`、
  `probe:automation-viewport-engines`、`probe:automation-visual`、
  `probe:automation-authoring`、`probe:automation-scale-reference`、
  `probe:automation-js-sandbox`、`probe:automation-flash`。
- 助手：`npm run test:userscripts-admin`（构建期资产）与 `test:userscripts`。
- 发布边界：`build:minimal` / `build:no-automation` 不得携带自动化代码、Worker 或 UI。

## 7 雷区

1. 不要重新引入旧 Step union、旧 Driver 或 v2 包兼容层；唯一生产入口是 Core + v3。
2. 助手源码在构建期由 esbuild 插件转成 preload 模块（中英两版）；只改源文件而复用旧
   `dist/main.js` 会测到陈旧代码。
3. 页面浮窗在截图与识别时保持显示，不能靠反复隐藏规避干扰；取材时应移出目标区域。
4. 图片组取消是资源屏障；并行 Worker 全部退出后才可报告取消完成或开始下次识别。
5. 短时 CDP 检查不要裸调 `debugger.attach`：用 `inspectWithPasswordCapturePaused`
   （暂停密码捕获 → 取自动化妆约 → 执行 → 释放 → 恢复捕获）。注意生产中的游戏画面
   检测由 `game-surface-detector` 自持租约（`acquireAutomationCdpLease` + watchdog），
   不要再叠一层租约。
6. 助手中文文案必须同步登记到 `assistant-ui-en.json`：原生助手在编译期做中→英替换，
   缺词条会直接抛 `Missing English assistant text`，构建失败。
7. 不把离线 benchmark、插件注册或夹具结果冒充真实 PPAPI 游戏端到端验收。

## 8 已知边界与演进

- 视觉调度是串行队列（深度 64），超出直接返回 `QUEUE_FULL`，没有自适应降级或动态扩容；
  高并发调用方需降低并发或分批提交。
- 助手两条通道共用一份 UI 源码，改 UI 时两条路径都要回归（原生 + 内置脚本）。
- macOS 实验包没有可用 OCR 引擎，`auto` 会落到 `unavailable`；文档与 UI 不应暗示可用。
