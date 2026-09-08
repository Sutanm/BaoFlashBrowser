# 03 · Automation 2.0 平台

> 状态：按 2026-09-08 的 Automation 2.0 / `.baoauto` v3 源码核对。早期 M0–M5、旧 Step/Runtime/Driver 与包格式 v1/v2 只保留在历史设计文档中。

## 1 范围与目标

自动化平台控制应用内指定的 BrowserView 标签，不控制桌面或其他应用。它以统一的 Coordinate / Surface / Locator / Action / Capture Core 连接 Blockly 工作流、受限 JavaScript 和 Recorder，使用 OpenCV 模板匹配、颜色候选与结构复核、可选 OCR 定位可见目标，再向目标 `webContents` 发送可信输入。

密码捕获和自动化都需要 CDP；二者通过 `cdp-lease.ts` 和标签自动化句柄隔离。导航、引擎切换、取消与标签销毁都必须使旧上下文失效并完成资源回收。

## 2 当前结构

| 路径 | 职责 |
| --- | --- |
| `src/shared/automation/core/` | 几何、坐标空间、Surface、Locator、Action、Workflow IR、校验器和运行时 |
| `src/shared/automation/package-v3.ts` | `.baoauto` v3 manifest、frontend、profile 与素材元数据类型 |
| `src/shared/automation/javascript-api.ts` | 沙箱可调用的固定 `bao.*` API 合同 |
| `src/main/modules/automation/service-v3.ts` | 包管理、运行编排、状态日志、取材与识别测试 |
| `src/main/modules/automation/browserview-core-session.ts` | 将 Core registry 绑定到当前 BrowserView 的截图、识别、OCR、输入和页面操作 |
| `src/main/modules/automation/browserview-capture-service.ts` | 截图归一化、区域裁剪、FrameGeometry 与兼容帧复用 |
| `src/main/modules/automation/package-v3.ts` | v3 ZIP 解析/序列化、完整性、路径和预算校验 |
| `src/main/modules/automation/package-v3-repository.ts` | 已安装包的原子持久化；只接受 v3，不迁移旧包 |
| `src/main/modules/automation/automation-warm-start.ts` | OpenCV、颜色 Worker、OCR 和素材签名的共享预热/关闭 |
| `src/main/modules/automation/automatic-vision-matcher.ts` | 模板、颜色与结构复核的自动路由 |
| `src/main/modules/automation/javascript-*.ts` | JavaScript grant、能力 broker、host ports 与隔离沙箱 |
| `src/main/ipc/automation-v3.ipc.ts` | 主工作台 `automation-v3:*` IPC 与 zod 校验 |
| `src/main/ipc/automation-userscript-bridge.ipc.ts` | 页面悬浮助手的窄能力桥 |
| `src/renderer/components/automation/` | Automation 页面、Blockly v2 编辑器/codec 与样式 |
| `src/main/modules/userscripts/bundled-scripts/automation-frame-assistant.user.js` | 构建期嵌入的页面悬浮助手 |

旧的 `service.ts`、`runtime.ts`、`browserview-driver.ts`、`package.ts`、`assets.ts`、`automation.ipc.ts` 和旧 Blockly schema 已在 Phase 8 切换时删除，不应再作为扩展入口。

## 3 核心流程

### 3.1 编辑、安装与运行

```text
AutomationPage / 页面助手
  → preload 白名单 API
  → automation-v3 IPC / userscript 专用桥
  → AutomationV3Service
  → BrowserViewAutomationCoreSession
  → Workflow Runtime 或 JavaScript Sandbox
  → Core Action / Locator / Query registry
  → Capture / Vision / OCR / trusted Input
```

Blockly 编辑器直接编解码 `WorkflowDocumentV3`，不再维护旧 JSON/Step 运行时。包可同时包含 Blockly workflow、多个 JavaScript/TypeScript frontend、素材和 profiles；运行时显式选择 `frontendId`，可再选择 profile。TypeScript frontend 在进入沙箱前转译为 ES2019 JavaScript。

JavaScript frontend 只能调用冻结的 `bao.*` API。声明权限、安装时批准的 grant、宿主能力与单次运行预算逐层取交集；脚本不能直接访问 Node、Electron IPC、网络、文件系统或导航能力之外的宿主接口。

### 3.2 坐标、画面与截图

持久化坐标使用 `ratio` 或 `logical` 单位，并绑定明确的 Space/Surface generation；运行时解析为当前 BrowserView viewport 或视觉画面。窗口尺寸、缩放、导航或 WebContents 更换会刷新 generation，旧结果不能继续用于输入。

