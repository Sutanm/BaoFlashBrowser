# BaoFlashBrowser 用户脚本平台 — 开发手册

> 面向**平台扩展开发者**:新增 GM API、IPC 通道、运行时能力,或修改现有行为。
> 脚本作者请参考 `docs/userscript-platform-plan.md`(设计)与本手册 GM API 章节。
> 最终用户操作请参考 `docs/userscript-user-guide.md`。

## 1. 平台定位与硬性约束

**BaoFlashBrowser** 是锁定 Electron 11.5.0 / Chromium 87 的 Flash 兼容浏览器。
用户脚本平台是其内置的油猴(userscript)运行时,用于**页面壳增强**。

- 脚本运行在**页面文档(HTML DOM)环境**,**无法进入 Flash 插件内部**:
  不能改游戏分数/存档/战斗数值,能做的是页面 UI 增强、登录辅助、操作提示、iframe 内嵌入内容等。
- **Electron 版本永不升级**——一切依赖 Chromium 87 行为(下文多处提到的坑都源于此)。
- 两种渲染模式,运行时行为不同(见 §3):
  - **PPAPI 模式**:`contextIsolation: true`,preload 运行在隔离世界,页面 CSP 不约束脚本编译;
  - **Ruffle 模式**:`contextIsolation: false`,preload 与页面共享世界,严格 CSP 页面禁止 `new Function`/eval。

## 2. 架构总览

```
┌──────────────────────────── 主进程 (main) ────────────────────────────┐
│  userscripts/index.ts            单例装配:ScriptStore/ValueStore/      │
│                                   RequireCache/GmRequestService/        │
│                                   GmDownloadService/UserscriptManager   │
│  userscript-manager.ts           视图注册、快照、匹配、命令、通知、报告  │
│  script-store.ts                 electron-store 持久化(脚本本体+元数据)│
│  userscript-parser.ts            元数据解析(// ==UserScript== 块)       │
│  userscript-matcher.ts           @match/@include/@exclude 编译+匹配     │
│  userscript-store.ts             脚本值存储(GM_getValue 等,内存)        │
│  userscript-require-cache.ts     @require 下载缓存(持久 session)        │
│  userscript-request-service.ts   GM_xmlhttpRequest 服务(安全约束)       │
│  userscript-download-service.ts  GM_download 服务(安全约束)            │
│  ipc/userscripts.ipc.ts          runtime 通道(快照/报告/值/菜单/… )     │
│  ipc/userscripts-admin.ipc.ts    管理通道(安装/卸载/启停/编辑/预览)     │
└────────────────────────────────────────────────────────────────────────┘
        │ get-config (sendSync)            │ userscripts:* 通道 (send/invoke)
        ▼                                   ▼
┌────────────────── webview-preload (每个 BrowserView,主框架+子框架) ────┐
│  userscripts/bootstrap.ts       入口:get-config → 建桥 → 调度 → 监听回传 │
│  userscripts/scheduler.ts       run-at 调度(document-start/body/end/idle)│
│  userscripts/sandbox.ts         执行器:参数注入 + Node 遮蔽 + vm 回退    │
│  userscripts/gm-api.ts          GM API 实现(词法注入,永不落全局)        │
│  userscripts/page-bridge.ts     页世界桥(PPAPI 模式 unsafeWindow 通道)   │
│  userscripts/unsafe-proxy.ts    unsafeWindow 代理(postMessage 转发)     │
└────────────────────────────────────────────────────────────────────────┘
        │ contextBridge
┌───────▼───────── 主窗口 preload ─────────┐     ┌──────── renderer (React) ─┐
│  preload/index.ts  ALLOWED_INVOKE_       │     │ UserscriptsPage.tsx  管理页 │
│  CHANNELS 白名单 + userscripts API 桥    │◄────┤ UserscriptsPanel.tsx 侧边栏│
└──────────────────────────────────────────┘     └───────────────────────────┘
```

### 脚本生命周期(单次导航)

