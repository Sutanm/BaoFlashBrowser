# 12 · 内置开发者工具箱（DevToolbox）

> 状态：**首版落地（2026-11-05）**，范围是「不占用 CDP 的只读观察层」。
> 抽屉骨架 + 控制台（页面/外壳）+ 捕获 + Flash + 主进程日志已可用；
> 网络响应体、DOM/CSS 树、断点调试仍未实现（见 §7 后续）。

## 1 范围与目标

在浏览器窗口底部提供一个仿 Chrome 形态的调试抽屉，让「页面控制台、外壳控制台、
密码捕获链路、Flash 插件状态、主进程日志」在应用内直接可见，不需要外接浏览器或翻
`logs/main.log`。

**硬边界**：工具箱**不 attach CDP**。互斥只发生在 embedded client 之间——
Electron 的 `webContents.debugger` 一个 WebContents 只能挂一个（`cdp-lease.ts`
的排他租约就是这条事实的落地），而密码捕获长期持有、自动化按短租约排队、
`password-fill` 还会几十毫秒裸 attach。工具箱一旦抢租约，捕获链路会拿到
`CDP is already attached by an unmanaged client`，即 2026-09-22 那次 7k7k
捕获失效的同一类故障。

**共存性实测更正（2026-11-06）**：embedded client 与**远程 ws 客户端**并不互斥。
`tools/devtools-spike/cdp-coexist-check.cjs` 与 `cdp-embedded-coexist.cjs` 实证
（Electron 11 / Chromium 87）：

| 组合 | 结果 |
| --- | --- |
| page-ws × 2 | 共存，双方 evaluate 全通 |
| page-ws + browser 级 `Target.attachToTarget(flatten)` | 共存，事件互通 |
| embedded（`webContents.debugger`）+ page-ws × 2 | 共存，attach/evaluate 全通 |
| embedded + flatten | attach 成功；flatten 的 `Runtime.evaluate` 报"域未找到"（**已查明：瞬时竞态**——attach 后立即 evaluate、域尚未就绪；应用本体上按"flatten only / +1 page-ws / +2 page-ws / 重连"四组合复跑全部正常，探针 `flatten-app-mystery.cjs`） |
| embedded + `openDevTools({mode:'detach'})` / `mode:'bottom'` | 共存（两种 attach 顺序均通过，探针 `cdp-opendevtools-coexist.cjs`） |
| embedded + `setDevToolsWebContents` 容器（BrowserView 承载内置前端） | 共存，容器内 URL 为 `devtools://devtools/bundled/...`；注意 `isDevToolsOpened()` 在该组合下返回 false（quirk，探针 `cdp-container-check.cjs`） |

推论：抽屉 DevTools 前端（page-ws）开着**不影响**密码捕获/填充；openDevTools 系
也不影响。"CDP 总线"（browser flatten 多路复用）要解决的多客户端问题 Chromium 87
的端点已经免费提供，没有必要实现。唯一真实的互斥仍是 embedded × embedded
（`webContents.debugger` × 2，即 2026-09-22 事故与 cdp-lease 的存在理由）——若未来
出现第三个 embedded 消费者，做一个约百行的 embedded 引用计数复用器即可，不需要总线。

**容器方案 vs iframe 方案（2026-11-06 评审结论）**：`setDevToolsWebContents` +
BrowserView 容器（"可感知容积包裹"）技术上成立——bounds 全控、免端口、免 iframe
降级工程、与密码模块共存。但它承载的是**87 内置前端**（`devtools://devtools/bundled`，
无中文、2020 年代 UI），且前端不可替换（该 API 无法指定自定义页面）；另有
`isDevToolsOpened` 等 quirk 需要额外工程验证。现行 iframe 方案换来的是 M97 前端 +
中文包 + 停靠壳，代价（回环随机端口 + polyfill）已付清且稳定，维持不换。

**结论**：首版只做非 CDP 观察，能力换稳定性。

## 2 静态结构

| 路径 | 职责 |
| --- | --- |
| `src/main/modules/devtoolbox.ts` | 采集管道：`console-message` 订阅、electron-log hook、快照、求值、页面探测、打开原生面板 |
| `src/main/modules/devtoolbox-buffer.ts` | 纯逻辑：文本截断、等级映射、日志分类、双队列缓冲（可单测，不依赖 Electron） |
| `src/main/modules/devtoolbox-probe.ts` | Flash 探测的 CDP 深探：跨域 / OOPIF / 无 JS 上下文的 frame 逐个求值（走独立 page 连接，不碰 `wc.debugger`） |
| `src/main/ipc/devtoolbox.ipc.ts` | `snapshot` / `clear` / `evaluate` / `open-native` / `probe-page` |
| `src/shared/types/devtoolbox.ts` | 共享类型 |
| `src/renderer/components/devtools/DevToolDrawer.tsx` | 抽屉骨架、标签条、可拖拽高度 |
| `src/renderer/components/devtools/ConsolePanel.tsx` | 日志列表 + REPL 输入（页面/外壳/主进程共用），DOM 只渲染最近 600 行 |
| `src/renderer/components/devtools/ElementsTab.tsx` | 元素选择器：页面上点选 → 选择器/尺寸/outerHTML/计算样式 |
| `src/renderer/components/devtools/CaptureTab.tsx` | 捕获链路 + 当前 CDP owner |
| `src/renderer/components/devtools/FlashTab.tsx` | 插件解析结果、mms.cfg、页面 SWF 列表 |
| `src/renderer/store/useDevToolStore.ts` | 抽屉开关/高度/激活标签/条目环形缓冲（2000 条） |

## 3 数据流

```
BrowserView / 外壳 WebContents
        │  console-message（Electron 事件，无需 DevTools 打开）
        ▼
devtoolbox.ts emit()  ──►  EntryBuffer(2000)  ──►  80ms 批量 ──►  'devtoolbox:entries'
        ▲                                                        │
        │  electron-log hooks（每个 transport 都会触发）           ▼
主进程 log.info('[PasswordCapture] …')                  useDevToolStore.ingest()
```

- **推送**：`flushTimer` 每 80ms 合并一次，单批最多 400 条；渲染层按 `id` 去重。
- **回放**：抽屉打开时调 `devtoolbox:snapshot` 拿全量历史，替换渲染层缓冲。
  这样抽屉关着的时候事件不会丢。
