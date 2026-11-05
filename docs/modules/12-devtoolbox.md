# 12 · 内置开发者工具箱（DevToolbox）

> 状态：**首版落地（2026-11-05）**，范围是「不占用 CDP 的只读观察层」。
> 抽屉骨架 + 控制台（页面/外壳）+ 捕获 + Flash + 主进程日志已可用；
> 网络响应体、DOM/CSS 树、断点调试仍未实现（见 §7 后续）。

## 1 范围与目标

在浏览器窗口底部提供一个仿 Chrome 形态的调试抽屉，让「页面控制台、外壳控制台、
密码捕获链路、Flash 插件状态、主进程日志」在应用内直接可见，不需要外接浏览器或翻
`logs/main.log`。

**硬边界**：工具箱**不 attach CDP**。Electron 的每个 `WebContents` 只允许一个 debugger
客户端（`cdp-lease.ts` 的排他租约就是这条事实的落地），而密码捕获长期持有、
自动化按短租约排队、`password-fill` 还会几十毫秒裸 attach。工具箱一旦抢租约，
捕获链路会拿到 `CDP is already attached by an unmanaged client`，即 2026-09-22 那次
7k7k 捕获失效的同一类故障。

**结论**：首版只做非 CDP 观察，能力换稳定性。

## 2 静态结构

| 路径 | 职责 |
| --- | --- |
| `src/main/modules/devtoolbox.ts` | 采集管道：`console-message` 订阅、electron-log hook、快照、求值、页面探测、打开原生面板 |
| `src/main/modules/devtoolbox-buffer.ts` | 纯逻辑：文本截断、等级映射、日志分类、双队列缓冲（可单测，不依赖 Electron） |
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
- 抽屉上沿 6px 可拖拽：`160px` ~ 窗口 80%，双击恢复窗口高度 34%。
- 高度存放在 `localStorage['devtoolbox.height']`（**不进** electron-store 配置：
  高频 UI 状态不该污染需要迁移与校验的 schema）。
- 抽屉是 `.workspace-main` 的最后一个 flex 子项，开合直接压缩 `#browserview-area`，
  由 `App.tsx` 既有的 `ResizeObserver → tab:setBounds` 带动 BrowserView 缩放，
  没有新增边界计算逻辑。拖拽期间用 `requestAnimationFrame` 合帧，避免原生层拖影。

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
| 选择器进不了跨域 iframe | `executeJavaScript` 只作用于主 frame | Flash 站点的游戏页多在 iframe 内：Flash 标签会列出 iframe 地址并标注同源/跨域 |
| 没有断点调试 | 无 CDP 就没有 Debugger 域 | 原生 DevTools 兜底 |
| `console-message` 无对象参数 | Electron 11 限制 | 升级 Electron 不可行（Flash PPAPI → 见 02） |
| 内置面板永远是英文 | Chromium 87 的 DevTools 前端只打包 `locales/en-US.json`，多语言从 Chrome 94 才有 | 无法修改；工具箱即中文替代品 |

**网络面板尚未实现**：`onBeforeRequest` / `onHeadersReceived` 已被 `session-manager.ts`
占用、`onCompleted` / `onErrorOccurred` 已被 `userscript-web-request.ts` 占用，
Electron 11 的 webRequest 监听是「后者覆盖前者」。要做必须先把观察者挂进现有监听链
（参考 `js-patch-service.ts` 的既有模式），不能自行注册。

## 8 DevTools 宿主（2026-11-05 第二轮）

抽屉的第一个标签现在托管**官方 DevTools 前端**，不再是自绘面板。

### 8.1 结构

| 路径 | 职责 |
| --- | --- |
| `assets/devtools-frontend/` | 上游前端资源（取自 chii 的构建产物，面板版本约 M97，640 文件 / 14MB） |
| `scripts/build-devtools-frontend.cjs` | 降级到 Chromium 87：摘 top-level await、esbuild 语法降级、注入 polyfill、补 `-webkit-mask` 前缀 |
| `dist/devtools-frontend/` | 构建产物；开发时由主进程静态托管，打包时进 `resources/devtools-frontend` |
| `src/main/modules/devtoolbox.ts` | `ensureFrontendServer()`（127.0.0.1 + 系统分配端口）、`getDevToolsTargetUrl()` |
| `src/renderer/components/devtools/DevToolsTab.tsx` | iframe 宿主 + 「当前页面 / 外壳界面」目标切换 |

传输链：`iframe(http://127.0.0.1:<static>/inspector.html?ws=127.0.0.1:<cdp>/devtools/page/<id>)`
→ Chromium 的 CDP 端口 → 目标 WebContents。**前端只会说 WebSocket，端口是它的传输层。**

### 8.2 为什么要降级

Chromium 87 是 Flash PPAPI 的硬约束，而 M97 前端用了它不认的东西，三类：

1. **top-level await**（`const x = await import(...)`）→ `SyntaxError: Unexpected reserved word`。
   构建脚本按 esbuild 报的行列精确摘掉 `await`（受影响分支默认不启用）。
2. **语法版本**：esbuild `target: chrome87`，247 个 JS 全部通过。
3. **运行时 API 与 CSS 属性**：`URL.canParse`、`Object.hasOwn`、`Array.prototype.at/toSorted` 等
   由 `bfb-polyfills.js` 前置补齐；`mask:` / `mask-image` 必须补 `-webkit-` 前缀，否则图标全是灰块。

### 8.3 端口与安全

- 静态服务：只监听 `127.0.0.1`，端口系统分配，随应用退出关闭。
- CDP 端口：`--remote-debugging-port`（`npm run start:debug` 用 19222）。**不能在运行时开关**，
  所以要么常开，要么按需重启应用。注意 Windows 保留端口段（实测 9182–9281、9282–9381 会 EACCES），
  选端口前先 `netsh interface ipv4 show excludedportrange protocol=tcp`。

### 8.4 已知缺口

| 缺口 | 说明 |
| --- | --- |
| **没有中文语言包** | 前端有本地化能力（首次打开会弹「DevTools is now available in Chinese」），但 chii 的构建裁掉了 `locales/`，官方 npm 只发源码。补 `locales/zh.json` 才生效 |
| 部分新特性降级 | 后端是 87，前端会向它要 `Network.setAttachDebugStack`、`Overlay.setShowFlexOverlays` 等新方法，返回 `-32601`；主面板不受影响 |
| Preloading 面板的 JSON 高亮常量 | 摘 `await` 后该常量到得晚，只有打开该面板看 JSON 时可能缺色 |

### 8.5 验证

```bash
npm run build                      # 内含 build:devtools-frontend
node tools/devtools-spike/verify-in-app.cjs   # 起应用→点工具箱→截图 artifacts/devtools-in-app-2026-11-05.png
env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron.exe   tools/devtools-spike/electron-frontend-check.cjs   # 单窗口验证前端能否在 87 上启动
```
