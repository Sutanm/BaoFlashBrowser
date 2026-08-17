# 01 · 浏览器外壳与标签管理

## 1 范围与目标

负责应用外壳（窗口、顶部栏、侧边栏、内部页）与**标签生命周期**。核心目标是：
- 每标签一个独立 `BrowserView` 渲染进程，崩溃隔离；
- renderer 是视口边界的唯一权威，BrowserView 始终与 UI 对齐；
- 引擎切换（PPAPI ↔ Ruffle）、休眠/恢复、缩放、静音、页内查找、右键菜单都经统一的 TabManager；
- 为自动化、密码填充、用户脚本提供标签级挂点（beginAutomation / registerView / did-session 事件）。

**边界**：不负责 Flash 加载（见 02）、脚本运行时（见 04）、密码捕获（见 05）。

## 2 静态结构

| 文件 | 职责 |
|---|---|
| `src/main/modules/tabs.ts` | `TabManager` 单例 —— 视图创建/销毁/激活/休眠、事件接线、自动化句柄、密码填充调度 |
| `src/main/modules/window.ts` | 主窗口创建，`loadFile`/dev server 加载策略，应用退出兜底 |
| `src/main/ipc/tabs.ipc.ts` | 标签 IPC：create/close/suspend/activate/navigate/zoom/mute/find/setBounds/noRuffle 模式 |
| `src/main/ipc/shortcut.ipc.ts` | 快捷键表驱动匹配、全局缩放、mouse-hook 原生钩子 |
| `src/main/ipc/window.ipc.ts` | 最小化/最大化/全屏/isMaximized |
| `src/preload/index.ts` | 主窗口 preload —— IPC 三白名单 + `window.electronAPI` 暴露 |
| `src/renderer/App.tsx` | React 根组件：bounds 计算、面板/内部页切换、快捷键分发 |
| `src/renderer/hooks/useTabManager.ts` | 渲染层标签状态机与 IPC 监听 |
| `src/renderer/hooks/useShortcut/useTheme/useDownloadListener/usePasswordListener.ts` | 键盘/主题/下载/密码监听 |
| `src/renderer/store/useTabsStore.ts` `useDataStore.ts` | zustand 标签与数据状态 |
| `src/renderer/services/browserview-bounds.ts` `tab-session.ts` `tab-suspension.ts` `history-state.ts` `db.ts` `toast.ts` | 边界计算、会话快照、休眠门控、历史合并、IndexedDB、Toast 队列 |
| `src/shared/types/tab.ts` `settings.ts` `ipc.ts` | 共享类型与主→渲染事件全集 |

## 3 核心流程

### 3.1 标签生命周期

```
Renderr                         Main
createTab ── tab:create ──► TabManager.create(tabId, url, {enabled, source})
                             ├─ 已存在 → 只更新 lastTargetUrl / 懒建视图
                             └─ 不存在 → 记 TabEntry → needsBrowserView(url)?
                                 ├─ 否(内部页) → 无视图，renderer 渲染 React 页面
                                 └─ 是 → _createView:
                                     new BrowserView({ preload, plugins:!isRuffle,
                                       contextIsolation:!isRuffle, nodeIntegrationInSubFrames:true,
                                       partition:'persist:' })
                                     registerView(wc.id, {mode, generation, token})
                                     setupSessionOnce(wc.session)
                                     _wireBrowserViewEvents(wc, tabId)
                                     loadURL(url)
switchTab ── tab:activate ──► 旧视图→HIDDEN_BOUNDS，新视图→rect
closeTab ── tab:close ──►  dispose(teardownCapture + removeBrowserView + destroy)
```

关键事件（`_wireBrowserViewEvents`）：
- `did-start-navigation`（主帧）→ `_detachDebuggerBeforeNavigate` + 清密码填充定时器 + `isLoading:true`；
- `dom-ready` → SWF 插件文档 `insertCSS`（html/body 100% 高修复）+ `isLoading:false`；
- `did-stop-loading` → 若不在自动化中 `setupCapture` + `_schedulePasswordFill`；
- `did-fail-load` → **绝不 `wc.stop()`**（会杀后登录跳转）；
- `render-process-gone` → 销毁视图、置 crashed、通知 renderer 展示崩溃恢复页；
- `new-window` → `preventDefault`，发 `tab:newwindow` 由 renderer 决定新开还是当前导航；
- `did-navigate`/`did-navigate-in-page` → 更新 lastTargetUrl、favicon（含 7k7k 特判）、canGoBack/Forward。

### 3.2 视口边界（bounds）单向流

renderer 是**唯一**计算方：`calcBounds` 读 `bvAreaRef.getBoundingClientRect()`；侧栏展开时将 `width` 向右侧多延伸侧栏宽度并由原生窗口裁剪，避免页面响应式 reflow；`ResizeObserver` + `window.resize` 触发；内部页/崩溃时 `setBounds(-9999,-9999,1,1)` 隐藏。主进程 `setBounds` 只作用于活动标签视图。