- **递归防护**：hook 内的 `emit` 不会写日志；`sendToRenderer` 失败时静默丢弃
  （否则 `log.error` 会再进 hook）。

## 4 面板与过滤

| 标签 | 数据来源 | 过滤条件 |
| --- | --- | --- |
| 控制台 | 页面 `console-message` + 求值回显 | `source === 'page'` |
| 元素 | `executeJavaScript` 注入一次性拾取层（高亮框 + 标签提示） | 点击/`Esc` 结束时以 Promise 结果回传 |
| 外壳 | **主窗口** `console-message`（界面进程） | `source === 'shell'` |
| 捕获 | 主进程日志中 `[PasswordCapture]` / `[Keyring]` / `[ViewGate]` / `[PasswordStore]` | `issue === 'capture'`，另显示 CDP owner |
| Flash | `resolveFlashPlugin()` + 插件目录 `mms.cfg` + `executeJavaScript` 探测页面 SWF | `issue === 'flash'`（日志在标签内不加载） |
| 主进程 | 其余 electron-log 记录 | `issue === 'log'` |

`console-message` 在 Electron 11 的签名是 `(event, level, message, line, sourceId)`：
只有文本 + 来源位置，**拿不到对象参数**（`frame` 字段要到 Electron 35 才有）。

## 5 交互

- **F12** → 开关抽屉；**Ctrl+Shift+I** → 仍打开原生 DevTools（英文），作对照与逃生口。
  注意：主窗口在 `app.on('web-contents-created')` 注册之前就已创建（`index.ts`），
  曾经因此从没挂上 `before-input-event`——焦点在页面时 F12 可用、焦点在地址栏或工具箱
  输入框时失效。现在 `registerShortcutHandler(mainWindow.webContents)` 显式补绑，
  且幂等（重复绑定会一次发送两个 `shortcut`，toggle 类动作表现为“按了没反应”）。
- 抽屉上沿 6px 可拖拽：`160px` ~ **工作区高度 − 24px**，双击恢复窗口高度 34%。
  上限以前是 `window.innerHeight * 0.8`，两个问题：① 抽屉活在顶栏之下的工作区里，
  按整窗算出来的上限比可用高度大，拖到头会超出可视区下半截；② 80% 是与内容无关的
  硬比例，用户会觉得"拖不动"。现在量 `.workspace-main` 的 `clientHeight`，只留 24px
  让拖拽把手始终可抓。窗口尺寸变化时（`resize`）存量高度会被重新夹回。
- 高度存放在 `localStorage['devtoolbox.height']`（**不进** electron-store 配置：
  高频 UI 状态不该污染需要迁移与校验的 schema）。
- 抽屉是 `.workspace-main` 的最后一个 flex 子项，开合直接压缩 `#browserview-area`，
  由 `App.tsx` 既有的 `ResizeObserver → tab:setBounds` 带动 BrowserView 缩放，
  没有新增边界计算逻辑。拖拽期间用 `requestAnimationFrame` 合帧，避免原生层拖影。
- **`.workspace-view` 必须有 `min-height: 0`**：列向 flex 子项默认 `min-height: auto`，
  会被新标签页内容（搜索框 + 快捷图标约 331px）顶住不让缩；抽屉排在它之后，
  于是被推出可视区下方。现象就是"切到新标签页面板矮了一截、切回页面又凭空长高"，
  其实高度值一直没变，只是被顶出去又放回来。探针 `drawer-geometry-check.cjs` 盯这个：
  两种标签页下 `drawer.y` 必须相同。
- **侧边栏开合动画期间，前端视图只移动、不改尺寸**。侧边栏用 width/flex-basis 做
  240ms 动画，工作区宽度每帧都在变；原生视图如果跟着改宽度，DevTools 前端每帧整页重排，
  240ms 内最多跟上 13/18 个台阶、中间一跳 206px（关闭时 48 个台阶只跟 10 个，最大 154px）。
  现在的做法（`DevToolsTab` 的 `report()`）：动画期间 `width/height` 沿用上次的值、
  `x` 跟着布局右移（`max(上次, 本次)`，所以关闭时原地不动、不会盖住滑出的侧边栏），
  等 `getAnimations()` 报的动画跑完再按真实矩形重排一次。
  实测同一条序列变成「前端宽度 1280 → 940 一步到位」，中间零重排
  （探针 `sidebar-squeeze-check.cjs`）。
  注意页面那侧本来就有同类机制（`computeBrowserViewBounds` 的 sidebarCompensation），
  但那是**永久**裁剪；DevTools 必须保留正确布局，所以只在动画期间临时裁剪。

## 6 验证

```bash
npm run typecheck && npm run lint
npx vitest run tests/devtoolbox-buffer.test.ts
npm run build && npm start
```

真机自检清单：

1. F12 打开抽屉，页面区域应等比缩小（不是被遮挡）。
2. 拖上沿调整高度，松手后重开仍保持；双击回到默认高度。
3. 页面执行 `console.log('probe')`，控制台标签应出现该行。
4. 外壳标签应有 `[Preload]` 之类界面进程输出。
5. **焦点放在工具箱输入框里按 F12，抽屉应当关掉**（历史 bug：主窗口没绑快捷键）。
6. 元素标签点「选择元素」→ 页面上点击任意元素 → 出现选择器/尺寸/计算样式；`Esc` 取消。
5. 捕获标签：登录一次目标站点，应看到 `[PasswordCapture] captured host=…`，
   且 `CDP:` 徽标显示当前占用者。
6. Flash 标签：打开含 SWF 的页面，SWF 列表应出现 `resource`/`embed` 条目。
7. 打开抽屉后，密码自动填充与捕获**行为不变**（这是首版最重要的回归项）。

## 7 已知限制与后续

