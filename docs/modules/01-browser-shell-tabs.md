# 01 · 浏览器外壳与标签管理

> 状态：按 **1.1.2（2026-11-02）** 源码核对，取代 `docs/archive/modules-v1/01-browser-shell-tabs.md`。

## 1 范围与目标

负责应用外壳（无边框窗口、顶部栏、侧边栏、内部页）与**标签生命周期**：

- 每标签一个独立 `BrowserView` 渲染进程，崩溃隔离；
- 渲染层是视口边界的唯一权威，BrowserView 始终与 UI 对齐；
- 引擎切换（PPAPI ↔ Ruffle）、休眠/恢复、缩放、静音、页内查找、右键菜单统一经
  `TabManager`；
- 为自动化、密码填充、用户脚本提供标签级挂点（`beginAutomation` / `registerView`）。

**边界**：Flash 加载见 02，脚本运行时见 04，密码捕获见 05，代理初始化见 10，
语言/主题/更新见 11。

## 2 静态结构

| 文件 | 职责 |
| --- | --- |
| `src/main/modules/tabs.ts` | `TabManager` 单例：视图创建/销毁/激活/休眠、事件接线、自动化句柄、密码填充调度 |
| `src/main/modules/window.ts` | 无边框主窗口、dev/dist 加载策略、`ready-to-show` 8s 兜底、渲染层错误注入 |
| `src/main/ipc/tabs.ipc.ts` | `tab:*` IPC：create/close/suspend/activate/navigate/zoom/mute/find/setBounds |
| `src/main/ipc/shortcut.ipc.ts` | 表驱动快捷键 + 全局缩放 + 原生 `mouse-hook` |
| `src/main/ipc/window.ipc.ts` | 最小化/最大化/全屏/isMaximized |
| `src/renderer/App.tsx` | 外壳根组件：bounds 计算、面板切换、快捷键分发、语言/主题同步 |
| `src/renderer/components/overlays/FirstRunLanguageGate.tsx` | 首次启动语言选择（就绪后才挂载外壳，避免 BrowserView 遮住对话框） |
| `src/renderer/hooks/useTabManager.ts` | 标签状态机、IPC 监听、休眠定时器、崩溃恢复 |
| `src/renderer/services/browserview-bounds.ts` | `computeBrowserViewBounds`：区域 + 侧栏宽度 |
| `src/renderer/store/useTabsStore.ts` / `useDataStore.ts` | Zustand 标签与数据状态 |
| `src/preload/index.ts` | 主窗口 preload：`on`/`invoke`/`send` 三张白名单 |

## 3 核心流程

### 3.1 标签生命周期

```text
createTab ── tab:create ──► TabManager.create(tabId, url, {enabled, source})
                             ├─ 已存在 → 更新 lastTargetUrl；若缺视图且需要则懒建
                             └─ 新建 TabEntry → needsBrowserView(url)?
                                 ├─ 否（about:newtab|userscripts|automation|blank）→ 无视图
                                 └─ 是 → _createView:
                                     new BrowserView({ preload, plugins:!isRuffle,
                                       contextIsolation:!isRuffle, nodeIntegration:false,
                                       nodeIntegrationInSubFrames:true,
                                       backgroundThrottling:false,
                                       spellcheck:false, partition:'persist:' })
                                     registerView(wc.id, {mode, generation, token})
                                     setupSessionOnce(wc.session)
                                     loadURL(url)
activate ──► 旧视图 HIDDEN_BOUNDS，新视图 rect（自动化中则重新应用 viewport）
close    ──► 释放自动化句柄 + teardownCapture + 移除并销毁视图
```

### 3.2 事件接线（`_wireBrowserViewEvents`）

| 事件 | 行为 |
| --- | --- |
| `did-start-navigation`（主帧） | 置 loading、`_detachDebuggerBeforeNavigate`、清填充定时器、允许加载后重挂捕获 |
| `dom-ready` | SWF 文档 `insertCSS` 修复 100% 高度；结束 spinner；刷新标题/favicon |
| `did-stop-loading` | 非自动化时 `setupCapture`；调度自动填充；500ms 后补刷元数据 |
| `did-fail-load` | 忽略 `-3`（ERR_ABORTED）；不清 URL、**绝不 `wc.stop()`**；emit `tab:load-error` |
| `render-process-gone` | 销毁视图、标记 crashed、emit `tab:crashed` |
| `new-window` | `preventDefault()`，emit `tab:newwindow` 由渲染层决定新开/当前导航 |
| `did-navigate(-in-page)` | 更新 `lastTargetUrl`、favicon（含 7k7k 特判）、前进/后退状态、SPA 通知脚本 |
| `media-started-playing` / `media-paused` | 更新 `isAudible`（休眠门控依赖它） |
| `context-menu` | 原生菜单，**已接入 `uiText()` 双语** |