1. BrowserView 创建/导航 → preload(bootstrap)在**每个框架**(主框架+子框架)执行;
2. `ipcRenderer.sendSync('userscript:get-config', { url, isMainFrame, documentId })` ——
   **此通道必须已有 handler**,否则渲染进程 IPC 损坏(见 §9);
3. 主进程 `snapshotFor()`:按 URL 匹配脚本(快照预算上限见 §7),返回 `FrameSnapshot`
   (脚本源码 + 值 + 资源,子框架按自己的 URL 独立匹配);
4. bootstrap 按 `mode` 决定隔离策略;PPAPI 模式注入页世界桥,构造 `unsafeWindow` 代理;
5. `scheduleScripts()` 按 `@run-at` 调度执行 `sandbox.executeUserscript()`;
6. 执行结果/阶段通过 `userscript:report` 回传主进程(诊断与冒烟断言用);
7. 脚本内 `GM_*` 调用经 IPC 到主进程服务;
8. SPA 软导航不重建文档、不重跑脚本(`did-navigate-in-page` → `manager.spaNavigate` 仅记录)。

## 3. 执行沙箱与页世界桥

### 词法注入(永不落全局)

`sandbox.ts` 将脚本包成 `(function(){var GM_getValue=legacyGm[...]; ... (function(){<source>})();})();`
并以参数注入:`unsafeWindow, window, document, GM, GM_info, legacyGm`,
同时遮蔽 `require/process/module/exports/Buffer/global/__filename/__dirname`。
脚本内 `GM_getValue` 等传统名是**局部变量**,页面与隔离世界全局均不可见。

### CSP 回退

- PPAPI 模式:`new Function` 在隔离世界编译,不受页面 CSP 限制;
- Ruffle 模式(共享世界):严格 CSP 页面会拒绝 `new Function` →
  `sandbox.ts` 回退 `vm.runInThisContext`(V8 层面编译,绕过 CSP eval 检查)。
  Node 绑定在 preload 闭包中而非页面全局,回退后仍不可达。

### 页世界桥(仅 PPAPI 模式)

`page-bridge.ts` 的 `PAGE_BRIDGE_SOURCE` 经 `webFrame.executeJavaScript` 注入**页面主世界**
(不可用 CDP `Page.addScriptToEvaluateOnNewDocument`:注册随 debugger detach 清除,且挂着的
debugger 冻结导航)。协议:

- 请求/回复共用 `{ __bf: 1, seq, op, path, args }`,经 `window.postMessage` 同步转发;
- 只应答 `event.source === window` 的消息;seq 从随机偏移起步,页面脚本无法伪造回复;
- op:`get / set / del / call / keys / handshake`;函数实参经 `__bfFn` 序列化还原;
- 桥不持有凭据、无 Node 访问——敌意页面经桥能做的事与直接用 window 相同。

Ruffle 模式共享世界,`unsafeWindow === window`,不走桥。

## 4. 模块地图