| 限制 | 原因 | 后续 |
| --- | --- | --- |
| 看不到网络响应体 | `session.webRequest` 只有头与状态；响应体必须 CDP `Network.getResponseBody` 或 mitm 代理 | 阶段二引入 `cdp-hub`（共享会话 + 引用计数）后补 |
| 没有 Elements/CSS 面板 | 需要 `DOM.*` / `CSS.*` 域 | 已提供只读选择器（选择器/尺寸/outerHTML/常用计算样式）；改样式与实时 DOM 树仍需 CDP |
| 选择器进不了跨域 iframe | `executeJavaScript` 只作用于主 frame，Electron 11 也没有 `mainFrame`/`WebFrameMain` | 面板里的只读选择器仍然只能看主 frame；**Flash 标签已用 CDP 深探绕开**（`Page.createIsolatedWorld` + OOPIF session，见下） |
| 没有断点调试 | 无 CDP 就没有 Debugger 域 | 原生 DevTools 兜底 |
| `console-message` 无对象参数 | Electron 11 限制 | 升级 Electron 不可行（Flash PPAPI → 见 02） |
| 内置面板的语言跟随系统 | chii 的构建产物自带 `locales/zh.json`（官方 npm 包没有），首开横幅可一键切换 | 已支持中文，见 §8.1 的 i18n patch |

**Flash 标签的三种"没 SWF"**（`PROBE_SCRIPT` + CDP 深探 + `FlashTab`）：

1. `flashPlugins > 0` → 「检测到 N 个 Flash 插件实例，但没解析出 SWF 地址」——
   按 `<embed/object type="application/x-shockwave-flash">` 数实例，不看 URL。
   有的站点把地址藏进脚本，光看 `.swf` 字符串会误报"没有 Flash"。
2. 有跨域 iframe **且这次没读到** → 「游戏很可能在下面这些跨域 iframe 里」。
   只在 CDP 深探也失败时才会出现（`frame.readable === false`）。
3. 都没有 → 「所有 frame 都扫过了。有的游戏要登录或进入游戏后才创建 Flash 插件」。

**CDP 深探（`devtoolbox-probe.ts`）**：跨域 / OOPIF / 无 JS 上下文的 frame 也能扫。
这套做法直接借自 `automation/game-surface-detector.ts`（相框助手找游戏画面用的同一套）：

| 手段 | 解决什么 |
| --- | --- |
| `Page.getFrameTree`（根 + 每个 session） | 拿到全部 frame，含 OOPIF 的根 frame 与深度 |
| `Page.createIsolatedWorld` → `Runtime.evaluate` | 每个 frame 建**独立世界**，跨域也能在里面跑探测脚本；不依赖 `executionContextCreated` 回放（老 XHTML / 插件文档不给默认上下文） |
| `Target.setAutoAttach`（flatten）+ 逐 session `Runtime.evaluate` | 跨域 iframe 若是独立进程（OOPIF），根会话压根没有它的上下文，只能在它自己的 session 里求值 |
| `DOM.getFlattenedDocument` / `DOM.getDocument(pierce)` | PPAPI 插件文档（frame URL 直接是 `.swf`）没有可用上下文，但仍是 DOM 节点 |
| frame URL 本身匹配 `.swf` | 兜底产出 `kind: 'frame'` 的条目 |

触发是有条件的：**主文档已经扫到 SWF 且没有跨域 frame 时不深探**（4399 这种走快路径）；
否则深探一次约 250ms（实测 `via={"isolation":9,"session":0,"dom":6}` @4399）。

**传输走端口上的独立 page 连接，不用 `wc.debugger`**：embedded 调试器被密码捕获/填充
占着（`cdp-lease`），工具箱插进去会让捕获拿到 `already attached by an unmanaged client`
（§1 的铁律）。page target 允许多客户端并存，实测深探与桥、密码捕获三线共存无冲突。

4399 这类**顶层直接放 `<object>`** 的页面属于正常路径（实测 `embed 755×567` + 3 个 SWF）。
7k7k 的《皮卡堂》是第 3 种的真实案例：**登录进服之后才会往页面插 `<embed>`**，
所以进服前看到"没有 SWF"是正确结论，不是探测失败。为此 Flash 页停留在前台且
没拿到 SWF 时，会每隔 2s 自动补探一次（最多 6 次）；换标签或换页面会重置计数。

**探测必须带 tabId**：`devtoolbox:probe-page` / `devtoolbox:snapshot` 都接受 `tabId`，
由渲染层传入。主进程的"活动标签"比渲染层晚一拍，自己取会探到上一个页面——表现是
切完标签 Flash 页还显示上一页的 SWF（或者新建标签页那次探到 `about:newtab` 的空结果），
得重开面板才更正。**同一标签内的导航也要重新探**：新建标签页从 `about:newtab` 走到真实
页面时 `tabId` 不变，只看 `tabId` 会一直停在空结果上（`DevToolDrawer` 的探测 effect
因此同时依赖 `activeTabId` 与 `activeTabUrl`）。

Electron 11 的 webRequest 监听是「后者覆盖前者」。要做必须先把观察者挂进现有监听链
（参考 `js-patch-service.ts` 的既有模式），不能自行注册。
（补：`onBeforeRequest` / `onHeadersReceived` 已被 `session-manager.ts` 占用、
`onCompleted` / `onErrorOccurred` 已被 `userscript-web-request.ts` 占用，四个槽位已满。）

## 8 DevTools 宿主（2026-11-05 第二轮）

抽屉的第一个标签现在托管**官方 DevTools 前端**，不再是自绘面板。

### 8.1 结构

| 路径 | 职责 |
| --- | --- |
| `assets/devtools-frontend/` | 上游前端资源（取自 chii 的构建产物，面板版本约 M97，640 文件 / 14MB） |
| `scripts/build-devtools-frontend.cjs` | 降级到 Chromium 87：摘 top-level await、esbuild 语法降级、注入 polyfill、补 `-webkit-mask` 前缀 |
| `dist/devtools-frontend/` | 构建产物；开发时由主进程静态托管，打包时进 `resources/devtools-frontend` |
| `src/main/modules/devtoolbox.ts` | `ensureFrontendServer()`（127.0.0.1 + 系统分配端口）、`getDevToolsTargetUrl()` |
| `src/renderer/components/devtools/DevToolsTab.tsx` | iframe 宿主 + 「当前页面 / 外壳界面」目标切换（**选择按标签记**，见 `useDevToolStore.tabTarget`） |

传输链：`iframe(http://127.0.0.1:<static>/devtools_app.html?ws=127.0.0.1:<cdp>/devtools/page/<id>&can_dock=true)`
→ Chromium 的 CDP 端口 → 目标 WebContents。**前端只会说 WebSocket，端口是它的传输层。**

