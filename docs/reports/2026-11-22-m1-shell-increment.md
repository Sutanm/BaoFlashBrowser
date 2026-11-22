# M1 增量记录：外壳、双标签与本地 PPAPI 样本

2026-11-22 · 对应[新版架构 §6 交付顺序和验收](../discussions/2026-11-22-bfb-next-architecture.md#6-交付顺序和验收)的首个实现增量，以及[架构审计 · 当前开工判定](../discussions/2026-11-22-bfb-next-architecture-audit.md#当前开工判定)。构建与插件依据见 [142 真机报告 §10.16](2026-11-21-142-flash-runtime.md)。

本记录覆盖 M1 的第一段：**外壳 + 主进程管理的两个 WebContentsView 标签 + 地址栏导航/切换/焦点/关闭 + 标签拖出窗口（tearoff）+ 独立测试 profile 下的普通 HTML 与本地 PPAPI 样本 + 关闭与重建后的旧事件隔离**。Ruffle、引擎切换、会话恢复、撤销关闭与打包发布承诺不在本段范围内。

## 1. 构建与产物标识

| 项 | 值 |
| --- | --- |
| 内核 | 自编译 Electron **39.8.10** / Chromium **142.0.7444.265**，tag `bao-v142-265-ppapi-sandbox`（提交 `9de35f61aea60`，含 [PPAPI 沙箱修复](../kernel/README.md)） |
| 运行时目录 | `app/.runtime/win-x64`（由 `npm run runtime:prepare -- D:\electron-build-142\dist` 组装） |
| `electron.exe` SHA-256 | `68CF2350DAEAB2FD8906AC4FFE282B1136AC3B8A864D80C223E89070C52C8020`（232,040,448 B；修复前 `930754C1…`） |
| `pepflashplayer64.dll` SHA-256 | `85A836F347D7B3EB06DDDA6573A70C2BC46D03F4B52FDEB4D884E2D71A20B51F`（31,265,280 B，29.0.0.171） |
| 冒烟样本 `probe.swf` SHA-256 | `236C48D58406BBE0C08E7F2EC6829EF4022D153E84B3D160816CFEF4A7AF981A`（461 B，本项目自编 AS3） |
| Ruffle 运行时 | `@ruffle-rs/ruffle` **0.8.0**（2026-11-19 发布），`app/vendor/ruffle/`（`ruffle.js` SHA-256 `3ABFDEEE…D99BC8B7`，WASM `AB23C8D2…A25547CB` / `070F9859…0E14DF44`，见该目录 `PROVENANCE.md`） |
| 工具链 | Node 24.18.0 / npm 11.16.0 / electron-vite 5.0.0 / Vue 3.5.46 / Pinia 3.0.4 / electron-builder 26.18.1 |
| 验证包 | `app/dist/win-preview-YqwBFQ/win-unpacked/BaoFlashBrowser Next.exe` |

## 2. 条款对应与证据

| 条款 | 实现 | 实测证据 |
| --- | --- | --- |
| §3 主进程与窗口：窗口拥有标签顺序、选中关系和 WebContents 生命周期 | `app/src/main/browser-window.ts`，每窗口一个控制器；`ipcMain` 全局只注册一次，按发送者窗口路由 | `startup.test.cjs`、`isolation.test.cjs` |
| §3 主进程与窗口：稳定业务 ID + 绑定代际 | 标签 ID 改为**全局**序列（跨窗口唯一）；`Tab.binding` 每次替换/销毁 WebContents 时递增，所有事件回调按代际判定作废 | `isolation.test.cjs`（崩溃重建后旧 id 已销毁、新 id 不同）、`tearoff.test.cjs`（跨窗口后业务 ID 不变） |
| §3 主进程与窗口「跨窗口移动保留业务 ID」 | `detachTab`/`adoptTab` 只换宿主、复用同一 WebContents；事件回调按 `tab.host` 动态分发，移动时无需重挂监听 | `tearoff.test.cjs`（webContents id 不变、页面内 `window.__baoState` 存活、`canGoBack` 保留） |
| §3 标签合同「拖出窗口」 | 渲染层指针捕获拖动（阈值 6 px）+ `tearoff` 命令；新窗口落在释放点并夹进工作区；拖出最后一个标签时原窗口关闭；新建窗口失败退回原窗口 | `tearoff.test.cjs`（命令路径 + 指针手势路径、窗口内释放为空操作、未知 ID 返回 `unknown-tab`） |
| §3 标签合同「排序」 | `move` 命令只改顺序、不动 WebContents；释放点落在标签栏内即重排，落在栏外交给 tearoff | `tabs.test.cjs`（第三个标签移到最前，选中关系不变） |
| §3 标签合同「撤销关闭」 | 关闭时保存 E39 导航栈（`getAllEntries()/getActiveIndex()`），`undo-close` 新建 WebContents 后 `restore()`；失败退到最后一个地址并给出说明；上限 10 条 | `tabs.test.cjs`（`Ctrl+W` → `undoCount=1` → `Ctrl+Shift+T` 恢复地址与 `canGoBack`；空栈返回 `nothing-to-undo`） |
| §3 标签合同「Chrome 式交互」 | 启动单标签；中键关闭、双击标签栏新建、关闭按钮按需显示、`Ctrl+T/W/Tab/Shift+T`；快捷键在**主进程** `before-input-event` 处理 | `startup.test.cjs`（启动 1 个标签）、`tabs.test.cjs`（鼠标手势与快捷键） |
| §3 引擎：双引擎与「站点规则决定初始引擎」 | `app/src/shared/engine.ts`（纯模型）+ `app/src/main/engine-rules.ts`（`userData/engine-rules.json`，临时文件存储，M2 迁 SQLite）；每标签 `engine` + `engineSource`（默认 / 站点规则 / 手动） | `engine.test.cjs`（默认 PPAPI → 手动切 Ruffle → 记住站点 → 新标签自动 Ruffle） |
| §3 引擎：「切换使用新 WebContents，先验证 E39 导航栈恢复」 | `swapView()` 统一换视图；`navigationHistory.getAllEntries()/restore()` 恢复地址、历史与滚动/表单状态；无法还原时保留原引擎并给出可理解提示 | `engine.test.cjs`（切换后地址仍为 `/two`、`canGoBack === true`） |
| §3 引擎：「Ruffle 使用版本固定的本地资源，验证 WASM、CSP 与 SWF 网络链路」 | `app/vendor/ruffle/`（0.8.0，SHA 见 §1）+ `app/src/main/ruffle.ts`（`ruffle-resource://` 特权 scheme + 会话协议）+ 页面 preload（同步 IPC 取源码注入主世界，避开站点 `connect-src` CSP） | `engine.test.cjs`（`RufflePlayer.newest` 存在、`<embed>` 被替换为 `ruffle-embed` 且 `id` 保留）、`packaged.test.cjs`（验证包内含 Ruffle 运行时） |
| §3 页面：区分加载、崩溃与销毁后重建 | `BrowserTab.crashed` + `render-process-gone` 状态；`reload` 在崩溃时重建 WebContents | `isolation.test.cjs`（`crashed === true` → 重建 → `crashed === false`） |
| §3 引擎：原生 PPAPI 启用 | `app/src/main/plugins.ts`：`--allow-command-line-plugins` + `--register-pepper-plugins`（29.0.0.171，`Shockwave Flash 29.0 r0`） | `flash.test.cjs`、`packaged.test.cjs` |
| §3 标签合同「键盘输入和 IME」「F11」 | 标签级快捷键与 **F11 / Esc 全屏**都在主进程 `before-input-event` 处理（窗口级动作，页面获焦时同样生效）；输入用例走 `webContents.sendInputEvent`（真实浏览器侧输入路径）+ CDP `Input.imeSetComposition`/`Input.insertText` 模拟 IME 提交 | `input.test.cjs`（ASCII 与非 ASCII 进页面、`compositionstart/update/end` 与提交文本到达、不带 Ctrl 的普通字母**不被**快捷键吃掉、地址栏与页面焦点不串台、F11 全屏后视图跟随内容区、Esc 退出）、`plugin-input.test.cjs`（自编 `keyprobe.swf` 通过 `ExternalInterface` 回报 `keyCode:charCode`，证明键盘事件真的进了 **PPAPI 插件进程**） |
| §3 权限与会话：Node 关闭、context isolation、webSecurity、权限一揽子拒绝 | `app/src/main/sessions.ts` + `webPreferences` | `startup.test.cjs`（`typeof window.require === 'undefined'`、页面拿不到 `baoBrowser`） |
| §3 IPC：异步命令、sender/frame/来源校验、稳定错误码 | `BrowserFailureCode` + `browserFailureText`；校验 `event.sender`、`senderFrame === mainFrame` 与文档 URL | `startup.test.cjs`（`invalid-address` 文案） |
| §3 外壳：Vue 3 + Pinia，瞬态交互留在组件内 | `app/src/renderer/stores/browser.ts` + `App.vue` | `startup.test.cjs`（地址栏、标签、焦点、尺寸） |
| §6 M1：独立测试 profile | `--user-data-dir` 指向临时目录，页面/外壳分区与会话独立 | `flash.test.cjs`（`app.getPath('userData')` 等于临时 profile） |
| §6 M1：真实产物 smoke | `npm run smoke` + `npm run smoke:packaged` | 见 §4 |
| §2：产物与插件 SHA-256 记录 | 本文 §1 | 哈希值由上表命令生成 |

## 3. 配置与沙箱（已修复，无例外）

页面视图（`WebContentsView`）与外壳窗口的 webPreferences 都是 `nodeIntegration: false`、`contextIsolation: true`、`webSecurity: true`、`sandbox: true`、`plugins: true`。**没有沙箱例外。**

早前为了让 PPAPI 插件实例化，页面视图曾关闭渲染进程沙箱。定位后确认那不是沙箱本身的问题：渲染进程里的 `ComputePluginsFromCommandLine()` 用 `base::PathExists()` 复核插件 DLL，而 Windows 渲染进程沙箱不允许读应用目录，插件因此被静默丢弃（`navigator.plugins` 有 Shockwave Flash，`<embed>` 却退化成普通元素，也没有 `ppapi` 子进程）。内核已改为由浏览器进程校验路径、渲染进程只取元数据，详见[内核补丁记录](../kernel/README.md)。

当时的四组对照（保留为证据）：

| 变体 | `webPreferences.sandbox` | 启动参数 | `<embed>.PercentLoaded` | `Pepper Plugin` 进程 |
| --- | --- | --- | --- | --- |
| 基线 | true | — | `undefined` | 无 |
| A | false | — | `function` | 有 |
| B | true | `--no-sandbox` | `function` | 有 |
| C | false | `--no-sandbox` | `function` | 有 |

修复后在 `sandbox: true` 下重跑：插件实例化、`PercentLoaded() = 100`、变量桥往返、`Pepper Plugin` 进程存在（见 §4）。这也说明「关闭渲染进程沙箱」只是绕过症状，不是必要条件。

## 4. 实跑命令与结果

全部在本机 `app/` 目录、`D:\java_workspace\BaoFlashBrowserNext` 工作树上执行（先 `Remove-Item Env:\ELECTRON_RUN_AS_NODE`，再设置 `ELECTRON_EXEC_PATH`）。

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（`vue-tsc --noEmit`，无输出） |
| `npm run build` | 通过（main / preload 0.70 kB / renderer 267.59 kB） |
| `npm run smoke` | **11/11 通过**（`startup` 1.23 s、`tabs` 1.36 s、`engine` 1.23 s、`input` 0.97 s、`plugin-input` 1.38 s、`flash` 1.98 s、`isolation` 1.51 s、`tearoff` 契约 1.35 s、`tearoff` 手势 0.97 s、`脚印 CORS` 1.50 s、`快捷键/撤销` 1.71 s），页面视图 `sandbox: true` |
| `npm run pack:win` | 通过，产出 `dist/win-preview-zKYrlB/win-unpacked`（含 `pepflashplayer64.dll` 与 `vendor/ruffle`） |
| `npm run smoke:packaged` | **通过**（3.22 s，验证包启动 39.8.10 / 142.0.7444.265、加载 PPAPI 样本并注入 Ruffle 运行时） |

关键断言（真实运行时，非 mock）：

- `window.baoRuntime === { electron: '39.8.10', chromium: '142.0.7444.265' }`。
- 页面标签：`navigator.plugins` 含 `Shockwave Flash`、`navigator.mimeTypes['application/x-shockwave-flash']` 为真、`PercentLoaded() === 100`、`SetVariable/GetVariable` 往返为 `baoValue`；`app.getAppMetrics()` 出现 `Pepper Plugin` 类型进程。
- 关闭第一个窗口后其页面视图 WebContents 全部销毁；第二个窗口的命令通道、标签身份与地址不受影响。
- 关闭最后一个窗口后进程以退出码 0 结束，不残留窗口或页面视图。
- 新建窗口的 `revision` 与标签列表从零开始，旧窗口事件不改变其状态。
- 渲染进程被 `forcefullyCrashRenderer()` 后：`crashed === true` → 点击重新加载 → 新 WebContents id、旧 id 已销毁、页面恢复。
- 拖出标签后新窗口复用**同一 WebContents id**，页面内 `window.__baoState` 存活、`canGoBack === true`、业务 ID 不变；原窗口只剩未拖走的标签；窗口内释放不新建窗口；未知 ID 返回 `unknown-tab`；指针手势（`pointerdown/move/up`）同样触发移交。

## 4.1 审查中发现并修复的问题

| 问题 | 现象 | 处理 |
| --- | --- | --- |
| 标签业务 ID 按窗口计数 | 两个窗口各自从 1 开始，跨窗口移动/会话恢复时 ID 会重号，违反 §3「每个标签有稳定业务 ID」 | 改为模块级全局序列 `nextTabId` |
| 事件监听绑定在创建它的窗口上 | 移动后旧窗口的 `publish/state` 闭包仍在跑，新窗口收不到更新 | 引入 `tab.host` 动态宿主，事件只按当前宿主分发，移动时无需重挂监听 |
| 指针捕获重定向 `click` 目标 | 加了拖动手势后，点击标签不再切换（`click` 派发到捕获元素而不是内部按钮） | 选择逻辑移到标签容器，排除关闭按钮；`startup.test.cjs` 与 `tearoff.test.cjs` 同时回归通过 |
| 启动即两个标签页 | 产品行为应该是「打开只有一个标签」；两个初始标签只是 §6 字面照做的脚手架 | 改为启动单标签，多标签由按钮/双击/`Ctrl+T` 创建，测试覆盖三条路径 |
| 快捷键写在渲染层 | 页面（尤其 Flash）获得焦点时 `keydown` 到不了外壳渲染层，`Ctrl+T/W` 会失效 | 移到主进程 `webContents.on('before-input-event')`，外壳与页面视图都挂 |
| 默认应用菜单抢占快捷键 | Electron 默认菜单的 accelerator 会吃掉 `Ctrl+W` 等 | `Menu.setApplicationMenu(null)`；DevTools 入口在后续增量按 §4 单独接入 |
| **PPAPI 在沙箱渲染进程中不实例化** | 插件注册成功但 `<embed>` 拿不到插件对象、无 `ppapi` 子进程，且没有任何日志 | 内核定位到 `ComputePluginsFromCommandLine()` 的 `base::PathExists()` 在沙箱渲染进程里读不到应用目录；改为浏览器校验、渲染进程只取元数据。详见[内核补丁记录](../kernel/README.md) |
| 站点规则覆盖手动切换 | 手动切到 Ruffle 后，下一次导航又按规则默认值切回 PPAPI，用户选择被无声覆盖 | 按 §3「站点规则决定**初始**引擎」：`engineSource === 'manual'` 的标签导航时沿用用户选择，只有未手动切换过的标签才重新解析规则 |
| Ruffle WASM 文件名带大写哈希 | 0.8.0 的 `ruffle_web_bg.QDRSAAAZ.wasm` 在 `standard` scheme 下会被 `new URL()` 归一成小写；Windows 靠大小写不敏感碰巧能跑，Linux 会 404 | 资源解析做不区分大小写的回退（`resolveResourcePath()`），并在 `vendor/ruffle/PROVENANCE.md` 记录该约束 |
| Ruffle `publicPath` 不是合法 URL 基址 | `ruffle-resource://` 没有 host，Ruffle 的 `new URL(wasm, publicPath)` 抛 `Invalid URL`，真实站点上表现为 Ruffle 错误面板。本地冒烟只断言 `ruffle-embed` 存在，而错误面板下该元素同样存在 —— **断言过弱** | 改为 `ruffle-resource://assets/`（占位 host + 结尾斜杠）；`engine.test.cjs` / `packaged.test.cjs` 的断言加严到「shadow root 里出现播放器画布」 |
| SWF 的 CORS 兼容层缺失 | PPAPI 插件进程自己发请求、不受 CORS 约束；Ruffle 用页面 `fetch()` 取跨域 CDN 的 SWF，被 `No 'Access-Control-Allow-Origin'` 拦掉后销毁实例 | 在页面会话对 `*.swf` 注入放行头（`sessions.ts`），并用双源用例 `ruffle-cors.test.cjs` 固化 |
| 站点可触发意外下载 | 真实站点对照时 4399 触发 SWF 下载，落盘位置由浏览器默认值决定（曾把 2.7 MB 的游戏 SWF 落到工作树里） | M1 先默认拒绝：页面与外壳会话的 `will-download` 一律 `preventDefault()`；下载策略按 §4 在 M2 立项 |

## 4.2 真实站点对照（2026-11-22）

样本：<https://www.4399.com/flash/254626_3.htm>（狂扁外星人）。加载链：页面 → `gameloader2.swf` → 游戏 `szhong.4399.com/4399swf/upload_swf/ftp52/gamehwq/20250905/15b.swf`。

| 引擎 | 结果 | 证据 |
| --- | --- | --- |
| 原生 PPAPI | 页面加载、`Pepper Plugin` 进程存在、SWF 链路全部 200、游戏首帧渲染 | [截图](../evidence/2026-11-22-4399-254626-ppapi.png) |
| Ruffle 0.8.0 | 修复 `publicPath` 与 SWF CORS 两处后：加载器运行、游戏 SWF 成功 fetch、游戏首帧渲染 | [截图](../evidence/2026-11-22-4399-254626-ruffle.png) |

该对照直接产出了上表的两个修复（`publicPath` 合法性、SWF CORS 兼容层）。**只覆盖单个页面**：4399 的登录/防沉迷弹窗流程、其他站点、Ruffle 的 Stage3D 与音频、站点版本门（UA / 插件版本通告 / `mms.cfg` / SWFObject）仍未验证。

## 5. 未验证与遗留

- **Ruffle 画布焦点**：Ruffle 引擎下 `ruffle-embed` 画布的键盘焦点与游戏内输入未测（PPAPI 引擎下的插件内部输入已由 `plugin-input.test.cjs` 覆盖）。
- **插件内的 IME 组合**：`plugin-input.test.cjs` 只覆盖 keydown/`charCode`；CDP 的 `Input.imeSetComposition` 只对 HTML 页面验证过，IME 组合输入到 PPAPI 插件内部未测。
- **引擎切换失败回退**：`navigationHistory.restore()` 抛错的分支已实现（保留原引擎并给出提示），但没有构造出失败用例；POST 体等无法还原的状态只按文档记录，未实测。
- **Ruffle 能力边界**：`ExternalInterface` 只覆盖部分 API，本地 PPAPI 样本里的 `PercentLoaded`/`SetVariable` 往返在 Ruffle 引擎下不保证可用；验收断言只覆盖运行时注入与 polyfill 接管。Ruffle 0.5.0 的元素名是 `ruffle-embed`/`ruffle-object`。
- **真实站点范围**：只对照了单个 4399 页面（见 §4.2）。UA、插件版本通告、`mms.cfg`、SWFObject、登录/防沉迷弹窗流程、其他站点均未复测（审计 §C7 的其余对照项）。
- **站点规则存储**：当前是 `userData/engine-rules.json`，M2 引入业务库后迁 SQLite；无版本化与迁移逻辑。
- **Ruffle 全屏 / 音频 / 后台出帧**：未验证。
- **引擎切换与光标/焦点**：切换后焦点落在新视图，Flash 内的输入焦点未实测。
- **后台出帧**：#52844 暂缓回移的结论来自本地 HTML 对照；真实 Flash 标签中的后台恢复仍待复测，#54311 / #54090 未开始。
- **会话恢复、标签固定/复制/静音/分组与搜索、标签右键菜单、未加载占位**：未实现（M1 后续增量）。`detachTab/adoptTab` 与 `undo-close` 已按「同一 Tab 身份」建模，是这些交互的同一入口。
- **DevTools 入口**：默认应用菜单移除后 `Ctrl+Shift+I` 不可用，按 §4「原生 DevTools 优先」在后续增量接入。
- **跨窗口移交的其余验证面**：失焦、全屏退出、音频继续播放未测；已实测的是同一 WebContents 复用带来的页面运行时状态与导航历史保留，真实 Flash 标签（4399 等）未复测。
- **打包发布**：只产出 `--dir` 验证包；签名、分发、独立复建与依赖校验未做。
- **`npm run dev`（Vite 开发服务器）**：本次未跑，冒烟针对构建产物与验证包；开发入口的 shell URL 分支未实测。
- **真实站点多页面与登录流程**：未覆盖。

## 6. 采用的可逆假设

文档未写清、本次按最小可逆方案处理的细节：

1. Flash 插件路径解析顺序：`BAO_FLASH_PLUGIN` → `electron.exe` 同目录 → `resources` 目录；找不到时整体停用并告警，不阻断启动。
2. 页面视图与外壳都保持 `sandbox: true`；PPAPI 可用的前提是内核含 [补丁 0001](../kernel/0001-ppapi-renderer-plugin-path-check.patch)（tag `bao-v142-265-ppapi-sandbox`）。
3. 崩溃后不自动重建，由用户点击「重新加载」触发（保留用户可见的恢复动作，避免后台静默重载）。
4. 窗口重建通过 `app` 上的 `bao-next:open-window` 事件驱动，当前产品生命周期仍是「最后一个窗口关闭即退出」；该事件同时作为后续多窗口入口。
5. 冒烟样本使用本项目自编 AS3 的 `probe.swf`，源码与哈希随样本入库（`app/tests/smoke/fixtures/`）。
6. 拖出判定按「释放点的屏幕坐标是否落在源窗口 `getBounds()` 内」；落在窗口内视为未拖出，直接返回当前状态（不重排标签，因为排序尚未实现）。
7. 新窗口尺寸继承源窗口，位置取释放点并向左上偏移（120×16 px）后夹进最近的显示器工作区。
8. 拖出最后一个标签时先创建新窗口再关闭源窗口，保证失败时能退回；源窗口关闭由「标签数为 0」触发，不额外引入生命周期状态。
9. 撤销关闭只保留导航栈（最多 10 条），不保留渲染进程：`restore()` 只能恢复 URL 与滚动/表单状态，POST 体等无法还原，失败时退到最后一个已知地址并提示。
10. 快捷键集合当前只有 `Ctrl+T/W/Tab/Shift+T`；`Ctrl+R`、`Ctrl+L`、`Ctrl+数字` 等未加入，避免与页面自身快捷键冲突，等站点规则与 DevTools 接入时统一评审。
11. 标签栏无障碍采用「按钮 + `aria-pressed`」而不是 `role=tab` 漫游 tabindex：后者会让关闭按钮污染标签的可访问名，现有冒烟选择器也依赖稳定名称。
12. 引擎来源语义：`default`（无规则）→ `site-rule`（命中规则）→ `manual`（用户在本标签手动切换）。命中 `manual` 后导航不再重新解析规则，直到用户再次手动切换；「记住此站点」把当前引擎写回规则并改回 `site-rule`。
13. Ruffle 运行时源码走**同步 IPC**（`bao:ruffle-bundle`）而不是页面 `fetch`：站点 `connect-src` CSP 会拦页面世界的 fetch；IPC 用「页面视图登记表」校验发送者（preload 执行时文档 URL 尚未提交，按 URL 会误拒自己人）。
14. 插件不可用（找不到 `pepflashplayer64.dll`）时所有标签回退到 Ruffle，避免出现「选了 PPAPI 却什么都不显示」。
