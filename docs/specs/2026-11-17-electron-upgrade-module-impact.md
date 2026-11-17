# Electron 11 → 38/39（Chromium 138 / 140 / 142）模块影响评估

- 状态：评估（未实施，不含代码改动）
- 日期：2026-11-17
- 基线：`electron 11.5.0` / Chromium `87.0.4280.141`（`package.json` 实测）
- 目标：E37 = Chromium 138、E38 = Chromium 140（自编译内核已端到端出帧）、E39 = Chromium 142
- 关联文档：
  - `docs/specs/2026-11-15-forward-version-feasibility.md`（版本梯度、140 移植进度 §1.14.x）
  - `docs/specs/chromium87-resize-gutter-fix.md`（resize 黑边）
  - `docs/specs/2026-11-14-electron138-flash-port.md`（138 基线）

---

## 0. 结论先行

1. **升级本身不强制迁移 `WebContentsView`。** `BrowserView` 在 v39.2.6 里仍然存在（标注 deprecated），`win.addBrowserView()` 也仍在，实现就是 `contentView.addChildView(browserView.webContentsView)`。迁移是技术债清理，不是升级前置条件。
2. **真正的硬阻塞只有三处**：`new-window` 事件（22.0 移除，**静默失效**）、渲染进程沙箱默认开启（20.0，主 preload 会白屏）、PPAPI 命令行开关在 Chromium 140 已不存在（Flash 注册与版本伪装都会失效）。
3. **`setAutoResize` 在 Electron ≥30 已变成 JS 实现**（`win.on('resize')` → `setBounds`），Electron 11 那条原生同步跟随（`native_window_views.cc::OnWidgetBoundsChanged`）不存在了。这与 resize 黑边是两件事，但会互相影响。
4. **最大工作量不在视图层，在 DevToolbox（M97 前端 × 140 后端）和 Flash 注册层**；窗口/标签层反而是可控的。
5. **142 相对 140 的应用层增量≈0**，差别全在内核：`ChannelHandle` 迁移 + 自带的 viz 黑边补丁（39.2.6+）。应用侧可以最后再挪。

---

## 1. 评估方法与本仓库盘点

结论都基于三类证据：Electron v39.2.6 的 `docs/` 与 `lib/` 源码、Chromium 140 的 `content_switches.cc`、本仓库代码实读。

| 指标 | 数值 | 说明 |
| --- | --- | --- |
| `BrowserView` 引用 | **130 处 / 25 个源文件** | 最密集：`tabs.ts`(36)、automation 4 个文件、`devtoolbox-host.ts`(8)、`index.ts`(4) |
| 涉及 `BrowserView` 的测试 | **58 个文件** | 迁移的真实成本在这里，不在产品代码 |
| `vi.mock('electron')` 的测试 | 24 个文件 | 视图 API 改名会波及 |
| 原生依赖模块 | **0 个** | 依赖全是 JS/WASM（opencv-js、blockly、ws、zod…）→ **无 ABI 重编**，这是升级最大的顺风 |
| 主 preload 的 Node 依赖 | `import path` + `__dirname` | `src/preload/index.ts:2`、`:123` → 沙箱风险（§2.2） |
| DevTools 前端版本 | M97，被降级到 chrome87 | `scripts/build-devtools-frontend.cjs:4` |
| `new-window` 监听 | 1 处 | `src/main/modules/tabs.ts:707` |

---

## 2. 三个硬阻塞（不改就跑不起来或功能静默消失）

### 2.1 `webContents.on('new-window')` —— Electron 22.0 已移除 🔴

| | |
| --- | --- |
| 位置 | `src/main/modules/tabs.ts:707`：`wc.on('new-window', (event, url) => { event.preventDefault(); this.send('tab:newwindow', { url }); })` |
| 依据 | breaking-changes：`## Breaking API Changes (22.0)` → `Removed: WebContents new-window event`，替代为 `webContents.setWindowOpenHandler()` |
| 危害形态 | **不报错、不警告**，监听器永远不触发。所有 `window.open`、`target="_blank"`、Flash 的 `navigateToURL(..., "_blank")` 都变成"点了没反应"，而且是最难查的那类（代码看起来完全正常） |

改法（行为等价，`deny` 即原来的 `preventDefault`）：

