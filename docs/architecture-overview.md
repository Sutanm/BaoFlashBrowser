# 架构总览（现行）

> 状态：按 **1.1.2（2026-11-02）** 源码核对。取代
> `docs/archive/legacy/architecture-manual.md`（943 行的历史演进 + 补章混合手册）。
>
> 本文只描述**现行结构**与阅读入口；历史决策、早期 Jotai/webpack 时代的设计不在这里
> 复述，需要时查归档。模块细节以 [`modules/00-overview.md`](modules/00-overview.md)
> 及其下属文档为准。

## 1 进程与目录分层

| 层 | 目录 | 职责 |
| --- | --- | --- |
| 主进程 | `src/main/` | 窗口、标签、会话、Flash、密码、下载、自动化、代理、更新 |
| 主窗口 preload | `src/preload/` | `contextBridge` 暴露 `window.electronAPI`；三张 IPC 白名单 |
| BrowserView preload | `src/webview-preload/` | Ruffle 注入、用户脚本运行时、原生自动化助手、密码表单观察 |
| JS 沙箱 preload | `src/javascript-sandbox-preload/` | 自动化 JavaScript frontend 的隔离入口 |
| 渲染层 | `src/renderer/` | React 外壳、侧边栏、内部页、Zustand、typesafe-i18n |
| 共享层 | `src/shared/` | 类型、zod schema、自动化 core、URL 隐私、构建常量 |

`src/main` 内部：`index.ts`（启动编排）、`modules/`（业务）、`ipc/`（通道注册）、
`utils/`（纯函数与校验）。

## 2 启动顺序（`src/main/index.ts`）

关键点：**主窗口优先创建以保留首屏，可选模块懒加载以支持裁剪**。

1. 进程级：`registerSchemesAsPrivileged`（`ruffle-resource`、`bf-js-patch`、
   `bfb-github-module`）、单实例锁、`setupFlash`、`initializeSessionRecovery`、
   崩溃计数与 `preventCleanShutdownMark`。
2. `whenReady`：
   1. `registerUiLanguageIPC`
   2. `await initializeProxy(config.proxy)` —— 失败即 `app.quit()`
   3. 为 `defaultSession` 与 `persist:` 注册 Ruffle 协议
   4. `createWindow()`、`tabManager.setPreload(...)`
   5. 按 `MODULE_*` 懒 `require` 可选模块（userscripts / download / js-patch /
      github-module / passwords）
   6. `configureOptionalSessionServices` 与 `configureOptionalTabServices` 注入依赖
   7. `initSession()`（两个 session 的 UA、权限、webRequest、下载）
   8. 注册各 IPC、`jsPatch.setupJsPatchInterceptor()`、`registerAutomationV3IPC`
   9. `setImmediate` 内才启动 aria2 与自动化预热（不阻塞首屏）

核心模块**不反向 import** 可选模块；被裁掉的能力通过 `optionalServices` 为 undefined
自然失效，而不是靠运行时开关。

## 3 数据流与权威源

| 数据 | 权威源 | 渲染层角色 |
| --- | --- | --- |
| 标签状态 | `TabManager` + `tab:updated` 事件 | Zustand 镜像，仅消费 |
| 视口边界 | 渲染层 `computeBrowserViewBounds` | 唯一计算方，发 `tab:setBounds` |
| 下载记录 | 主进程 `download-state`（electron-store） | 启动一次 `download:list` + 事件驱动，**无 IndexedDB 镜像** |
| 配置 | 主进程 `config`（electron-store） | 表单编辑，保存后回读 |
| 密码条目 | 主进程加密库 | 列表经 IPC 获取，明文只在门禁后出一次 |
| 自动化运行状态 | `AutomationV3Service` | 轮询/事件展示 |
| 语言 / 主题 | 渲染层设置 + 主进程 `config.uiLanguage` / `nativeTheme` | 双轨，前者驱动 UI，后者驱动原生内容 |

原则：**凡主进程持续推送实时状态的数据，渲染层不得再用 IndexedDB + `useLiveQuery`
回灌推导**（09-04 下载事故的根因，见 06）。

## 4 IPC 与安全闸门

1. preload 三张 Set（`on` / `invoke` / `send`）限制可用通道；
2. 主进程 `createValidatedHandler` / `createHandler` + zod（`ipc-wrapper`）；
3. 敏感能力额外加窄桥：
   - 自动化页面助手：`automation-assistant:*`（原生）与 `userscript:automation-v3-*`
     （用户脚本），各自校验调用者身份；
   - 用户脚本：grant + `@connect` + 私网拦截；
   - 密码查看：`view-gate` 在解密前验证；
   - 文件操作：`isPathWithinDirectory` + 扩展名黑名单。

## 5 模块地图

| 编号 | 模块 | 文档 |
| --- | --- | --- |
| 01 | 浏览器外壳与标签 | [`modules/01-browser-shell-tabs.md`](modules/01-browser-shell-tabs.md) |
| 02 | Flash 双引擎与旧站兼容 | [`modules/02-flash-engines-legacy-compat.md`](modules/02-flash-engines-legacy-compat.md) |
| 03 | 视觉自动化 | [`modules/03-automation.md`](modules/03-automation.md) |
| 04 | 用户脚本 | [`modules/04-userscripts.md`](modules/04-userscripts.md) |
| 05 | 密码保险库与查看门禁 | [`modules/05-password-vault.md`](modules/05-password-vault.md) |
| 06 | 下载 | [`modules/06-downloads.md`](modules/06-downloads.md) |
| 07 | 截图 | [`modules/07-screenshots.md`](modules/07-screenshots.md) |
| 08 | 会话恢复、诊断与内存 | [`modules/08-session-diagnostics.md`](modules/08-session-diagnostics.md) |
| 09 | 构建、发布与测试 | [`modules/09-build-release-test.md`](modules/09-build-release-test.md) |
| 10 | 网络代理与连接诊断 | [`modules/10-network-proxy.md`](modules/10-network-proxy.md) |
| 11 | 语言、主题与更新检查 | [`modules/11-i18n-theme-update.md`](modules/11-i18n-theme-update.md) |

## 6 硬约束

1. **Electron 11.5.0 / Chromium 87 锁定**：PPAPI Flash 是产品前提，永不升级。
2. **BrowserView 而非 BrowserWindow/webview**：每标签独立渲染进程；BrowserView 永远
   置顶于渲染层，因此不能用悬浮 DOM 覆盖页面，只能做侧边栏或页内注入。
3. **两个 session**：主窗口用 `defaultSession`，标签用 `persist:`；任何 session 级配置
   都必须同时覆盖两者（webRequest、协议、下载、代理）。
4. **构建期裁剪**：`MODULE_*` 是编译常量，不是运行时开关；`build:minimal` /
   `build:no-automation` 等组合必须能独立构建并通过边界测试。
5. **诊断与日志脱敏**：密码、cookie、查询串、令牌不得进入日志或诊断报告。

## 7 阅读顺序建议

1. 本文 → 2. `modules/00-overview.md`（模块清单与主线）→ 3. 与你任务相关的模块文档 →
4. `AGENTS.md`（构建命令与雷区）→ 5. `PACKAGE.md`（发布）。
