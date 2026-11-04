# BaoFlashBrowser 模块设计文档 · 总览

> 状态：按 **1.1.2（2026-11-02）** 源码核对。取代 `docs/archive/modules-v1/00-overview.md`。
> 现行/历史文档边界见 [`docs/README.md`](../README.md)；源码路径相对仓库根目录，
> 行号会漂移，以语义为准。

## 模块清单

| 编号 | 模块 | 文档 | 主要源码域 |
| --- | --- | --- | --- |
| 01 | 浏览器外壳与标签管理 | [01-browser-shell-tabs.md](./01-browser-shell-tabs.md) | `tabs.ts`、`window.ts`、`src/renderer/`、`src/preload/index.ts` |
| 02 | Flash 双引擎与旧站兼容 | [02-flash-engines-legacy-compat.md](./02-flash-engines-legacy-compat.md) | `flash.ts`、`ruffle-*`、`session-manager.ts`、`js-patch-*`、`js-compiler.ts`、`github-module-*` |
| 03 | 视觉自动化平台 | [03-automation.md](./03-automation.md) | `src/main/modules/automation/`、`src/shared/automation/`、工作台与页面助手 |
| 04 | 用户脚本平台 | [04-userscripts.md](./04-userscripts.md) | `src/main/modules/userscripts/`、`src/webview-preload/userscripts/`、IPC |
| 05 | 密码存储、捕获与查看门禁 | [05-password-vault.md](./05-password-vault.md) | `password-*`、`keyring-*`、`view-gate-*`、`cdp-lease.ts` |
| 06 | 下载系统 | [06-downloads.md](./06-downloads.md) | `download*.ts`、`aria2-*`、`src/main/utils/download-*` |
| 07 | 截图系统 | [07-screenshots.md](./07-screenshots.md) | `screenshot*.ts`、`screenshot-http.ts` |
| 08 | 会话恢复、诊断与内存监控 | [08-session-diagnostics.md](./08-session-diagnostics.md) | `session-recovery*`、`diagnostics.ts`、`memory-monitor.ts` |
| 09 | 构建、发布与测试管线 | [09-build-release-test.md](./09-build-release-test.md) | `build/`、`scripts/`、`tests/`、`.github/`、esbuild/vite 配置 |
| 10 | 网络代理与连接诊断 | `10-network-proxy.md`（本轮新建） | `proxy.ts`、`download-proxy.ts`、`src/shared/types/proxy.ts` |
| 11 | 界面语言、主题与更新检查 | `11-i18n-theme-update.md`（本轮新建） | `ui-language.ts`、`theme.ipc.ts`、`app-update.ts`、`src/renderer/i18n/` |

## 共同设计原则

1. **Electron 11.5.0 / Chromium 87 是硬边界**：所有兼容层（js-patch、GitHub 模块转译、
   CSS Fixer、Web API polyfill、CSP 回退）都是为这条老内核补齐现代 Web 能力；
   **永不升级 Electron**。
2. **每标签独立渲染进程**：BrowserView 而非 BrowserWindow / `<webview>`；一个游戏崩溃
   不拖垮全部标签。
3. **IPC 双闸门**：preload 白名单（`on`/`invoke`/`send` 三张 Set）+ 主进程 zod 校验
   （`ipc-wrapper`）。
4. **单一权威源**：配置、下载记录、会话标记、密钥状态归主进程（electron-store）；
   渲染层是 UI 与视口边界的权威（ResizeObserver → `tab:setBounds`）。实时状态不得
   另建 IndexedDB 镜像回灌（2026-09-04 下载事故的根因）。
5. **安全按职责分层**：密码/CDP 走租约；查看明文走门禁；脚本平台靠 grant + 窄桥；
   自动化靠 `beginAutomation` 独占；文件操作统一过 `isPathWithinDirectory`。
6. **语言与主题单一入口**：主进程 `uiText()` / `ui:get-language` 与渲染层
   typesafe-i18n 共用 `uiLanguage` 配置；主题经 `theme:set-source` 交给
   `nativeTheme`，由 Chromium 传播到所有 BrowserView。

## 文档模板

每份模块文档统一包含：1 范围与目标、2 静态结构、3 核心流程、4 数据模型与接口、
5 安全边界与不变量、6 兼容性与平台差异、7 测试策略、8 雷区、9 演进建议。
较小的模块（07/08/10/11）可合并 7/9 章。

## 术语