```ts
wc.setWindowOpenHandler(({ url, disposition }) => {
  if (this._isCurrentWebContents(tabId, wc)) {
    this.send('tab:newwindow', { url, disposition });
  }
  return { action: 'deny' };
});
```

实测重点：`about:blank` + 脚本写入的弹窗（老游戏站的登录/充值窗口常用）、`postBody` 表单提交、Flash 右键菜单里的"在新窗口打开"。

### 2.2 渲染进程沙箱默认开启（Electron 20.0）🔴

| | |
| --- | --- |
| 依据 | `web-preferences.md`（v39）：`sandbox` … *"Default is `true` since Electron 20"* |
| 现状 | `src/main/modules/window.ts:119-126` 的 `webPreferences` **没有 `sandbox` 键** → 在 38/39 上自动变成 `true` |
| 直接后果 | 主 preload `src/preload/index.ts:2` `import path from 'path'`、`:123` `path.join(__dirname, 'webview-preload.js')`。沙箱 preload 里 **没有 `__dirname`，`require` 只有 electron/events/timers/url 白名单** → 外壳 preload 抛异常 → 整个 UI 白屏 |

两条路，按"最小改动优先"排序：

| 方案 | 做法 | 取舍 |
| --- | --- | --- |
| A（推荐先做） | `window.ts` 显式 `sandbox: false` | 一行，保持 11 的现状与安全面不变；代价是外壳 renderer 仍有 Node（本来就如此） |
| B（更干净） | 去掉 preload 对 `path`/`__dirname` 的依赖（路径由主进程经 `additionalArguments` 或 IPC 传） | 能顺势开沙箱，但要动 preload 契约，建议单独一批做 |

**不受影响的部分**（已核对）：`src/webview-preload/*` 只用 `process.isMainFrame`（沙箱可用），`require('./userscripts/bootstrap')` 在 `esbuild.main.config.mjs:86` 已被内联成单文件，不依赖运行时 `require` 相对路径。

### 2.3 PPAPI 命令行开关在 Chromium 140 已消失 🔴（与内核联动）

本次全文检索 Chromium `140.0.7339.41` 的 `content/public/common/content_switches.cc`：

- `flash` / `ppapi` / `disable-flash-sandbox` / `ppapi-flash-path` / `ppapi-flash-version` / `register-pepper-plugins`：**全部不存在**
- 只剩 `allow-command-line-plugins`（注释：*Allows plugins to be loaded in the command line for testing.*）

对照本仓库三处调用：

| 位置 | 调用 | 140 上的实际行为 |
| --- | --- | --- |
| `src/main/modules/flash.ts:179` | `appendSwitch('ppapi-flash-path', pluginPath)` | 未知开关，**静默忽略** → 插件不注册 |
| `src/main/modules/flash.ts:180` | `appendSwitch('ppapi-flash-version', resolution.version)` | 同上 → **站点版本门伪装失效** |
| `src/main/index.ts:117` | `appendSwitch('disable-flash-sandbox')` | 同上 → 沙箱策略回到默认 |

两个必须记住的点：

1. **`ppapi-flash-version` 不是"随手写的版本号"，是刻意伪装**（`MEMORY.md`：恒取 `config.flashVersion` = `34.0.0.330`，用来过老站的版本门）。140 上如果只剩真实版本 `29.0.0.171`，一批老站会直接拒绝进入游戏。因此这条路要么在内核里把开关恢复回来，要么把伪装挪到 `navigator.plugins` 的 preload shim（见 §5.3）。
2. 你们的内核已经补回了 `--register-pepper-plugins`（`2026-11-14-electron138-flash-port.md:106`、可行性文档 §1.14.4）。**建议把 `ppapi-flash-path` / `ppapi-flash-version` / `disable-flash-sandbox` 与它同批恢复**，应用层代码就不用分叉（同一份 `flash.ts` 同时服务 11 和 38+）。

---

## 3. `BrowserView` → `WebContentsView`

### 3.1 先纠正一个前提

| 版本 | `BrowserView` | 依据 |
| --- | --- | --- |
| Electron 11（现役） | 独立实现 | — |
| Electron 30+ | **弃用，成为 `WebContentsView` 的 JS 包装** | breaking-changes (30.0) `Deprecated: BrowserView` |
| Electron 39（v39.2.6） | **仍然存在且可用** | `docs/api/browser-view.md` 仍在；`lib/browser/api/browser-window.ts` 里 `addBrowserView` → `this.contentView.addChildView(browserView.webContentsView)` |