### 3.3 视口边界

渲染层唯一计算方：`bvAreaRef.getBoundingClientRect()` → `computeBrowserViewBounds`。
侧栏展开时宽度**向右延伸** `sidebarWidth`（页面不 reflow），由原生窗口在右侧裁剪。
`ResizeObserver` + `window.resize` + `findBarVisible` 触发；面积 ≤0 时发
`setBounds(-9999,-9999,1,1)`。主进程只对活动标签应用 rect，其余保持 `HIDDEN_BOUNDS`。

**侧边栏常驻挂载**（`App.tsx` 的 `sidebarPhase`）。三态：

| 状态 | 表现 |
| --- | --- |
| `open` | 340px，`width` 走 240ms transition |
| `closing` | 0 宽 + 内部淡出/左移，组件仍可见，播完才进 collapsed |
| `collapsed` | 0 宽 + `visibility: hidden`（退出 Tab 顺序与绘制），**不卸载** |

为什么常驻：卸载后再打开要重新挂载 + 首次布局/栅格，实测打开动画开头恒定有 ~75ms
一帧都出不来（宽度序列 `0,48,72,297…`，时间驱动的动画直接从 72 跳到 297）。常驻后
第二次及以后的打开最大帧间隔只有 **17ms**。

已知残留：**每次启动后的第一次**打开仍有 ~75ms 停顿——那是侧栏内容（收藏列表）的
首次布局+栅格，0 宽或 `visibility:hidden` 时浏览器根本不做，所以挪不到启动时。
试过三条路都无效（已回退）：挂载后延迟起动画（2 rAF / requestIdleCallback）、
启动时用 `opacity:0` + `position:absolute` 预热一帧、把收藏图标换成占位图。

用 CDP tracing 拆开过这 75ms（工具 `tools/devtools-spike/sidebar-jank-trace.cjs`，
原始 trace 落 `artifacts/sidebar-jank-trace.json`）：

- **主线程最长 slice 只有 4.3ms** —— 卡的不是 JS，也不是布局；
- **GPU 进程 `CrGpuMain` 上有一个 71ms 的 GPUTask**，内部
  `RasterDecoderImpl::DoEndRasterCHROMIUM` 占 69.8ms，同时 ANGLE worker 在编译着色器。
  也就是**首栅格化**，第二次打开走瓦片缓存所以只要 17ms。

逐项拆解（同一台机器、同一探针，首开的最大帧间隔）：

| 条件 | 首开最大间隔 |
| --- | --- |
| 原样（12px 圆角 + `3px 0 9px` 模糊投影） | 76ms |
| 去掉模糊投影 | 31ms（投影 ≈ 45ms） |
| 再去掉圆角 | 17ms（圆角 ≈ 14ms） |

圆角 + `overflow:hidden` 会强制一层遮罩；模糊投影在 DPI 150% 下按 1.5 倍半径重算。
注意投影那 3~9px 落在 `x ≥ 340` 的区域，**页面标签下被原生视图盖住**，只有新建标签页
看得到——所以换掉它视觉损失很小。

宽度动画用 `transition` 而不是 `@keyframes`：keyframes 每次都从 0/340 重来，开合互相
打断必然跳一下；transition 从当前计算值出发。键帧 `sidebar-panel-enter/exit` 与
`sidebar-inner-exit` 已删除。

### 3.4 引擎切换 = 销毁重建

`setRuffleMode` 销毁旧视图 → 改 `isRuffle/source` → 按当前 URL 重建。所有回调都过
`_isCurrentWebContents`（token + `wc.id` + 映射表三重校验），防止旧视图晚到事件污染
新视图。

### 3.5 休眠与恢复

渲染层 10 分钟定时器 + `settings.suspendInactiveTabs` 开关；门控：非 active、非
suspended、非 loading、非 audible。`tab.suspend` 只销毁主进程视图；再次激活时
`ensureTabView` 等待挂起的 suspend promise，再 `tab.create` 重建并恢复 zoomFactor /
muted。主进程 `suspend()` 对 active 标签直接拒绝。

### 3.6 崩溃与主渲染进程保护