**壳的选择（2026-11-06）**：入口用 `devtools_app.html` + `can_dock=true`，而不是
`inspector.html`。M97 前端按 `getRegisteredAppProviders()` 的 order 选壳：
`AdvancedApp`（order 0，condition = `can_dock` query 参数）> `ScreencastApp`
（order 1，无条件兜底）。`inspector.html` 会额外注册 ScreencastApp，且不带
`can_dock` 时 AdvancedApp 被 condition 过滤掉 → 只能跑出"左侧实时画面 +
右侧面板"的 undocked 布局（iframe 里没有宿主窗口，那块预览纯属浪费）。
`devtools_app.html` 只挂 AdvancedApp；`can_dock=true` 让 DockController 走
docked 语义（默认 `right`），构建期把 `updateForDocked()` 末尾的 `showBoth()`
改成 `hideMain()`（见 8.2 源级补丁），让 Elements/Styles 分栏铺满抽屉，
没有空白占位也没有 screencast。

**目标跟随（2026-11-06）**：页面目标走主进程的 `tabId → targetId` 绑定表
（`devtoolbox.ts` 的 `pickTargetForTab`），不再按 URL 实时匹配。page target id
在同一 WebContents 生命周期内跨导航恒定，因此：
- 切标签 → 绑定表换 targetId → iframe 重连新标签的 target；
- 同标签内导航 → targetId 不变 → iframe 不重载，前端经 CDP 事件自动跟随
  新页面，Elements/Console 状态保留（与真 Chrome DevTools 一致）。
绑定在标签还停在 about:newtab 等中间态时可能失败，renderer 会重试（~9 秒）
后才显示"未开启调试端口"占位。已知局限：Electron 11 没有暴露
webContents ↔ targetId 映射（`webContents.debugger.attach` 会抢 password-fill
的 CDP 租约），首次绑定按"URL 匹配 + 未被其他 tab 占用"建立——两个标签
停在完全相同 URL 的时刻绑反是理论上的残余歧义。

### 8.2 为什么要降级

Chromium 87 是 Flash PPAPI 的硬约束，而 M97 前端用了它不认的东西，三类：

1. **top-level await**（`const x = await import(...)`）→ `SyntaxError: Unexpected reserved word`。
   构建脚本按 esbuild 报的行列精确摘掉 `await`（受影响分支默认不启用）。
2. **语法版本**：esbuild `target: chrome87`，247 个 JS 全部通过。
3. **运行时 API 与 CSS 属性**：`URL.canParse`、`Object.hasOwn`、`Array.prototype.at/toSorted` 等
   由 `bfb-polyfills.js` 前置补齐；`mask:` / `mask-image` 必须补 `-webkit-` 前缀，否则图标全是灰块。
4. **CSS Custom Highlight API**（`Highlight` 构造器，Chrome 105+）：M97 的
   `ui/components/highlighting` 用类字段 `#s = new Highlight()` 初始化，87 上直接
   `ReferenceError` 炸断 Elements 树渲染（树空白、Styles 也空；元素抓取走后端
   Overlay 不受影响）。polyfill 给出 Set 形状替身 + `CSS.highlights` no-op 注册表。
5. **源级补丁**（`SOURCE_PATCHES`，按压缩原文精确字面量替换，未命中即构建失败）：
   - `core/sdk/sdk.js`：87 的 `requestWillBeSentExtraInfo` 不带 `connectTiming`，
     `setConnectTimingFromExtraInfo` 加空参守卫，否则 Network 请求流每个请求抛 TypeError。
   - `ui/components/highlighting/highlighting.js`：87 的 `document.adoptedStyleSheets`
     是冻结数组（push 抛 TypeError），改成整体赋值（赋值语义可用且样式真实生效，
     探针 `tools/devtools-spike/adopted-probe.cjs`）。
   - `panels/emulation/emulation.js`：`updateForDocked()` 末尾 `showBoth()` →
     `hideMain()`。can_dock 下 DockController 默认 dockSide 是 `right`，showBoth
     会显示"被检查页面占位"（真 DevTools 里由宿主窗口绘制，我们这里只是一块空白）；
     保留 `right` 而不是改默认值为 `undocked`，因为 undocked 会在首次 setDockSide
     时触发 `openToolboxWindow()` 的 `window.open`（设备模式 frame，会弹窗）。
   - polyfill 注入覆盖 `inspector.html` 与 `devtools_app.html` 两个入口
     （前者保留给探针脚本对拍）。

### 8.3 端口与安全

- **全应用零固定端口**（2026-11-06 收敛）：所有监听都是系统临时分配、随应用
  生命周期生灭。逐项盘点：
  | 监听器 | 端口 | 发现方式 |
  | --- | --- | --- |
| CDP（remote-debugging-port） | `0` → Chromium 自选 | `userData/DevToolsActivePort` 文件（`resolveDebugPort()` 读第一行） |
| DevTools 前端静态服务 | 仅 `BAO_DEVTOOLS_LEGACY_HTTP=1` 时 `listen(0)` | 主进程内存（写进前端 URL） |
  | aria2 RPC | bind(0) 探测空闲口 | 主进程内存（`aria2-rpc.ts`） |
  | screenshot HTTP（仅开发态 opt-in） | `0` 随机（env 可钉死） | electron-log（与 token 一起打印） |
- **CDP 全版本常开**：主进程 `bootstrap()` 里 `appendSwitch('remote-debugging-port', '0')`，
  打包版与开发版一致，抽屉 DevTools 无需任何启动参数。`start:debug` 与普通启动
  唯一区别只剩构建产物新鲜度。安全面：只绑 `127.0.0.1`，等于本机进程可调试本
  应用；外部 ws 客户端与 embedded debugger 实测共存（§1 共存性），开端口不影响
  密码捕获/填充。B3 之后前端不再自己拿端口（URL 里没有 `ws`），端口只出现在
  主进程的桥里——但**威胁模型没变**：端口本身仍在、仍无鉴权。
- 运行时**不可关闭**——Chromium 的 DevToolsHttpHandler 在进程启动时决定。 选端口
  不再需要查 Windows 保留端口段（`netsh interface ipv4 show excludedportrange
  protocol=tcp`）：系统分配的临时端口不会落在保留段，历史教训仅供外部脚本
  自己钉端口时参考。