所以：**"34+ 必须迁 WebContentsView"这个说法不成立**，142 也不会因为不迁而跑不起来。迁移的正当理由只有三条：弃用警告、布局/可见性更可控（`setVisible`、`setBorderRadius`、`setBackgroundColor`）、以及未来版本真的要删。

### 3.2 API 对照表

| 现在（BrowserView） | WebContentsView | 备注 |
| --- | --- | --- |
| `new BrowserView({ webPreferences })` | `new WebContentsView({ webPreferences })` | 参数同形 |
| `win.addBrowserView(v)`（`tabs.ts:522`、`devtoolbox-host.ts:159`、`tabs.ts:1081`） | `win.contentView.addChildView(v)` | **追加 = 置顶**；重复 add 会重排到顶层 |
| `win.removeBrowserView(v)`（`tabs.ts:815/1024`、`devtoolbox-host.ts:215`） | `win.contentView.removeChildView(v)` | 不是子视图时是 no-op（比 BrowserView 版更宽容） |
| `v.setBounds()` / `getBounds()` | 同 | 相对父视图 |
| `v.setAutoResize({ width, height })`（`tabs.ts:536`） | **没有对应 API** | 见 §3.3-1 |
| 屏外隐藏 `HIDDEN_BOUNDS`（-9999） | `v.setVisible(false)` | 见 §3.3-2 |
| `win.getBrowserViews()` | `win.contentView.children` | 需自行过滤（窗口自身 webContents 视图也在里面） |
| `win.setTopBrowserView(v)` | 再次 `addChildView(v)` | — |
| （无） | `v.setBorderRadius(n)` / `v.setBackgroundColor(c)` | 可用它压掉 resize/切换时的白闪 |

### 3.3 五个本仓库特有的坑

**1）`setAutoResize` 已经是 JS，不是原生 —— 这条最容易被忽略**

v39 的 `lib/browser/api/browser-view.ts` 里，`ownerWindow` 的 setter 做的是：

```ts
w.on('resize', this.#resizeListener = this.#autoResize.bind(this));
```

即：**Electron 11 里那条"窗口 WM_SIZE 同步遍历 BrowserView 调 AutoResize"（`native_window_views.cc::OnWidgetBoundsChanged`）已经不存在**，改成窗口 `resize` 事件里算 delta 再 `setBounds`。

- 影响：跟手比 11 慢一个 JS 任务（约 1 帧）；`tabs.ts:528-536` 那段引以为据的注释在 38/39 上**已失效**，需要改写。
- 与黑边的关系：view 落后 1 帧 → 露出的那条是**外壳 renderer** 的画面，不是黑。Chromium 138+ 的 256px 对齐 + buffer 复用又会把外壳自身的 gutter 压小，所以观感大概率比 87 好；但仍需真机验证（见 §8）。
- 迁移到 WebContentsView 后必须自己实现；**不要等渲染层 IPC**（`tab:setBounds`），那会把 11 就踩过的坑重踩一遍。推荐主进程持有一份 insets（标题栏高度、左栏宽度），在 `win.on('resize')` 里同步算 bounds。

**2）屏外隐藏 vs 可见性**

`HIDDEN_BOUNDS`（`tabs.ts` 顶部常量，`{x:-9999,y:-9999}`）在 11 上是"把视图挪出屏幕"。现代版本建议 `setVisible(false)`：省一次离屏合成、也让 capture 的语义更明确。但**自动化的隐藏页截图依赖 capturer-count 机制**：`screenshot.ts:97` 的 `incrementCapturerCount(size, stayHidden)` 与 `capturePage(rect, { stayHidden: true })` 要配对；这条在 38/39 上要单独冒烟（见 §8）。

**3）层序：抽屉 DevTools 与新建标签会互相盖住**

- `devtoolbox-host.ts:159` 追加抽屉视图 → 在顶层
- 之后 `tabs.ts:522` 新建标签再追加 → **标签盖住抽屉**
- 11 上同样存在，但 `BrowserView` 时代靠 `setBrowserView`/`setTopBrowserView` 的隐式顺序掩盖了；`contentView.addChildView` 时代必须显式排序

建议迁移时一次性定义层序：`活跃标签视图 → 抽屉 DevTools 视图 → 页面内提示层`，并在"新建标签/切换标签/开抽屉/关抽屉"四个动作后重排。