| 路径 | 职责 | 关键入口 |
|---|---|---|
| `src/main/modules/userscripts/index.ts` | 单例装配、脚本 CRUD、reload | `initUserscriptManager()` / `installUserscript()` |
| `src/main/modules/userscripts/userscript-manager.ts` | 视图注册、快照、匹配、菜单命令、通知、报告、值监听 | `snapshotFor()` / `registerMenuCommand()` |
| `src/main/modules/userscripts/script-store.ts` | electron-store 持久化 | `save()` / `list()` / `get()` / `remove()` |
| `src/main/modules/userscripts/userscript-parser.ts` | 元数据解析 | `parseUserscriptMetadata()` |
| `src/main/modules/userscripts/userscript-matcher.ts` | 规则编译+匹配(纯模块,无 Electron 依赖) | `compileRules()` / `matchesUrl()` |
| `src/main/modules/userscripts/userscript-store.ts` | GM 值存储(内存) | `get()` / `set()` |
| `src/main/modules/userscripts/userscript-require-cache.ts` | `@require` 拉取缓存 | `fetch()` |
| `src/main/modules/userscripts/userscript-request-service.ts` | `GM_xmlhttpRequest` | `request()` / `abort()` |
| `src/main/modules/userscripts/userscript-download-service.ts` | `GM_download` | `download()` / `abort()` |
| `src/main/ipc/userscripts.ipc.ts` | runtime 通道注册 | `registerUserscriptsIPC()` |
| `src/main/ipc/userscripts-admin.ipc.ts` | 管理通道注册 | `registerUserscriptsAdminIPC()` |
| `src/webview-preload/userscripts/bootstrap.ts` | preload 运行时入口 | `initUserscriptRuntime()` |
| `src/webview-preload/userscripts/scheduler.ts` | run-at 调度 | `scheduleScripts()` |
| `src/webview-preload/userscripts/sandbox.ts` | 执行器 | `executeUserscript()` |
| `src/webview-preload/userscripts/gm-api.ts` | GM API 实现 | `createGmApi()` |
| `src/webview-preload/userscripts/page-bridge.ts` | 页世界桥源码 | `PAGE_BRIDGE_SOURCE` |
| `src/webview-preload/userscripts/unsafe-proxy.ts` | unsafeWindow 代理 | `createUnsafeWindowProxy()` |
| `src/renderer/components/userscripts/UserscriptsPage.tsx` | 管理页 | — |
| `src/renderer/components/panels/UserscriptsPanel.tsx` | 侧边栏面板 | — |

## 5. GM API 参考

实现位于 `gm-api.ts`,以 `GM` 对象 + 传统 `GM_*` 名注入脚本词法作用域。

| API | 语义 | 后端通道 | 限制 |
|---|---|---|---|
| `GM_getValue(key, fallback)` | 读脚本值(内存) | sendSync 快照内预载 | 值需可结构化克隆(`GMSerializable`) |
| `GM_setValue(key, value)` | 写脚本值 | `userscript:set-value` | key 非空;值同类型约束 |
| `GM_deleteValue(key)` | 删值 | `userscript:delete-value` | — |
| `GM_listValues()` / `GM_getValues()` | 枚举 | 本地 | — |
| `GM_getResourceText/URL(name)` | `@resource` | 快照预载 | 资源随快照下发 |
| `GM_addStyle(css)` | 注入 `<style data-userscript-style>` | 本地 | — |
| `GM_addElement(...)` | 建元素(带事件属性支持) | 本地 | — |
| `GM_registerMenuCommand(title, cb)` | 注册侧边栏命令 | `userscript:menu-register` | **同脚本+同标题只保留主框架注册**(§9) |
| `GM_unregisterMenuCommand(id)` | 注销命令 | `userscript:menu-unregister` | — |
| `GM_openInTab(url)` | 新标签打开 | `userscript:open-in-tab` | 每文档一次 |
| `GM_xmlhttpRequest(details)` | 跨域请求 | `userscript:xhr-request` / `-abort` | 见 §7 安全约束 |
| `GM_download(details)` | 下载文件 | `userscript:download` / `-abort` | 见 §7 安全约束 |
| `GM_addValueChangeListener(key, cb)` | 值变化监听(含跨页面 remote) | `userscript:value-listener-add/remove` | 变化经 `userscript:value-changed` 回传 |
| `GM_setClipboard(text)` | 剪贴板 | `userscript:set-clipboard` | ≤1MB |
| `GM_notification(details)` | 系统通知 | `userscript:notification` | 点击回调经 manager 回传(文档 id 校验) |
| `unsafeWindow` | 页主世界代理(PPAPI)/window(Ruffle) | 页世界桥 | 见 §3 |

`GM_info`:`{ script: { id, name, version, description, namespace, ... }, scriptMetaStr, scriptHandler, platform, version, ... }`。

### 元数据(`@` 指令)支持矩阵