### 8.4 已知缺口

| 缺口 | 说明 |
| --- | --- |
| ~~没有中文语言包~~（更正） | **更正：中文语言包实际随 chii 打包**（`core/i18n/locales/zh.json`，4941 键含真实翻译；早前"裁掉了 locales/"的结论是查错对象——官方 npm 包没有，chii 的构建有）。首开横幅「Switch DevTools to Chinese」一键切换，或设置里 language 选 Chinese（切换需重载面板） |
| 部分新特性降级 | 后端是 87，前端会向它要 `Network.setAttachDebugStack`、`Overlay.setShowFlexOverlays` 等新方法，返回 `-32601`；主面板不受影响 |
| 搜索命中无底色 | `CSS.highlights` 是 no-op（87 画不了 custom highlight），Elements 里搜索命中只有选中态没有高亮底色 |
| Preloading 面板的 JSON 高亮常量 | 摘 `await` 后该常量到得晚，只有打开该面板看 JSON 时可能缺色 |

### 8.5 验证

```bash
npm run build                      # 内含 build:devtools-frontend
node tools/devtools-spike/verify-in-app.cjs   # 起应用→点工具箱→截图 artifacts/devtools-in-app-2026-11-05.png
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe   tools/devtools-spike/electron-frontend-check.cjs   # 单窗口验证前端能否在 87 上启动
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe   tools/devtools-spike/adopted-probe.cjs   # 探 87 的 adoptedStyleSheets 语义
node tools/devtools-spike/page-elements-repro.cjs   # 真实页面（默认 7k7k）上验证 Elements 树渲染
node tools/devtools-spike/dock-shell-check.cjs      # 验证停靠壳：devtools_app.html + can_dock、无 screencast、Elements 渲染
node tools/devtools-spike/tab-switch-check.cjs      # 双标签验证（page-ws）：切标签容器跟随新 target、同标签导航 targetId 不变
node tools/devtools-spike/cdp-coexist-check.cjs     # CDP 共存性：page-ws × 2、page-ws + flatten session
node tools/devtools-spike/cdp-embedded-coexist.cjs  # CDP 共存性：embedded debugger 与远程 ws 客户端
node tools/devtools-spike/page-ws-baseline-capture.cjs      # page-ws 基线录流（ws 代理夹在前端与真实端点之间）
node tools/devtools-spike/bridge-mode-check.cjs              # 桥模式端到端：树与目标页一致、bfbBridge 就位、0 异常
BFB_PAGE_WS=1 node tools/devtools-spike/bridge-mode-check.cjs # page-ws 回退对照（同一 fixture、同一探针）
node tools/devtools-spike/toolbar-merge-check.cjs            # 顶栏只有一行、窄抽屉不横向溢出；顺带截 artifacts/devtools-toolbar-merged.png
node tools/devtools-spike/frontend-intent-check.cjs          # 原生停靠菜单/✕ 经 bfbBridge.shell 落到外壳：right→竖向、bottom→横向、close→收起
node tools/devtools-spike/dock-sequence-check.cjs            # 底→左→右（真实按钮，可 BFB_STEP_MS=250 连点）：抽屉矩形与上报矩形必须一致
node tools/devtools-spike/devtools-menu-check.cjs            # ⋮ →「更多工具」子菜单：悬浮出现、移过去是否还在（当前会消失，见 §8.6.1）
node tools/devtools-spike/styles-spin-check.cjs              # Styles 是否加载：BFB_REOPEN=1 切页签回来、BFB_CLICK=1 点节点、BFB_URL 打真站
node tools/devtools-spike/bridge-tab-switch-check.cjs        # 桥模式：切标签容器不重建、面板状态保留、树跟随；并量「切回」的跟随耗时（实测 ~520ms）
BFB_RESET_LOCALE=1 node tools/devtools-spike/bridge-mode-check.cjs # 清掉持久化 language，确认"没存过就跟随系统"
node tools/devtools-spike/bridge-realsite-check.cjs          # 桥模式真站（7k7k）：树/求值/密码捕获 embedded 并发
BFB_HEAVY=1 node tools/devtools-spike/bridge-load-baseline.cjs               # 三模式 CPU 与消息量对比（受控页面）
node tools/devtools-spike/bridge-load-baseline.cjs bridge                    # 只跑桥模式（可配 BFB_WINDOW_MS 拉长窗口）
node tools/devtools-spike/dock-switch-check.cjs              # 四模式停靠：底/左/右/独立窗口 + 关闭回内嵌
node tools/devtools-spike/frontend-bounds-lag.cjs            # 拖拽跟手：前端视图 vs 占位 div 的台阶滞后（BFB_DOCK=right 测横向）
node tools/devtools-spike/newtab-squeeze-check.cjs           # 挤压布局：内容区 711→120，搜索框可见高度恒为 44
node tools/devtools-spike/drawer-geometry-check.cjs          # 切标签几何：抽屉 y 恒等、占位矩形贴合、新标签页显示 no-target 占位
node tools/devtools-spike/sidebar-squeeze-check.cjs          # 侧边栏开合：前端宽度应「一步到位」（动画期间不重排），BFB_NO_DEVTOOLS=1 测页面视图
node tools/devtools-spike/devtools-target-memory-check.cjs   # 「当前页面/外壳界面」按标签记：选外壳 → 新标签页回默认 → 切回恢复
node tools/devtools-spike/flash-probe-debug.cjs              # dump 游戏页结构 + 读 Flash 页实际显示（BFB_URL 指定站点）
node tools/devtools-spike/flash-tab-follow-check.cjs         # Flash 页跟随标签：两标签各挂一个 SWF，切过去 1.2s 内必须换成当前页的
node tools/devtools-spike/probe-deep-check.cjs               # CDP 深探：跨域 iframe（127.0.0.1 → localhost）+ 直载 .swf 的 iframe 都要列出来
node tools/devtools-spike/issues-drawer-check.cjs            # 静态核对 issues-pane 是否仍是 drawer-view（升级前端后复核）
```

2026-11-05 实测：7k7k（4680 节点）上 Elements 树渲染 `html`/`body` 层级、
Styles 显示真实规则、前端异常 0（修复前 Highlight ReferenceError + 每请求
requestTime TypeError + adoptedStyleSheets push TypeError 三层连环）。