**4）WebContents 释放：`destroy()` 未文档化**

`devtoolbox-host.ts:223` 用 `view.webContents.destroy?.()` 兜底（注释写着"Electron 11 的 d.ts 没有声明 destroy"）。v39 的 `web-contents.md` 只保证 `close([opts])`，没有 `destroy` → 升级后这个兜底会变成 no-op，**WebContents 泄漏回归**。改为 `close({ waitForBeforeUnload: false })`。

**5）侧边栏补偿依赖"子视图被父视图裁剪"**

`src/renderer/services/browserview-bounds.ts:20` 让视图宽度 = 区域宽 + 侧边栏宽（超出右边界，靠窗口裁剪），目的是"侧边栏开合时网页 viewport 宽度不回流"。`WebContentsView` 作为 `contentView` 的子视图同样被裁剪，机制成立；差别是**裁剪后露出的底色由视图自己决定**，需要显式 `setBackgroundColor`，否则切换/裁切瞬间会看到不受控的底色。

### 3.4 工作量

| 路线 | 内容 | 估时 |
| --- | --- | --- |
| **不迁**（推荐先走这条） | 只修 §3.3-1（`setAutoResize` 语义 + 注释）、§3.3-4（`close()`），并补一条主进程 resize 跟随 | 0.5~1 天 + 回归 |
| **迁** | 上述全部 + 130 处引用改名 + 层序管理 + 58 个测试文件跟进 | 3~5 天 + 回归 2 天 |

---

## 4. 模块影响矩阵（138 / 140 / 142 三版对比）

图例：🔴 阻塞（不改即坏） / 🟡 行为变更（要验） / 🟢 基本无影响 / ⚪ 应用层无差别（差异在内核）

| 模块 | 关键受影响点 | 138 | 140 | 142 | 级别 |
| --- | --- | --- | --- | --- | --- |
| 窗口外壳 `window.ts` / `TopBar` | `frame:false`、`thickFrame` 默认值、`hookWindowMessage`、拖拽区 | 同 | 同 | 同 | 🟢 |
| 标签与视图 `tabs.ts` | `new-window`、`setAutoResize`、`canGoBack/goBack`、`plugins` | 🔴 | 🔴 | 🔴 | 🔴 |
| 会话 `session-manager.ts` | UA 硬编码 87、`registerBufferProtocol`、permission 名单 | 🟡 | 🟡 | 🟡 | 🟡 |
| 下载 `download*.ts` + aria2 | `will-download` 稳定 | 🟢 | 🟢 | 🟢 | 🟢 |
| 密码 `keyring*` / `view-gate*` / capture | 自研 DPAPI（外部进程）+ CDP，与 Electron 版本解耦；`safeStorage` 可选 | 🟢 | 🟢 | 🟢 | 🟢（可选优化） |
| 用户脚本 `webview-preload` | 沙箱默认开、`process.isMainFrame` 可用、GM API 是否碰 Node | 🟡 | 🟡 | 🟡 | 🟡 |
| 自动化 v3 / 视觉 | `capturePage`、`incrementCapturerCount`、`sendInputEvent`、CDP、隐藏页截图 | 🟡 | 🟡 | 🟡 | 🟡 |
| DevToolbox | M97 前端 × 现代后端、87 垫片、CDP 域差异、层序 | 🔴 | 🔴 | 🔴 | 🔴（最大） |
| 截图 / 诊断 / 内存 | `capturePage`、`getAppMetrics`、`process.getProcessMemoryInfo` | 🟢 | 🟢 | 🟢 | 🟢 |
| 构建分发 | electron-builder 26、自定义内核 `electronDist`、Node 22 | 🟢 | 🟢 | 🟢 | 🟢 |
| Flash 注册层 | `ppapi-flash-*` 开关、`plugins:true`、navigator.plugins 检测 | ⚪ | ⚪ | ⚪ | 🔴（内核联动） |

---

## 5. 逐模块要点

### 5.1 窗口外壳（`window.ts`、`TopBar`）