| 指令 | 支持 | 说明 |
|---|---|---|
| `@name` / `@namespace` / `@version` / `@description` | ✅ | `@name`+`@namespace` 决定脚本 id |
| `@match` | ✅ | Chrome match-pattern 语义,无端口匹配任意端口 |
| `@include` / `@exclude` / `@exclude-match` | ✅ | glob;无 scheme 时匹配任意 scheme;exclude 永远优先 |
| `@run-at` | ✅ | document-start/body/end/idle;缺省 document-end |
| `@grant` | ✅ | 解析(平台不按 grant 白名单收紧,全量注入) |
| `@require` | ✅ | 持久 session 拉取 + 内存缓存 |
| `@resource` | ✅ | 随快照下发 |
| `@connect` | ✅ | GM_xmlhttpRequest 域名白名单(与 UA/来源检查结合) |
| `@noframes` | ✅ | 子框架不执行 |
| `@noframes` 缺省 | — | 子框架按自身 URL 独立匹配执行(注意 §9) |

匹配语义详见 `docs/userscript-platform-plan.md` §9 与 `userscript-matcher.ts` 头注。

## 6. IPC 通道参考

所有通道**必须**在 `preload/index.ts` 白名单注册后才可被渲染进程调用,payload 全部 zod 校验。

### Runtime 通道(webview-preload → 主进程,`userscripts.ipc.ts`)

| 通道 | 类型 | payload | 说明 |
|---|---|---|---|
| `userscript:get-config` | sendSync | `{ url, isMainFrame, documentId }` | **必须常驻 handler**(§9);返回 `FrameSnapshot` |
| `userscript:report` | send | `{ documentId, frameUrl, isMainFrame, mode, generation, phase, detail? }` | 阶段/结果报告 |
| `userscript:set-value` | send | `{ scriptId, key, value }` | 校验脚本已安装 |
| `userscript:delete-value` | send | `{ scriptId, key }` | — |
| `userscript:menu-register` | send | `{ commandId, scriptId, documentId, isMainFrame?, title }` | commandId 格式 `文档:脚本:自增` |
| `userscript:menu-unregister` | send | `{ commandId }` | — |
| `userscript:open-in-tab` | send | `{ scriptId, url }` | — |
| `userscript:menu-invoked` | send | `{ documentId, scriptId, commandId }` | 执行回执(诊断) |
| `userscript:value-listener-add/remove` | send | `{ scriptId, key, listenerId }` / `{ scriptId, listenerId }` | — |
| `userscript:set-clipboard` | invoke | `{ text }` | ≤1MB |
| `userscript:notification` | invoke | `{ scriptId, documentId, text?, title? }` | 返回 `{ ok, notificationId }`;点击路由回调 |
| `userscript:download` | invoke | `{ scriptId, pageUrl, details, localId }` | 返回 `{ ok, error?, fileName?, status? }` |
| `userscript:download-abort` | send | `{ localId }` | — |
| `userscript:xhr-request` | invoke | `{ scriptId, pageUrl, details, localId }` | 返回 `{ ok, error?, ... }` |
| `userscript:xhr-abort` | send | `{ localId }` | — |

主进程 → preload:`userscript:menu-invoke`(按 documentId 路由)、`userscript:value-changed`、
`userscript:notification-click`、`userscript:probe-late`(测试用)。

### 管理通道(渲染进程 → 主进程,`userscripts-admin.ipc.ts`)

| 通道 | payload | 说明 |
|---|---|---|
| `userscripts:list` | (可选无参) | 已安装脚本列表 |
| `userscripts:get-source` | `{ id }` | 脚本源码 |
| `userscripts:parse-source` | `{ source }` | 两阶段安装第一步:解析预览(不落盘) |
| `userscripts:install-source` | `{ source, enabled? }` | 确认后安装/覆盖 |
| `userscripts:install-file` | (可选无参) | 文件对话框→读取源码(仅取回) |
| `userscripts:install-url` | `{ url }` | 主进程拉取,上限 2MB |
| `userscripts:uninstall` | `{ id }` | — |
| `userscripts:set-enabled` | `{ id, enabled }` | — |
| `userscripts:update-source` | `{ id, source }` | 编辑保存 |
| `userscripts:for-tab` | `{ tabId, url }` | 侧边栏:匹配脚本 + 命令列表 |
| `userscripts:invoke-command` | `{ tabId, commandId }` | 执行侧边栏命令,返回 `{ ok }` |