### 8.6 顶栏只有一行 + DevTools 容器常驻

顶栏原来有两条：工具箱页签一行、`当前页面 / 外壳界面 / 刷新 / 原生面板` 又一行，
白吃掉 30px 面板高度。现在合并成一行：

```
[DevTools] [捕获 N] [Flash] [主进程 N] │ [当前页面][外壳界面] [↻] [🪟] │ …… [停靠] [✕]
└──────────── 可横向滚动（窄抽屉）────────────┘          └──── 固定 ────┘
```

- 左侧（页签 + DevTools 控件）放在 `.devtools-header-tabs` 里，`overflow-x:auto`
  且隐藏滚动条：右侧停靠常见 340~460px，放不下时滚动，而不是把「捕获」压成「获」。
- 两组之间有一条竖分隔线：页签是「看哪个面板」，右边是「看哪个 target + 两个动作」。
- **图标要能区分**：`↻` 用 `RotateCw`（重建容器），原生面板用 `AppWindow`（窗口轮廓）。
  之前原生面板借了 `ExternalLink`，与右侧「独立窗口」停靠按钮同一个图标，分不出来。
- 右侧（停靠切换、关闭）固定，任何时候都能点到。
- 「清空」只在捕获/主进程页签出现（它清的是采集缓冲，在 DevTools 页签上没意义）。
- 「刷新」的重建计数从组件内 `useState` 挪到 store（`devtoolsReloadToken`），
  因为按钮和消费者已经不在一棵子树里了。

**停靠状态是双向同步的**（2026-11-06 第二轮）：

- 外壳 → 前端：抽屉停靠变化时推 `devtoolbox:set-dock`，devtools preload 记下，
  前端补丁让 `DockController.dockSide()` **优先返回这个值**——原生「停靠侧」菜单的
  勾选读的就是它，不推的话永远勾在初始的「底部」（实测在右侧停靠时勾着底部）。
- 前端 → 外壳：菜单点击与 ✕ 改发意图（见下表），前端**不**自己改 dockSide
  （否则会在 BrowserView 里画出错布局）。

**切停靠后原生视图不跟随**（右→左最典型）：抽屉从右换到左时宽高完全一样、只有 x 变，
`ResizeObserver` 不触发，视图就留在原处（现象：抽屉在左、画面还在右）。修法：
`DevToolsTab` 在 `dock` 变化后补报三次（下一帧、+120ms、+350ms，每次取当下真实矩形）：
只报一次不够稳，切停靠常伴随侧边栏/抽屉过渡，布局可能晚一两拍才定格。
判据 `dock-sequence-check.cjs`（按真实按钮点 底→左→右，也可用 `BFB_STEP_MS=250` 快速连点）
+ `BAO_DEVTOOLS_BOUNDS_LOG=1`：抽屉 x=742 时必须上报 x=746，切换侧必须 x=0。

**原生 DevTools 自带的停靠菜单与 ✕ 已接进外壳**。它们原来各走各的：

| 原生控件 | 原行为 | 现在 |
| --- | --- | --- |
| `⋮ → 停靠侧 → 底部/左侧/右侧/独立窗口` | 改前端自己的 `dockSide`：在 BrowserView 里只会画出错的布局（主区空白、标签条换边） | 补丁改成发意图 `bfbBridge.shell({dock})` 并**跳过** `setDockSide`，由外壳 store 落地 |
| 工具栏 `✕` | `InspectorFrontendHost.closeWindow()` 在这套壳里是空实现，点了没反应 | 改成 `bfbBridge.shell({close:true})` → 外壳收起抽屉（undocked 时连带关独立窗口） |

链路：前端 → `bfbBridge.shell`（devtools preload）→ IPC `devtoolbox:frontend-intent`
（只接受前端 WebContents 这个 sender，参数走 zod 白名单）→ 主窗口 renderer →
`useDevToolStore.setDock/setOpen`。判据 `frontend-intent-check.cjs`：
`dock=right` → 抽屉变 538×711 竖向；`dock=bottom` → 回到 1280×479；`close` → 抽屉消失。

**DevTools 容器在抽屉内常驻挂载**：切到「捕获/Flash/主进程」只把它 `display:none`，
不卸载。不这么做的话每次切回来都要销毁原生视图、重启前端，代价有两层：
面板状态全丢；**新前端会拿旧 nodeId 去要样式**，Styles 面板显示「找不到匹配的选择器
或样式」（page-ws 路径同样如此，所以不是桥的锅）。隐藏时占位矩形为 0，`report()`
把原生视图挪到 `(-8,-8,1,1)`，否则这层原生视图会盖住其它页签的内容。
关抽屉时整棵树卸载，视图照常销毁，不留后台开销。

**没有 page target 的标签页（新标签页 / 用户脚本页）不销毁容器**：只把占位 div
`display:none`、原生视图挪到 `(-8,-8,1,1)`，并把「没有可调试的页面」文案显示出来。
以前这里会 `setUrl(null)` → 容器 effect 清理 → 原生视图销毁，切回来要重建前端，
而**新实例不会自动选中节点**，Styles 就空着/转圈（实测必须手动切一次
「外壳界面 → 当前页面」）。容器常驻后，切回 1.2s 内样式就在（实测 textLen 50）。
同时 no-target 的重试从 3×500ms 收到 1 次：`about:` 开头的标签页根本不可能有 target，
占位出现耗时 3s+ → **420ms**。独立窗口按钮在无 target 时直接禁用（点了原来毫无反应）。

同一标签刷新后，Styles 曾停在「找不到匹配的选择器或样式」。7k7k《皮卡堂》实测：
刷新后 Elements 已经重建树并选中**新文档**的节点，同一个新 nodeId 的样式请求
**先成功一次**，随后 Chromium 87 返回 `Could not find node with given id`。

**这是兼容垫片，不是根因修复**——作废发生在 Chromium 87 的 DOM agent 里，应用层看不见：

| 观测 | 结果 |
| --- | --- |
| 桥的完整流水（`stats().flow`） | `frameNavigated → documentUpdated → DOM.getDocument`（拿到新文档）`→ CSS 成功一次 → CSS 报 Could not find node`，**中间没有任何 DOM 命令** |
| 纯 fixture 刷新 | 不复现 |
| fixture + 跨域 iframe 刷新 | 不复现 |
| 《皮卡堂》（Flash 插件 + 子帧导航）刷新 | 稳定复现 |