- `frame: false` 在 38/39 仍然有效，`thickFrame` 默认仍是 `true`（`thickFrame` 文档原文：*Use WS_THICKFRAME style for frameless windows on Windows, which adds the standard window frame*）。所以**顶部拉伸那套 `pt-2` 让出 8px 的方案继续成立**，不必因为升级重做。
- 可选现代化：`titleBarStyle: 'hidden'` 在 Windows/Linux 已支持（文档：*On Windows and Linux, when combined with `titleBarOverlay: true` it will activate the Window Controls Overlay, otherwise no window controls will be shown*）。它是官方支持的自定义标题栏路径，但**是否能让顶部原生拉伸不再依赖 pt-2 手法需要实测**——不要在升级同批改这个，属于独立优化项。
- `hookWindowMessage(WM_EXITSIZEMOVE)`（`window-drag-merge.ts:31`）仍是 Windows 专属 API，未变。

### 5.2 标签 / 视图（`tabs.ts`，1356 行）

- 🔴 `new-window`（§2.1）。
- 🟡 `wc.canGoBack()/goBack()`（`tabs.ts:680/694/717/964`）：Electron 33 起被 `webContents.navigationHistory.*` 取代，文档标 `_Deprecated_`（39 仍在）。建议同批迁移，避免下一轮再动。
- 🟡 `setAutoResize`（§3.3-1）：语义已变，注释要改；不迁 WebContentsView 也得改"依赖原生同步"的假设。
- 🟡 `backgroundThrottling: false`：从某版起**作用于整个宿主窗口的所有 WebContents**（PR #38924 记录）。我们的每个 tab 都关掉了节流，实际效果=整窗不节流，与现状一致，但要确认"挂起的标签是否仍吃 CPU"。
- 🟢 `plugins: !tab.isRuffle`：`webPreferences.plugins` 在 39 仍存在（`web-preferences.md` 原文：*plugins boolean - Whether plugins should be enabled. Default is false*），配合内核补回的 pepper 注册生效。
- 🟢 `nodeIntegrationInSubFrames: true`、`partition: 'persist:'`、`spellcheck: false`：均仍在。

### 5.3 会话 / 站点兼容（`session-manager.ts`）

- 🟡 **UA 硬编码 `Chrome/87.0.4280.141`**（`session-manager.ts:152`）。在 140 上这是"假版本"，而且 Client Hints（`Sec-CH-UA`）会由现代 Chromium 自动发送真实版本，两者不一致。建议策略：保留 87 的 UA（老站版本门友好），同时用 `session.webRequest.onBeforeSendHeaders` 把 `Sec-CH-UA*` 统一成同一主版本，避免自相矛盾。
- 🟡 **站点端 Flash 检测**：注入的 SWFObject 兼容脚本（`session-manager.ts:84/130-131`）走的是 `navigator.plugins["Shockwave Flash"]` + `navigator.mimeTypes`。现代 Chromium 的插件枚举被收窄过，**140 上是否仍暴露 pepper 插件必须实测**；若不暴露，应用层可在 preload 里补 `navigator.plugins`/`mimeTypes` 的只读伪装（不必改内核）。这条直接决定"老站是否会提示安装 Flash"，优先级等同 Flash 本身。
- 🟡 `protocol.registerBufferProtocol`（`github-module-service.ts:166`、`js-patch-service.ts:81`、`ruffle-session-protocol.ts:37`）：25 起弃用，39 **仍可用**，替换为 `protocol.handle`。不阻塞，建议后续批次统一迁。
- 🟡 `setPermissionRequestHandler` 只放行 `fullscreen`/`pointerLock`（`session-manager.ts:159`）。新版本新增的权限名（剪贴板写入、媒体、持久存储等）会被一律拒绝；对老游戏影响面需实测（尤其是"复制礼包码"这类交互）。
- 🟢 `webRequest.resourceType` 取值未变（`mainFrame`/`subFrame`/… 实测文档一致），`session-manager.ts:207` 不用改。

### 5.4 下载

`will-download`、`downloadItem.setSavePath/canResume`、`app.getPath('downloads')` 全在；aria2 走外部进程，与 Electron 无关。唯一要验的是"断点续传/暂停恢复"在 140 上的行为（`download-state` 以主进程为权威源，风险低）。

### 5.5 密码模块

