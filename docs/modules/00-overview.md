# BaoFlashBrowser 模块设计文档 · 总览

> 状态：按 v1.1.1 源码于 2026-08-23 重新核对。
> 本目录描述当前模块边界；历史设计与实施计划的时效说明见 [`docs/README.md`](../README.md)。
> 所有源码路径相对仓库根目录；行号随代码演进可能漂移，以语义为准。

## 模块清单

| 编号 | 模块 | 文档 | 主要源码域 |
| --- | --- | --- | --- |
| 01 | 浏览器外壳与标签管理 | [01-browser-shell-tabs.md](./01-browser-shell-tabs.md) | `src/main/modules/tabs.ts`、`window.ts`、`src/renderer/`、`src/preload/index.ts` |
| 02 | Flash 双引擎与旧站兼容 | [02-flash-engines-legacy-compat.md](./02-flash-engines-legacy-compat.md) | `flash.ts`、`ruffle-*`、`session-manager.ts`、`js-patch-*` |
| 03 | 视觉自动化平台 | [03-automation.md](./03-automation.md) | `src/main/modules/automation/`、`src/shared/automation/`、自动化工作台 |
| 04 | 用户脚本平台 | [04-userscripts.md](./04-userscripts.md) | `src/main/modules/userscripts/`、`src/webview-preload/userscripts/`、IPC |
| 05 | 密码存储、捕获与自动填充 | [05-password-vault.md](./05-password-vault.md) | `password-*`、`cdp-lease.ts`、`url-privacy.ts` |
| 06 | 下载系统 | [06-downloads.md](./06-downloads.md) | `download*.ts`、`aria2-*`、`download-path.ts` |
| 07 | 截图系统 | [07-screenshots.md](./07-screenshots.md) | `screenshot*.ts`、`screenshot-http.ts` |
| 08 | 会话恢复、诊断与内存监控 | [08-session-diagnostics.md](./08-session-diagnostics.md) | `session-recovery*`、`diagnostics.ts`、`memory-monitor.ts` |
| 09 | 构建、发布与测试管线 | [09-build-release-test.md](./09-build-release-test.md) | `build/`、`scripts/`、`tests/electron/`、`.github/`、esbuild/vite 配置 |

## 本文档统一约定

### 共同设计原则

1. **Electron 11.5.0 / Chromium 87 是硬边界**：所有兼容层（js-patch、CSS Fixer、web polyfill、CSP 回退）的存在理由都是为这条老内核补齐现代 Web 能力；**永不升级 Electron**。
2. **每标签独立渲染进程**：BrowserView 而非 BrowserWindow / `<webview>`；一个游戏崩溃不拖垮全部标签。
3. **IPC 双闸门**：preload 白名单（`on`/`invoke`/`send` 三张 Set）+ 主进程 zod 校验（`ipc-wrapper`）。
4. **数据单向流**：主进程是配置/下载/会话恢复的权威（electron-store），渲染层是 UI 与浏览器视口边界的权威（ResizeObserver → `tab:setBounds`）。
5. **安全按职责分层**：密码/CDP 走租约；脚本平台靠 grant + 门禁；自动化靠 beginAutomation 独占；路径统一过 `isPathWithinDirectory`。

### 文档模板

每份模块文档统一包含章节：

- **1 范围与目标** — 模块职责边界
- **2 静态结构** — 文件清单与职责表
- **3 核心流程** — 时序/状态机/数据流
- **4 数据模型与接口** — 关键类型、IPC/事件、持久化
- **5 安全边界与不变量** — 门禁、预算、防越权
- **6 兼容性与平台差异** — Win/Linux、Ruffle/PPAPI、i18n
- **7 测试策略** — 单元/Vitest、Electron smoke、探针
- **8 雷区与注意事项** — 对应 AGENTS.md 的硬约束
- **9 演进建议** — 非阻塞观察与可行的后续方向

### 术语

| 术语 | 含义 |
|---|---|
| `persist:` | BrowserView 标签使用的持久 session 分区，与 `defaultSession` 相互独立；老站登录态存放在此 |
| PPAPI 标签 | `contextIsolation: true, plugins: true`，原生 Flash 插件渲染 |
| Ruffle 标签 | `contextIsolation: false, plugins: false`，Ruffle WASM 在页面上下文运行 |
| HIDDEN_BOUNDS | `(-9999,-9999,1,1)`，非活动标签的占位视图边界 |
| `.baoauto` | 视觉自动化脚本包（manifest + workflow.json + assets/ 的 ZIP） |
| `BUNDLED_SCRIPTS` | 构建期以文本嵌入的两个内置用户脚本（CSS Fixer、自动化悬浮助手） |

## 历经主线（截至 v1.1.1）

1. `browserview 迁移` — 从 BrowserWindow/iframe 切换为每标签 BrowserView
2. 密码 CDP 捕获与自动填充
3. 用户脚本平台加固 + 运行时 preload 移植 + CSS Fixer / js-patch / has-pseudo
4. 截图安全流程（v17-v21 门控迭代）
5. 自动化平台 m0-m5（识别 → Blockly → 驱动 → 工作台 → 悬浮助手）
6. i18n 中英双语完成；自动化平台进入 1.1.0 发布基线
7. 1.1.1 增加实验 Flash/macOS 打包、`.baoauto` ZIP 导入导出，并修复积木/JSON 切换同步和完成提示状态转换

## 参考

- 全局约束：仓库 `AGENTS.md`（雷区逐条标注在各模块文档中）
- 架构手册：`docs/architecture-manual.md`（历史沿革与整体视角）
- 设计规格：`docs/superpowers/specs/`、`docs/superpowers/plans/`（具体功能的演进式设计记录）