| 术语 | 含义 |
|---|---|
| `persist:` | BrowserView 标签使用的持久 session 分区，与 `defaultSession` 相互独立；老站登录态存放在此 |
| PPAPI 标签 | `contextIsolation: true, plugins: true`，原生 Flash 插件渲染 |
| Ruffle 标签 | `contextIsolation: false, plugins: false`，Ruffle WASM 在页面上下文运行 |
| HIDDEN_BOUNDS | `(-9999,-9999,1,1)`，非活动标签的占位视图边界 |
| `.baoauto` | 自动化 v3 脚本包（manifest + 可选 workflow、scripts、assets、profiles 的 ZIP） |
| `BUNDLED_SCRIPTS` | 构建期嵌入的内置用户脚本（CSS Fixer、自动化悬浮助手） |
| 原生助手 | `webview-preload` 直接安装的自动化浮窗，不依赖用户脚本授权 |
| 档位 A / C′ | 密码保险库的 wrap key 保护：A=OS keyring（Windows DPAPI），C′=本地可逆弱保护 |
| view-gate | 查看明文前的验证门禁：A 档系统凭据对话框，C 档自定义查看密码 |
| `BAO_MODULES` | 构建期能力裁剪（core / userscripts / automation / passwords / screenshot / download / diagnostics / memory-monitor / js-patch） |
| OCR provider | `auto` 依次探测 Tesseract（Win32 ia32）与 Paddle（Win64/Linux x64），都缺失时为 `unavailable` |

## 主线演进（截至 1.1.2）

1. BrowserView 迁移：从 BrowserWindow/iframe 切换为每标签独立 BrowserView。
2. 密码 CDP 捕获与自动填充；v2 保险库（无主密码，wrap key 分 A / C′ 两档）。
3. 用户脚本平台加固 + 运行时 preload 移植 + CSS Fixer / js-patch / has-pseudo。
4. 截图安全流程（v17–v21 门控迭代）与开发态调试 HTTP 口子。
5. 自动化 m0–m5：识别 → Blockly → 驱动 → 工作台 → 悬浮助手。
6. i18n 中英双语完成，自动化进入 1.1.0 发布基线。
7. 1.1.1：实验 Flash/macOS 打包、`.baoauto` ZIP 导入导出、积木/JSON 切换修复。
8. 1.1.2：Automation 2.0 原子切换（Core + v3 + Blockly v2 + JS 沙箱 + Recorder）、
   颜色/模板自动路由、跨缩放识别、`BAO_MODULES` 裁剪。
9. 09-11 工程治理：归档"虚假信心"测试、smoke 固定临时 userData、
   `scripts/smoke-bundles.cjs` 成为构件新鲜度唯一清单。
10. 09-21/22 密码两阶段：密钥失败路径 K1–K4（读路径零破坏、失败二分、亲和标签、
    惰性自愈）；查看门禁 V1–V5（CredUI + 查看密码 + 5 次锁 30 分钟）；
    捕获去重改为"同密码静默、变了才提示"。
11. 10-01 自动化编辑器与文档工具；CI 修复 Linux/Playwright/Electron 11 兼容。
12. 10-23 边界收紧：RPC 响应 schema、下载/密码类型、编辑器按需加载、设置迁移保留源数据。
13. 10-25 全局代理与连接诊断；GitHub 模块在现代浏览器语义下的恢复（`bfb-github-module:`
    转译 + 12 MiB/64 MiB 预算）。
14. 10-28 捕获重武装与后台输入时序；smoke 覆盖 document-start 模式。
15. 10-31 原生自动化助手（preload 直装、实时语言切换）、首次启动语言选择、
    主题与网页内容同步、手动稳定版更新检查。
16. 11-02 aria2 代理路由 + 统一下载目录设置；新标签搜索焦点修复；
    **1.1.2 正式包全部内置 OCR**（Win64/Linux Paddle，Win32 Tesseract x86）。

## 参考

- 全局约束：仓库 `AGENTS.md`（雷区逐条标注在各模块文档中）。
- 用户手册：`docs/automation-user-guide.md`、`docs/userscript-*-guide.md`、
  `docs/proxy-settings.md`。
- 事故与诊断记录：`docs/password-vault-failure-2026-09-20.md`、
  `docs/password-capture-diagnosis-2026-09-22.md`、
  `docs/search-layout-diagnosis-2026-11-02.md`。
- 带日期的设计与实施快照：`docs/archive/superpowers/`、`docs/archive/automation-v2/`
  （归档规则见 [`docs/archive/README.md`](../archive/README.md)）。
- 构建与发布：`docs/PACKAGE.md`、`docs/modules/09-build-release-test.md`。