- 🟢 自研 keyring（`keyring-win-dpapi.ts` 走外部进程调 DPAPI、`keyring-linux-secret-tool.ts` 走 `secret-tool`）**完全不受 Electron 版本影响**。
- 🟢 捕获/填充走 CDP（`password-capture.ts` / `password-fill.ts`），与视图类型无关；`cdp-lease.ts` 的租约逻辑也不受影响。
- 🟢 `view-gate-win.ts` 走系统凭据 UI，与 Electron 无关。
- 🟡 可选优化：Electron 15+ 提供 `safeStorage`（Windows 背后就是 DPAPI），理论上能删掉 `keyring-win-dpapi.ts` 那套外部进程。**但不建议在升级同批做**：它会动 A 档语义（`keyEncBackend` 亲和标签、transient/deterministic 失败分级）和存量 `password-autofill-key.json` 的兼容，属于独立立项的事。

### 5.6 用户脚本

- 🟡 沙箱默认开启（§2.2）后，preload 环境的 Node 面收窄。当前 `webview-preload/userscripts/gm-api.ts` 的请求是否全部经主进程（而非 `require('http')`）需要确认；`bootstrap.ts:30` 的"删除 Node 全局"清单在沙箱下会变成"本来就没有"，属无害。
- 🟡 `nodeIntegrationInSubFrames: true` 仍支持，但子帧 preload 在沙箱下的可用 API 更少；用户脚本若依赖 `GM_xmlhttpRequest` 的同步行为要复验。

### 5.7 自动化 v3 / 视觉

- 🟡 `capturePage` / `incrementCapturerCount` / `sendInputEvent` / `webContents.debugger`：都在，但语义细节要验：
  - `capturePage(rect, { stayHidden })` 在 39 文档中有 `stayHidden`/`stayAwake` 两个选项；
  - 隐藏/最小化窗口的合成行为受 occlusion 影响，**"最小化仍能出帧"这条产品承诺必须实测**（`backgroundThrottling:false` + 窗口最小化）；
  - `incrementCapturerCount` 本节本次未取到文档原文（文档过长被截断），列为实测项。
- 🟡 `HIDDEN_BOUNDS` 的隐藏方式与 `setVisible(false)` 混用会让 `capturePage` 的 `stayHidden` 语义产生歧义；建议统一。
- 🟢 坐标适配（`browserview-coordinate-adapter.ts`）、`setZoomFactor`、CDP `Input.dispatchMouseEvent` 均不变。

### 5.8 DevToolbox（工作量最大的一块）

- 🔴 **M97 前端 × 140 后端**。`scripts/build-devtools-frontend.cjs:4` 明确写着"面板版本约 M97 降级到 Chromium 87"，而目标后端是 140/142，**方向反了 40 多个版本**。CDP 大体向后兼容，但 DevTools 前端不是：缺失的域/参数会让部分面板直接抛错或空白。
  - 正路：取对应版本（138/140/142）的 `devtools-frontend` 重建，`SOURCE_PATCHES` 按新版本重新匹配；
  - 退路：先只验证"Elements/Console/Network 三面板可用"，其余面板降级处理。
- 🟢 **87 垫片是条件守卫的，不会误伤**：`Object.hasOwn`/`Array.at`/`URL.canParse`/`Highlight`/`CSS.highlights` 全部 `if (!...)` 包裹（`scripts/build-devtools-frontend.cjs:130-163`），在现代 Chromium 上不生效。`mask:` 前缀注入无害。
- 🟡 **87 的 DOM agent 节点 id 失效自愈（sdk.js 垫片 + `rotate()`）**在 140 上大概率不需要，但**不要直接删**：它同时承担"前后端会话重建"的兜底，建议保留代码、加开关，实测后再决定。
- 🟡 主进程桥（`devtoolbox-bridge.ts`）模拟 `Target` 域 + 有序事件流，对协议版本的假设要按 140 重验；`Target.attachToTarget`/`flatten` 的行为近年有变。
- 🟡 `webContents.openDevTools({ mode: 'detach' })`（`tabs.ts:728/979`）仍在，但"独立窗口 DevTools 的 target 解析"（`devtoolbox-target-resolve.ts`）依赖 `type: 'browserView'|'window'` 的判断——迁移到 WebContentsView 后 `TargetInfo.type` 会变成 `'page'`（视图不再是 browserView 类型），**这条判断需要改写**。

### 5.9 截图 / 诊断 / 内存

`capturePage`、`app.getAppMetrics()`、`process.getProcessMemoryInfo()`、`app.getVersion()`、`powerMonitor` 都在。风险低。