`render-process-gone` → 置 crashed 并通知渲染层展示恢复页。主窗口渲染进程自身崩溃时，
30s 窗口内累计计数：超过 3 次才 `preventCleanShutdownMark()` 后退出，之前每次延迟
500ms 自动 reload（见 08）。

### 3.7 键盘焦点归属（两层）

#### 第一层：文档焦点（外壳 → 页面）

BrowserView 是**独立渲染进程**，键盘焦点只能由两条路进入：用户点击其矩形（原生命中测试）
或主进程显式 `webContents.focus()`。因此外壳侧提交导航后必须显式交还焦点：

- `TabManager.focusActive()`（`tabs.ts`）→ IPC `tab:focusActive` → preload
  `tab.focusActive()`；`activeId` 无视图时返回 `false`（新标签页阶段正常）。
- 调用点两处，缺一不可：
  1. `useTabManager.handleNavigate`，**导航提交的同一 tick**；
  2. `useTabManager` 的 `isLoading` 转 false 时**再补一次**——实测新文档提交过程中
     视图会丢焦点（导航后 ~200ms `wc.isFocused()===false`，事后 `focus()` 可稳定保持）。
     该补调在 `document.activeElement` 是输入框/可编辑区时跳过，绝不打断地址栏输入。
- 日志 `[Tabs] focus-active tab=… wc=… focused=…`。
- 切标签（`activate()`）**不**抢焦点：Ctrl+Tab 切换时用户可能正在地址栏输入。

#### 第二层：元素焦点（PPAPI 插件）—— 已知限制，不做

文档拿到焦点**不等于**插件拿到键盘：PPAPI `<embed>/<object>` 必须成为所在文档的
`activeElement`，否则按键落在 `document.body`（真机实测 `first keydown tag=BODY`）。
而游戏常在**跨域 iframe** 内（`news.7k7k.com` → `web.7k7k.com`），主 frame 的 JS 摸不到它。

曾经实现过一条"每帧预加载自行聚焦插件"的链路（`plugin-focus.ts` + 同步 IPC 握手 +
顶层 iframe 焦点帧推进），能把状态做到：

```
顶层 activeElement = IFRAME     子帧 activeElement = OBJECT/EMBED     子帧 hasFocus = true
```

**但按键仍然不进插件**。结论：Chromium 的 PPAPI 内容区焦点由**可信鼠标事件**授予，
`element.focus()` 只能改变 `activeElement`，不能让它接管键盘——手动点一下游戏即可，
程序化聚焦不行。需要真实手势这一点决定了唯一可行的替代是"往游戏里投一次合成点击"，
而那是真的点在游戏画面上（MMO 里会触发寻路/选中），产品上不接受，故**整条链路已回退**。

留档的四条实测（跨域夹具 + 真实 SWF，探针见 `.git/bao-probe/`，未入库）：

| 假设 | 结果 |
|---|---|
| `embed.focus()` 能让插件成为 `activeElement` | ✅ 同源夹具：聚焦后合成按键 target = `EMBED` |
| 父帧 `postMessage` 能唤醒子帧 isolated world 里的预加载监听 | ❌ 预加载确实在该帧运行（DOM 标记可证），但 message 事件没到 isolated world |
| 元素焦点 + 焦点帧推进足以收键盘（真机） | ❌ ack `tag=OBJECT focused=true`、顶层 `activeElement=IFRAME`，按键仍落 `BODY` |
| `webContents.sendInputEvent` 能投递到跨域子帧 | ❌ 键盘只到顶层文档；鼠标事件子帧完全收不到 |
| CDP `Input.dispatchMouseEvent` 能投递到跨域子帧 | ✅ 子帧记录 `mousedown target=EMBED` |

**若将来要捡回来**：`git show 3b63746` / `3cff69f` 含完整实现（含那个会误伤广告 iframe
的尺寸匹配启发式；日志里见过 `frame-holder iframe=1140x150` 把焦点推进广告位）。

## 4 数据模型与接口

- `TabEntry`（主）：`{ id, browserView, isRuffle, ruffleSource?, lastTargetUrl,
  zoomFactor, muted, crashed }`。
- `TabState`（渲染）：`url/title/favicon/isLoading/canGoBack/canGoForward/isMuted/
  zoomFactor/ruffleMode/crashed/suspended/isAudible`。