### 3.3 引擎切换 = 销毁重建

`setRuffleMode`：销毁旧 BrowserView → 改 `isRuffle/source` → 按原 URL 重建。所有事件回调都带 `_isCurrentWebContents(tabId, wc)` 守卫（token + wc.id + 映射表三重校验），防止旧视图晚到事件污染新视图。

### 3.4 休眠与恢复（opt-in）

10 分钟定时器 → `isTabEligibleForSuspension` 门控（开启设置 + 非 active/suspended/loading/audible/内部页）→ `tab.suspend` → 记入 `suspensionPromisesRef`；重新激活时 `ensureTabView` 先 await 该 promise，再 `tab.create(...)` 重建并恢复 zoomFactor/isMuted。

## 4 数据模型与接口

### 4.1 TabEntry（主进程）

```ts
{ id; browserView; isRuffle; ruffleSource?; lastTargetUrl; zoomFactor; muted; crashed }
```

### 4.2 渲染层 TabState（store）

`useTabsStore`：`{ tabs, activeTabId }`；TabState 含 `url/title/favicon/isLoading/canGoBack/canGoForward/isMuted/zoomFactor/ruffleMode/crashed/suspended`。

### 4.3 主→渲染事件（`src/shared/types/ipc.ts` 全集）

`tab:updated / tab:found / tab:load-error / tab:crashed / tab:newwindow / shortcut / navigate-url / download:progress / aria2:status / password:captured|changed|filled / userscripts:changed / automation:status-changed / ruffle:diagnostic / userscript:open-tab`。

### 4.4 preload 白名单

三张 Set 分别约束 `on`/`invoke`/`send`；`ALLOWED_INVOKE_CHANNELS` 覆盖 tab/config/dl/pwd/diagnostics/file/session/win/userscripts/screenshot/automation 全部通道；越界直接 reject + console.warn。

## 5 安全边界与不变量

- BrowserView webPreferences：`nodeIntegration:false`、`contextIsolation` 按引擎、`nodeIntegrationInSubFrames:true`（用户脚本子帧需要，见 04）、`spellcheck:false`、`partition:'persist:'`。
- tab:create 的 url 白名单：仅 `http/https/file/about:`（`tabs.ipc.ts` zod）。
- tab:setBounds 数值域：x/y∈[-10000,50000]、w/h∈[0,50000]。
- 自动化互斥：`beginAutomation` 仅允许**当前活动标签**，返回 token 化句柄，`assertCurrent` 防引擎切换/释放后误用；自动化期间暂停密码捕获，`release()` 恢复。
- 主渲染进程崩溃保护：3 次/30s 内自动 reload；超限 `preventCleanShutdownMark()` + quit。

## 6 兼容性与平台差异

- Win：spell-checker 垃圾词典目录问题 → `disable-features=WinUseBrowserSpellChecker`；`mouse-hook.exe` 处理 Flash 区域 Ctrl+滚轮缩放。
- Linux：`--no-sandbox` + GPU 三开关；`mouse-hook-linux`。
- 内部页：`about:newtab|userscripts|automation`（`needsBrowserView` 排除），对应 React 页面替代 BrowserView。

## 7 测试策略

- Vitest：`browserview-bounds.test.ts`、`tab-session.test.ts`、`tab-suspension.test.ts`、`history-state.test.ts`、`theme-toggle.test.tsx`、`toast*.test`、`url-utils.test.ts`。
- Electron smoke：`tests/electron/browserview-smoke.cjs`（BrowserView 生命周期）。
- 探针：`11-views.cjs`（真实 BrowserView 健康 + 子帧 badge）、`04-logs.cjs`。

## 8 雷区与注意事项

1. **debugger 附着时不得导航/刷新/前进后退**：一律先 `_detachDebuggerBeforeNavigate`（密码捕获与自动化共用 CDP）。
2. **`did-fail-load` 绝不 `wc.stop()`**：杀后登录重定向。
3. **sendSync 通道预注册**：`get-ruffle-mode`/`userscript:get-config` 必须在任何视图导航前注册 handler，否则 renderer IPC 累积损坏、后续导航挂死。
4. **BrowserView 事件必须过 current-WebContents 守卫**：引擎切换销毁重建后旧事件仍会到达。
5. **休眠永不触碰** active/loading/audible/内部页；重建必须恢复 engine/zoom/mute。

## 9 演进建议

- 标签数量下的内存水位：单页多图/多标签场景建议观察 `memory-monitor` 数据，完善休眠自动策略（目前仅 10 分钟 opt-in）。
- 右键菜单目前硬编码中文项：可接入 i18n（与 04 的 menu record 对齐）。
- `.husky/` 无生效 pre-commit：建议补齐 lint/typecheck 前置钩子（见 09）。