### 5.10 构建与分发

- 🟢 electron-builder 26 支持 38/39；`build/electron-builder.config.cjs` 的 `electronDist`（自定义内核）机制不变。
- 🟢 **无原生模块 → 不需要为 Node 22 重编任何 addon**（这是本项目升级最省的地方）。
- 🟡 esbuild `platform: 'node'` + `format: 'cjs'` 仍适用；`target` 若限定过老语法可放开。
- 🟡 `build/verify-release.cjs` 的内核断言（sha256 / `bfb-kernel.json`）要跟着新内核更新基线。

### 5.11 测试

- 58 个测试文件引用 `BrowserView`（多为命名/类型），24 个 mock 了 electron。
- 若**不迁** WebContentsView：只需给 `new-window` → `setWindowOpenHandler` 改 mock，改动面很小。
- 若**迁**：mock 要补 `contentView.addChildView/removeChildView`，`addBrowserView` 相关断言全量重写。

---

## 6. 138 / 140 / 142 三版差异（应用层视角）

| 维度 | Chromium 138（E37） | Chromium 140（E38，现役内核） | Chromium 142（E39） |
| --- | --- | --- | --- |
| `new-window` 移除 | 已移除 | 已移除 | 已移除 |
| 沙箱默认 true | 是 | 是 | 是 |
| `BrowserView` 可用 | 是（弃用） | 是（弃用） | 是（弃用，v39.2.6 文档确认） |
| `setAutoResize` | JS 实现 | JS 实现 | JS 实现 |
| PPAPI 开关 | 需内核补回 | 需内核补回 | 需内核补回 |
| Flash 移植增量 | 基线（已通） | + 51 私有文件 / `transferable_resource` 等 | + `ChannelHandle` 迁移 |
| resize 黑边 | 256px 对齐缓解 | 同左 | **39.2.6+ 自带 viz 补丁 → 归零** |
| DevTools 前端 | 需重建到 138 | 需重建到 140 | 需重建到 142 |
| 应用层代码差异 | — | 与 138 基本相同 | 与 140 基本相同 |

**一句话**：应用侧在 138/140/142 上的改造是**同一套**；版本差异全部落在内核与 DevTools 前端资产上。

---

## 7. 建议的落地顺序

| 阶段 | 内容 | 依赖 | 估时 |
| --- | --- | --- | --- |
| P0 | 140 内核收尾（FlushAck 终态、探针清理、3D/视频债） | 已有 | — |
| P1 | **起壳三件套**：`sandbox`、`setWindowOpenHandler`、PPAPI 开关（内核侧恢复） | P0 | 1 天 |
| P2 | 模块回归：会话/UA/Flash 检测、下载、密码、用户脚本 | P1 | 2~3 天 |
| P3 | 自动化回归：隐藏页截图、最小化出帧、坐标换算 | P1 | 2~3 天 |
| P4 | DevToolbox：前端重建 + 桥/目标解析适配 | P1 | 1~2 周 |
| P5 | 可选：迁 `WebContentsView`；可选：挪 142 | P2~P4 | 3~5 天 / 2~3 天 |

**不建议在 P1 同批做迁 WebContentsView**：它会把"起壳"与"重构"两个变量叠在一起，出问题无法二分定位。

---

## 8. 待实测清单（按优先级）

1. `navigator.plugins["Shockwave Flash"]` 与 `navigator.mimeTypes` 在 140 上是否仍暴露注册的 pepper 插件（决定老站会不会提示装 Flash）。
2. `ppapi-flash-version` 恢复后，站点版本门看到的是配置值（34.0.0.330）还是真实值（29.0.0.171）。
3. 快速拉伸时黑边/白边形态（140 的 256px 复用是否足够；再对照 142 的 viz 补丁）。
4. 最小化窗口下 `capturePage` + `incrementCapturerCount` 是否仍出帧（自动化核心承诺）。
5. `BrowserView` 在半沙箱配置下（`plugins: true` + `nodeIntegrationInSubFrames: true`）是否正常实例化 Flash。
6. 抽屉 DevTools 与新建标签的层序是否互相遮挡。
7. `webContents.close()` 替换 `destroy()` 后 WebContents 是否真正回收（对比进程数）。
8. `titleBarStyle: 'hidden'` 能否替代 `frame:false` + `pt-2`（**独立优化，不要与升级同批**）。