也就是说没有"可预防的那一步"：新 id 在被用过之后才被后端作废，且不伴随任何会话内可见的
DOM 调用。所以只能事后自愈：CSSModel.getMatchedStyles 命中该错误且针对当前文档时，
150ms 合并、每个 `mainFrame.loaderId` 最多恢复一次，调 `domModel.documentUpdated()`
重取 DOM，由 Elements 原有逻辑恢复选中与规则。实测刷新后 +1.5s 仍是占位、**+4s 自动恢复**
（规则齐全，不需要点节点）。

试过但**无效、已回退**的"根因候选"：把 `DOMModel.documentUpdated()` 里
`this.parentModel() && …` 改成无条件重取（主文档模型也重取）。加上它之后流水变成
`documentUpdated → DOM.getDocument → CSS 成功 → CSS 仍报 stale id`，问题不变——
证明"没重取文档"不是根因，作废发生在重取之后。

判据：`BFB_RELOAD=1 BFB_URL=https://news.7k7k.com/pkt/ node tools/devtools-spike/styles-spin-check.cjs`。

### 8.6.1 已知问题：⋮ →「更多工具」子菜单一移就消失（未修）

现象：悬浮「更多工具」子菜单能弹出，指针往子菜单移动的过程中它就关闭，够不到里面的项。

已复现（`devtools-menu-check.cjs`，用 CDP `Input.dispatchMouseEvent` 走真实指针轨迹）：

| 观测 | 右停靠 | 底停靠 |
| --- | --- | --- |
| 父菜单 | x=332 w=202 h=244 | x=1078 w=202 h=244 |
| 子菜单（悬浮后出现） | x=176 w=160 **h=530** | x=905 w=160 h=290（贴满视口） |
| 两者位置关系 | 左侧、与父菜单重叠 4px | 左侧、**留 13px 缝** |
| 移过去之后 | 子菜单消失（count 2→1） | 同样消失 |

已排除（各自打了补丁实测，均**无效**，已回退）：

1. 「高亮项变成 null 时不要关子菜单」：`highlightMenuItem` 里
   `this.subMenu && this.subMenu.discard()` 加 `e &&` 守卫 —— 现象不变；
2. 「子菜单开着时，离开菜单项不清高亮」：`menuItemMouseLeave` 开头 `if (this.subMenu) return`
   —— 现象不变。

说明关闭它的调用不在这两条路径上。目前的障碍是**取证**：在页面主上下文里挂
`mouseover/mouseleave` capture 监听，指针移动期间一条事件都没收到（子菜单却真的
按 150ms 定时器弹出来了），所以还看不到真实的关闭者是谁。下一步要在正确的执行上下文里
（`Runtime.executionContextCreated` 挑主世界）装监听，或给 `SoftContextMenu.discard()`
打一条带调用栈的临时标记再复现。

临时绕过：用命令菜单（`Ctrl+Shift+P`）搜索面板名，能打开「渲染 / 动画 / 覆盖率 / 记录器」
这些同属「更多工具」的面板。

### 8.7 拖拽跟手（同步 bounds）

抽屉拖拽时，前端视图的矩形走**同步 IPC**（`devtoolbox:set-devtools-bounds-sync`），
其它场景（窗口缩放、停靠切换）仍走异步。原因：异步通道会把原生视图的更新推到下一帧，
而快速拖拽每帧位移几十像素，表现就是"内容慢半拍、松手再跳一下"。

实测（`frontend-bounds-lag.cjs`，往返拖拽 47 个尺寸台阶，两端 rAF 自采样后按时间轴对齐）：

| | 台阶滞后中位 | p90 | 最大 |
| --- | --- | --- | --- |
| 异步 IPC | 8ms | 13ms | 72ms |
| 同步 IPC | 2ms | 3ms | 4ms |

同步通道的约定：主进程**必须先写 `event.returnValue`**，否则渲染线程会一直被挂住
（不是超时，是卡死）；只放行 `devtoolbox:set-devtools-bounds-sync` 这一条，
preload 侧有独立白名单 `ALLOWED_SYNC_CHANNELS`。

### 8.8 抽屉挤压时的页面布局

新标签页 `.newtab-shell` 原来是 `justify-content: center`：内容比容器高时（抽屉拉高到
内容区 < 331px），Chromium 87 会把上下两端各裁一半（`safe center` 要 93+ 才支持），
搜索框直接被裁到可视区外。改成外层 `overflow-y: auto` + 内层 `.newtab-inner { margin: auto }`：
空间够就居中、不够就贴顶且可滚动。判据 `newtab-squeeze-check.cjs`——把内容区从 711
压到 120，`inputVisible` 恒为 44、`canScroll` 从 320 起为 true。

## 9 CDP 桥（桥 v2，**B3 起为默认传输**）

规格：`docs/archive/superpowers/specs/2026-11-06-devtools-cdp-bridge-design.md`。
默认走桥；`BAO_DEVTOOLS_PAGE_WS=1` 回退到前端直连 CDP 端口（切标签会重载容器）。

### 9.1 形态

```
M97 前端（BrowserView，file://）──window.bfbBridge（preload）──IPC──主进程桥──browser ws/flatten session──→ 目标 agent
密码 capture/fill ─────────────────── embedded（wc.debugger）──────────────────────────────────────────→ 同一 agent（互不干扰）
```

B3 之前前端跑在外壳的 iframe 里，靠 postMessage → 外壳 relay → IPC 中继；迁到
preload 后这条中继整个删了（`useDevToolsBridgeRelay.ts` 已移除），少一次跨 frame
序列化，也让桥和 `file://` 分区隔离得以共存（原来桥模式必须回退 http 才有 parent）。

前端 patch（`scripts/build-devtools-frontend.cjs`）：`core/sdk/sdk.js` 的 Connection
工厂在「无 `ws`/`wss`/`embedded` 参数 + `window.bfbBridge` 存在」时返回
`BfbBridgeConnection`（包装 preload API 的薄壳）。判据从「在 iframe 里」换成
「bfbBridge 存在」：容器换成 BrowserView 后没有 parent，但 preload 一定注入；
旧 http 容器没有 preload，自然落到 page-ws。