注意:管理通道 `userscripts:list` 等**无参通道用 `z.object({}).optional()`**(裸 `z.object({})`
校验 `undefined` 会失败——历史坑)。

## 7. 数据、预算与安全

- **脚本持久化**:`ScriptStore`(electron-store,userData 下 `userscripts.json`);**值存储**:`ValueStore` 仅内存。
- **快照预算**:单页脚本源码总量 ≤ `maxSourceBytesPerPage: 512KB`(超出截断不执行),
  快照 ≤ `maxSnapshotBytes: 64KB`(超出丢弃部分脚本,保证 sendSync 响应上限)。
- **GM_xmlhttpRequest**:走 `persist:` 会话(与标签页同会话),`@connect` 校验 +
  仅允许 loopback 白名单(`127.0.0.1`/`localhost`)、重定向 ≤5、响应 ≤32KB、超时 3s、
  每脚本并发 ≤2、全局 ≤8。
- **GM_download**:同样会话与 loopback 白名单,单文件 ≤8KB(平台辅助下载场景),保存到
  `userData/userscript-downloads/`。
- **校验入口**:每个通道 zod safeParse;`registerMenuCommand` 校验 commandId 形状
  (`documentId:scriptId:正整数` 前缀匹配),防止伪造。
- 凭据类数据**永不**经渲染进程 IPC 或 console 传输(密码模块独立约定)。

## 8. 构建与测试

```bash
npm run check        # i18n → typecheck → lint → vitest → 生产构建(提交前必跑)
npm start            # i18n → build → electron(开发运行)
npm run test:userscripts          # runtime 冒烟(先 node 构建再 electron 执行)
npm run test:userscripts-admin    # 管理端到端冒烟(安装→执行→启停→跨重启→卸载)
```

### 冒烟矩阵

| 冒烟 | 入口 | 验证点 |
|---|---|---|
| `tests/electron/build-userscript-runtime-smoke.mjs` | 构建 `release/tests/userscript-runtime-preload.cjs` | preload 运行时打包产物 |
| `tests/electron/build-userscripts-admin-smoke.mjs` | 构建 `release/tests/userscripts-admin-module.cjs` | 主进程服务打包产物 |
| `tests/electron/userscripts-admin-smoke.cjs` | `npm run test:userscripts-admin` | 管理全流程(真实脚本) |
| `tests/electron/menu-command-dedupe-smoke.cjs` | 手动 electron 执行 | 主框架+iframe 命令去重与执行 |
| `tests/electron/demo-test-verify.cjs` | 手动 electron 执行 | 真实站端到端徽章/桥/计数 |
| `tests/electron/install-demo-test-script.cjs` | 手动 electron 执行 | 测试脚本安装(userData 固定 `%APPDATA%\bao-flash-browser`) |

**新增冒烟的模式**:esbuild 打包主进程侧模块到 `release/tests/`,electron 脚本内
`require` 该产物 + 自建 http 服务器 + `BrowserView`(`partition: 'persist:<name>'`),
并**手动注册测试所需的全部 ipcMain 监听**(冒烟不加载 `userscripts.ipc.ts`,通道需自己
mock,如 `userscript:menu-register` → `manager.registerMenuCommand(...)`)。

### 工具脚本

| 脚本 | 用途 |
|---|---|
| `tests/electron/fixtures/demo-test.user.js` | 平台自测脚本(徽章/计数/命令/通知/桥) |
| `tests/electron/install-demo-test-script.cjs` / `demo-test-verify.cjs` / `diag-script-store.cjs` | 安装/验证/诊断(必须指向 `bao-flash-browser` userData) |

## 9. Landmines(历史血泪,扩展前必读)