`BrowserViewCaptureService` 产生带 `FrameGeometry` 的不可变捕获帧。区域识别只捕获解析后的显示区域，并保留其在完整 viewport 中的几何映射；同一 Context 可复用兼容帧。图片、文字和颜色结果始终绑定产生它们的帧，输入前再映射到当前 viewport。

### 3.3 视觉与 OCR

图片定位支持显式 `template`、`color` 和 `auto`。`auto` 由颜色候选召回与结构复核共同判定，失败诊断候选不会反向变成成功结果。图片组共享场景帧，颜色 Worker 池共享只读像素；取材素材记录 viewport transform，运行时优先尝试由参考倍率推导的快速档，未命中再进入邻档和常规回退。

OpenCV 与颜色 Worker 默认预热。OCR 通过 provider 合同接入 Paddle sidecar；标准发布不捆绑 OCR，`build:*:ocr` 才准备并校验运行时和模型。OCR、Worker、取材 token、测试场景和沙箱调用都有超时、数量或资源上限。

### 3.4 `.baoauto` v3

包根目录包含 `manifest.json`，并可包含 `workflow.json`、`scripts/`、`assets/` 和 `profiles/`。`manifest` 固定 `format: "baoauto"`、`formatVersion: 3`，列出 frontends、features、permissions 与每个内容项的 SHA-256；grant 独立保存在包外，manifest 不能自行授权。

默认预算为：压缩包 64 MiB、最多 2,000 项、单项 16 MiB、解压总量 128 MiB。所有路径必须是安全的相对 POSIX 路径；绝对路径、反斜杠、盘符、空段、`.` 和 `..` 都会被拒绝。旧 v1/v2 包明确返回 `UNSUPPORTED_FORMAT`，不会静默迁移或重写。

## 4 主要接口

- 包与 frontend：`automation-v3:list/get/create/open/install/export/delete`、`update-workflow`、`upsert-script`、`delete-script`、`set-main-entry`。
- 执行：`automation-v3:status/start/cancel`；状态覆盖 `idle/preparing/running/cancelling/completed/failed/cancelled`。
- 素材与测试：`asset-preview`、`import-assets`、`import-asset-folder`、`delete-asset`、`capture-asset-frame`、`save-captured-asset`、图片/文字现场及离线场景测试。
- 页面助手只通过 `automation-userscript-bridge.ipc.ts` 暴露的专用操作访问自动化，不复用主窗口的完整 IPC 面。

## 5 安全边界与不变量

1. 只有当前有效 BrowserView/WebContents 可以持有自动化句柄；导航前先释放 CDP，旧 generation 的目标必须拒绝。
2. Workflow registry 在运行前冻结，并受节点数、循环、时长、变量和历史事件预算约束；取消完成意味着资源 barrier 已完成。
3. JavaScript 权限由声明、持久 grant 和宿主能力共同限制；包内 profile/manifest 不能提升权限。
4. 包内容必须经过 schema、完整性散列、路径和大小校验；仓库写入使用临时文件加原子 rename。
5. 自动识图仍是实验能力。账号、交易、删除等不可逆业务动作不能因为定位成功而省略人工确认。

## 6 构建与验证

- 单元层：`npm test -- --run`，重点覆盖 `tests/automation-core-*`、`automation-workflow-*`、`automation-package-v3*`、能力服务、视觉策略、取消和 grant。
- 重型层：`npm run test:integration`，覆盖 OpenCV worker 与 OCR sidecar。
- Electron 专项：`npm run probe:automation-input`、`probe:automation-viewport`、`probe:automation-viewport-engines`、`probe:automation-visual`、`probe:automation-authoring`、`probe:automation-scale-reference`、`probe:automation-js-sandbox`、`probe:automation-flash`。
- 页面助手：`npm run test:userscripts-admin`；修改其源码后必须先重新生成对应 smoke bundle。
- 发布边界：`npm run build:full` 含完整自动化；`build:minimal` 和 `build:no-automation` 不得携带自动化代码、Worker 或 UI；OCR 只进入显式的 OCR 发布命令。
- PPAPI 插件注册可自动验证，但真实游戏渲染、识图与可信输入仍需人工发布回归。

## 7 雷区

1. 不要重新引入旧 Step union、旧 Driver 或 v2 包兼容层；Automation 2.0 的唯一生产入口是 Core + v3。
2. 页面助手是构建期文本资产；只改源文件而复用旧 `dist/main.js` 或 `release/tests/` 会测试到陈旧代码。
3. 页面浮窗在截图和识别时保持显示，不能靠反复隐藏规避干扰；取材时应移出目标区域或禁用助手。
4. 图片组取消是资源屏障；只有并行 Worker 全部退出后才可报告取消完成或开始下一次识别。
5. 不把离线 benchmark、插件注册或测试夹具结果冒充真实 PPAPI 游戏端到端验收。