**preload 是独立的一份**（`src/preload/devtools.ts` → `dist/devtools-preload.js`），
只暴露 `bfbBridge`，**不暴露 `electronAPI`**。把主 preload 挂给前端等于让它拿到
`pwd.*`（密码库）与 `tab.*`，B2 的隔离目标当场作废。

### 9.2 三条硬约束（都是踩出来的）

1. **响应与事件必须走同一条有序流**。响应经 IPC promise、事件走合批队列会让
   `DOM.setChildNodes` 先于所属请求的响应到达，前端把子节点挂到不存在的父节点上
   丢弃 → Elements 树残缺、闪回旧文档。桥内统一队列 + 16ms 合批；响应信封用前端的
   请求 id（不是桥内部 messageId）。
2. **Target 域按 page-ws 语义模拟**（S14 基线为准）：`setAutoAttach` 不转发到
   browser 级（否则 attach 无关 target 并回 `attachedToTarget`，前端拿到别人的
   sessionId）；`setDiscoverTargets` 补发全部 page target 的 `targetCreated`
   （`attached:true`）；主 target 不发 `attachedToTarget`。
3. **热切换要重放域状态**。桥模式 URL 恒定 → 切标签容器不重建，但前端不知道
   连接换了页面、不会重发初始化命令；桥必须把前端发过的开关类命令（enable/setXxx/
   trackXxx/startXxx，按方法去重保留最新参数）重放到新 session，再发
   `DOM.documentUpdated` + `Runtime.executionContextsCleared`。过渡态
   （新标签 `about:blank`）静默重试，**不能回 `detached`**（前端会显示断开横幅并停请求）。
4. **绑定候选必须排除前端自己**。前端也是 page target；`isFrontendTarget` 早先只认
   `?ws=`，桥模式的 `?can_dock=true` 漏网，切标签时新标签还是 about:blank，绑定
   走 fallback 就把前端容器掳了过来 → 热切换看到 targetId 相同直接早退，面板永远
   停在错误文档上。同一条 fallback 也只接受 `about:` 的无人占用 target，不再"随便挑一个"。
5. **解析 target 必须带 tabId，不能读主进程的"活动标签"**。切标签是渲染层先更新、
   主进程后跟上的（`tab:switch` IPC 还没落地），这段窗口里 `tabManager.getActiveId()`
   仍指向上一个标签。桥模式 URL 恒定 → 解析到旧 target 既不会触发重渲染也不会再解析，
   面板就永远停在上一个页面上（现象：切到新标签页后 Elements 里还是上一个页面的 DOM）。
   现在 `devtoolsUrl` / `attach-devtools-view` / `bridge.attach` / `open-devtools-window`
   / `probe-page` / `snapshot` 都接受 `tabId`，由渲染层把"用户看到的是哪个标签"传下去；
   渲染层另外丢弃迟到的响应（`useTabsStore.getState().activeTabId !== 请求时的 tabId` 就丢）。
   除 `tabId` 外，**同一标签内的导航也要能重探**：新建标签页从 `about:newtab` 走到真实页面
   时 `tabId` 不变，只看 `tabId` 会一直停在空结果上（现象：Flash 页空着，按 F12 才刷新）。
6. **换 target 时必须把在途请求判失败**。`detach()` 会清掉 session，但旧 session 上
   已经发出去的请求永远不会有响应；桥不主动失败，前端那边就是一个永远 pending 的
   Promise——**表现是 Styles/Computed 一直转圈，只能重新点一次节点才恢复**。
   现在 `detach()` / `shutdown()` / `Target.detachedFromTarget` 都会 `failPending()`，
   另加 15s 兜底超时（target 卡死时也能收尾）。`bridge.stats().failed` 是被判失败的条数。
7. **失败信封必须只发给同一个前端实例**（`frontendEpoch`）。前端的请求 id 是**每条连接
   各自从 1 开始**的：旧前端留下的长轮询请求如果在新前端起来之后才超时，那条
   `{id, error}` 会命中新前端里同号的请求，它的 CSS 模型就此失效——**Styles 面板永久
   空白，点节点也没用**。所以 `beginFrontendSession()` 在新建容器时 +1 代号并**静默**
   丢弃旧请求；超时/failPending 只对同代号的条目回信封。
8. **长轮询方法不能套超时**。`CSS.takeComputedStyleUpdates`（Chrome 88+ 引入，87 后端
   可能一直不回）语义是"有变化才回包"，15s 超时只会在 CSS 模型里塞一个错误响应。
   它被列进 `LONG_POLL_METHODS` 白名单，靠 detach/断开收尾。

### 9.3 开关与限制

| 开关 | 作用 |
| --- | --- |
| （默认） | 桥 + BrowserView + `file://` |
| `BAO_DEVTOOLS_PAGE_WS=1` | 前端直连 CDP 端口（URL 带 `ws`），切标签重建容器、面板状态丢失 |
| `BAO_DEVTOOLS_LEGACY_HTTP=1` | 旧的 http 静态服务 + iframe 容器（排障用；没有 preload，必然是 page-ws） |
| `BAO_DEVTOOLS_BRIDGE_RAW=1` | 桥内不做 Target 域重写，全透传（对拍 S14 基线用） |

`BAO_DEVTOOLS_BRIDGE=1` 自 B3 起**不再有效**（桥已是默认），保留该值不会有副作用。

- `BridgeStats` 里的 `flow` / `trace` / `lastMethods` / `lastDoc` 是调试字段（只记
  方法名与条数，不落 CDP 流量），上游排查时可直接读 `bridge.stats()`。
- **单实例语义**：桥只有一个 session，事件投给 `getDevToolsFrontendContents()` 选中的那个
  容器（内嵌视图优先，其次独立窗口）。**正常操作下两个容器不会并存**：抽屉在
  `dock === 'undocked'` 时直接返回 null（`DevToolDrawer.tsx:141`），`DevToolsTab` 卸载即
  `detachDevToolsView()` 销毁内嵌视图；反向的三条出口（关窗 → `setDock` 回内嵌、F12 收起 →
  `closeDevToolsWindow`、建窗失败 → 退回）也都在建/拆之前完成。那句话原来写成"两者同时
  打开时独立窗口收不到事件"，描述的是一个构造不出来的状态，已更正。