- 主要主→渲染事件：`tab:updated`、`tab:found`、`tab:load-error`、`tab:crashed`、
  `tab:newwindow`、`download:progress`、`aria2:status`、`password:*`、
  `ruffle:diagnostic`、`ui:language-changed`、`shortcut`、`userscript:open-tab`。
  完整清单以发送点为准，`src/shared/types/ipc.ts` 只覆盖类型化的一部分。
- preload 三张 Set 分别约束 `on` / `invoke` / `send`，越界 reject + warn。
  语言与主题通道在白名单内：`ui:set-language`、`theme:set-source`。

## 5 安全边界与不变量

- BrowserView：`nodeIntegration:false`；`contextIsolation` 与 `plugins` 按引擎；
  `nodeIntegrationInSubFrames:true` 仅为子帧脚本运行时；`partition:'persist:'`。
- `tab:create` URL 白名单：仅 `http/https/file/about:`（zod）。
- `tab:setBounds` 数值域：x/y ∈ [-10000, 50000]，w/h ∈ [0, 50000]。
- 主窗口自身只允许加载 dev `http://localhost:5173/` 或打包后的 `file:`；其余导航
  `preventDefault` 并记 warn。
- 自动化句柄只发给当前活动标签，`assertCurrent` 防引擎切换/释放后误用。
- 主渲染进程的 CSP 禁止内联脚本，早期错误钩子在 `did-start-loading` 注入。

## 6 平台、语言与主题

- Win：`mouse-hook.exe` 处理 Flash 区域的 Ctrl+滚轮；spellcheck 关闭。
- Linux：`--no-sandbox` + GPU 三开关；`mouse-hook-linux`。
- 首次启动：`FirstRunLanguageGate` 先读渲染层 `settings.language`；缺失才显示选择框。
  选择结果写 IndexedDB，并只在外壳就绪后才挂载 `AppInner`。
- 运行时切换：`App` 在 locale 变化时 `invoke('ui:set-language')`，主进程写
  `config.uiLanguage` 并广播 `ui:language-changed`，原生助手据此实时换语言。
- 主题：`theme:set-source` → `nativeTheme.themeSource`，由 Chromium 传播到所有
  BrowserView（含 `matchMedia`），不逐个视图下发。
- 快捷键：Tab 管理（Ctrl+T/W/Tab/1-8）、导航（F5/Ctrl+R/Esc/Ctrl+L/Alt+D）、
  功能（F11/F12/Ctrl+D/H/F/S/P/U/N、Ctrl+Shift+Delete）、缩放（Ctrl+=/-/0）。
  Flash/iframe 区域另有 `before-input-event` 兜底，主进程再叠一层 `globalShortcut` 缩放。

## 7 测试

- Vitest：`browserview-bounds.test.ts`、`tab-session.test.ts`、
  `tab-suspension.test.ts`、`tab-initial-state.test.ts`、`theme-toggle.test.tsx`、
  `first-run-language.test.tsx`、`toast*.test.tsx`。
- Electron smoke：`tests/electron/browserview-smoke.cjs`。
- Playwright：`tests/e2e/app-shell.spec.ts`、`first-run-language.spec.ts`。
- 探针：`11-views.cjs`（真实 BrowserView 健康 + 子帧 badge）、`04-logs.cjs`。

## 8 雷区

1. **debugger 附着时不得导航/刷新/前进/后退**：一律先 `_detachDebuggerBeforeNavigate`
   （密码捕获与自动化共用 CDP）。
2. **`did-fail-load` 绝不 `wc.stop()`**：会杀掉登录后重定向。
3. **`isLoading` 在 `dom-ready` 结束**，不要改回 `did-stop-loading`：广告/游戏 iframe
   慢时会让 spinner 长时间不消失。
4. **sendSync 通道预注册**：`get-ruffle-mode`、`userscript:get-config` 必须在任何视图
   导航前注册，否则渲染层 IPC 累积损坏、后续导航挂死。
5. **BrowserView 事件必须过 current-WebContents 守卫**：引擎切换销毁重建后旧事件仍会到达。
6. **休眠永不触碰** active/loading/audible；重建必须恢复 engine/zoom/mute。
7. 首次启动语言门必须在**外壳挂载之前**完成，否则 BrowserView 会盖住对话框。

## 9 演进建议

- 休眠策略目前只有"固定 10 分钟 + 四条件"，缺少按内存水位的自适应；可结合 08 的
  `memory-monitor` 数据再评估（非阻塞）。
- `tab:setBounds` 仍是整块矩形，没有按设备像素比做亚像素对齐；150% DPI 下的边缘
  可能出现 1px 缝，需实机对比后再决定是否处理。