1. **`webContents.send` 只达主框架 preload**——子框架注册的 `GM_registerMenuCommand`
   永远无法被调用。主进程已按 `scriptId+title` 去重、仅保留 `isMainFrame` 注册项。
   改这条链路时勿破坏去重,否则侧边栏出现重复且点击无效的命令。
2. **preload 的 sendSync 打到无 handler 通道会累积渲染进程 IPC 损坏**——第 3 次连续
   `loadURL` 渲染进程永久卡死(JS_HUNG、CDP 不可达)。`userscript:get-config` 的 handler
   必须在任何视图导航前注册完毕(应用启动时)。
3. **页世界桥注入只能用 preload `webFrame.executeJavaScript`(主世界)**——CDP
   `Page.addScriptToEvaluateOnNewDocument` 的注册随 debugger detach 清除,且挂着的
   debugger 冻结导航。
4. **SPA 软导航不建文档**——脚本不重跑,URL 变化仅经 `did-navigate-in-page` → `spaNavigate`
   记录;禁止在 preload patch `history`。
5. **跨域 iframe 不可达**——`executeJavaScript` 只在主框架;子框架脚本能力天然受限
   (命令回调、桥都在各文档自己的 preload 上下文)。
6. **子框架双执行是特性**——`nodeIntegrationInSubFrames: true` 下子框架按自身 URL 独立
   匹配执行脚本,`@noframes` 可关;测试徽章在 Flash 游戏 iframe 上"叠加"即源于此。
7. **Chromium 87 上 `did-fail-load` 后调用 `wc.stop()` 会杀死登录后重定向**——与脚本平台
   相关导航逻辑勿引入 stop 调用。
8. **同源 iframe 徽章/脚本冲突**——页面与 iframe 各自 `GM_*` 值独立(值按脚本 id 共享,
   但 DOM/监听不共享),调试"为什么跑了两次"先确认 URL 匹配到了几个文档。
9. **Ruffle 模式共享世界**——`stripNodeGlobals` 只在 PPAPI 模式运行;Ruffle 下页面的
   `'process' in window` 探测必须保持为 false,勿往页面全局放任何 Node 绑定。
10. **无参 IPC 通道 zod 必须 `optional()`**——`z.object({})` 校验 `undefined` 会失败,
    无参通道(如 `userscripts:list`、`userscripts:install-file`)必须用 `z.object({}).optional()`。

## 10. 常见扩展任务速查

### 新增一个 GM API(如 `GM_log`)

1. `gm-api.ts`:在 `GmApi` 接口加签名 + `createGmApi` 内实现(本地能力直接实现,远端能力走 bridge);
2. 远端能力:在 `userscripts.ipc.ts` 注册通道(zod payload;send 用 `registerValidatedListener`,
   invoke 用 `createValidatedHandler`/`ipcMain.handle`);主进程逻辑加在对应 service 或 manager;
3. 需要进脚本作用域:在 `sandbox.ts` 的 `LEGACY_GM_NAMES` 加传统名,`gm-api.ts` 的 `legacy`
   对象加映射(bootstrap 会注入);
4. 类型:`src/shared/userscript-types.ts` 加共享类型;`preload/index.ts` 白名单若渲染进程
   需要调用则加通道;
5. 验证:vitest(parser/matcher 等纯模块)+ 冒烟(fixture 脚本调用新 API 并断言效果)。

### 新增 IPC 通道

1. `userscripts.ipc.ts` / `userscripts-admin.ipc.ts` 注册(zod 校验);
2. `preload/index.ts` `ALLOWED_INVOKE_CHANNELS` 加通道名(渲染进程侧);
3. `src/renderer/types/electron.d.ts` 更新 API 类型;
4. 无参通道记得 `z.object({}).optional()`(Landmine 10)。

### 新增元数据指令(如 `@inject-into`)

1. `userscript-parser.ts` 解析字段;
2. `userscript-types.ts` 的 `ParsedUserscriptMetadata` 加字段;
3. 消费点:快照(manager)、匹配(matcher)、调度(scheduler)/执行(sandbox);
4. 管理页预览(`userscripts:parse-source` 返回)同步补字段。
