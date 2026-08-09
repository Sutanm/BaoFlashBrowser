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

### 4.1 内置捆绑脚本（Bundled Built-in Scripts）

应用自带的内置脚本（如 **BaoFlash Modern CSS Fixer**）由 `src/main/modules/userscripts/bundled-scripts/` 管理：

- `css-fixer-core.ts` — 纯逻辑层（无 DOM），`rewriteCssText()` 依次执行：`@layer` 拆层、CSS 嵌套展开（手写 postcss AST 遍历，零依赖）、`@container` 哑标记、`:where()`/`:is()` 拆包、`dvh→vh`；颜色换算在 `css-fixer-color.ts`（oklch/oklab/lch/lab/hwb/color(display-p3)/color-mix srgb|oklab → rgb，W3C 公式手写）。单测在 `tests/userscripts/css-fixer-core.test.ts`、`css-fixer-color.test.ts`。
- `css-fixer-entry.ts` — 脚本运行时本体（document-start、MutationObserver 文本层改写、`<link>` 禁用→fetch→替换为 `<style>`、**Next.js Image 修补**：`img[width="0"]` + CSS `width:100%` 在 C87 会按 SVG 固有宽度渲染（ruffle.rs 徽章 661px vs 现代浏览器 218px），渲染宽 > 2.5×HTML height 时改为 `width:auto; height:<attr>px` 对齐现代浏览器）；`/// <reference lib="dom" />` 因为 main tsconfig 无 DOM lib。
- `css-fixer.user.js` — **打包产物，提交入库**：`node scripts/build-css-fixer.mjs`（esbuild + banner 元数据头）生成；esbuild main 构建用 `loader: { '.user.js': 'text' }` 以文本嵌入主进程（见 `esbuild.main.config.mjs`、`bundled-scripts/asset.d.ts`；vitest 配置有同语义的 `user-js-as-text` 插件，产物永不作为 JS 执行）。
- `vendor/container-query-polyfill.js` — GoogleChromeLabs 容器查询 polyfill（Apache-2.0）**vendor + 单补丁**：其 `<style>` 处理器只转译含容器查询信号（`@container`/`container-type`/cq 单位）的 sheet，普通现代 sheet 完全交给 Fixer 的文本层。配合机制：Fixer 先改写（含哑标记）→ polyfill 异步 innerHTML 写回（其持久的应用机制；insertRule 注入的规则会被文本替换清空）→ Fixer 的 MutationObserver **重验证**被外部改写的已标记 style（observer 必须处理目标为 STYLE 的 childList 文本突变——这是合作的关键）。已知边界：同 sheet 内的 CSS 嵌套会被 polyfill 转译丢弃（C87 下其解析器不支持 `&`）；容器查询应用为无守卫近似（条件恒真，不精确匹配容器尺寸）。
- **ES2022 JS 语法补丁在主进程（`src/main/modules/js-patch-service.ts`）而非 Fixer**——C87 的 `<script>` 在 observer 微任务内就加载解析，渲染层补丁必然输掉竞态；只有 URL 层拦截能赢。机制：`session-manager.ts` 的**单一** `webRequest.onBeforeRequest` 监听（`*://*/*`）识别 Next.js chunk（`/_next/static/chunks/*.js`）→ 重定向到自定义协议 `bf-js-patch://chunk?src=<原URL>` → 协议 handler（`registerBufferProtocol`）用 Node http(s) 拉取原 chunk → `patchModernJs`（`css-fixer-core.ts` 导出：安全的 `static{this.X=ref}` → `static get X(){return ref}`）→ 返回补丁版（内存缓存 200 条/64MB）。浏览器从源头拿到兼容代码，Turbopack 状态干净。安全：仅 https/http + `isBlockedUrl`（loopback 白名单与 GM_xmlhttpRequest 一致）。
- **JS 补丁的已知边界**（v0.3.4 修正链）：① **Electron 11 的 `webRequest.onBeforeRequest` 监听器互相覆盖**——多次注册后只保留最后一个，js-patch 必须与 swfobject 重定向合并进 session-manager 的**单一监听器**；② redirect 目标必须用**自定义协议** `bf-js-patch://`（https 页面 redirect 到 http://127.0.0.1 会被 mixed-content 阻止）；③ **http（非 https）页面无法加载自定义协议**（Electron 11 安全限制，`registerSchemesAsPrivileged` 也豁免不了）——https 站点受益，http 老站降级为原样；④ 协议 handler 内 `net.request` 报 `ERR_UNKNOWN_URL_SCHEME`，改用 Node http(s) 模块 fetch（代理网络降级）；⑤ 内容缓存（Map，200 条/64MB 上限，chunk URL 内容哈希不变故安全）；⑥ 严格 CSP（`script-src` 无 `bf-js-patch:`）与 Service Worker 拦截的 chunk 不在补丁范围（与现状一致，无更差）。
- **页面主世界 Web API polyfill**（`src/webview-preload/index.ts`）：Chromium 87 缺现代 Web API 时整个站点 JS 崩溃（GitHub：`crypto.randomUUID is not a function` → React 不挂载）。preload 在 document-start 用 `webFrame.executeJavaScript` 把 polyfill 注入**页面主世界**（与页世界桥同机制，早于页面脚本）；隔离世界的原型补丁无效（各世界独立），必须主世界注入。当前补 `crypto.randomUUID`（v4，`getRandomValues` 实现）；新增 API 缺失时在此处追加源码字符串即可。
- 自动安装：`userscripts/index.ts` 的 `BUNDLED_SCRIPTS` 表在 `initUserscriptManager()` 时对缺失 id 执行 `installUserscript()`——**只补缺、不覆盖用户编辑；用户删除后下次启动自恢复**。管理与普通脚本一致（可编辑/禁用/删除）。
- **内置脚本自动更新**：打包产物的 `@version` 提升时，`ensureBundledScripts()` 会更新未编辑的安装（保留 enabled 状态）；用户在编辑器保存过（`InstalledUserscript.edited = true`）的脚本**永不覆盖**。改内置脚本记得升 `@version`，否则已装用户不会收到新版本。
- 修改内置脚本后：`npm run build:css-fixer` 重新生成产物，再跑 `npm run test:css-fixer`（fixture 页端到端冒烟，含版本升级/编辑保护断言）。

新增第二个内置脚本的步骤：在 `bundled-scripts/` 放 entry 源文件 → 仿照 build-css-fixer.mjs 建打包脚本 → 在 `esbuild.main.config.mjs`/admin smoke build 的 loader 已就绪 → `BUNDLED_SCRIPTS` 加一项。

## 5. GM API 参考

实现位于 `gm-api.ts`,以 `GM` 对象 + 传统 `GM_*` 名注入脚本词法作用域。

| API | 语义 | 后端通道 | 限制 |
|---|---|---|---|
| `GM_getValue(key, fallback)` | 读脚本值(快照预载+跨重启持久化) | sendSync 快照内预载 | 值需可结构化克隆(`GMSerializable`) |
| `GM_setValue(key, value)` | 写脚本值(200ms debounce 持久化;单值 >1KB 或脚本累计 >8KB 立即落盘;退出前 flush) | `userscript:set-value` | key 非空;值同类型约束 |
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
| `GM_log(message, level?)` | 平台日志(`userData/logs/main.log`) | `userscript:log` | per-script 限频 10 条/秒,超限丢弃 |
| `GM_cookie.list/get` | **只读** cookie 访问 | `userscript:cookie-list/-get` | 受 @connect 域校验;**无 set/delete**(安全边界) |
| `GM_webRequest(details)` | **仅观察**请求事件 | `userscript:web-request-register/-unregister` | 不拦截/不修改;URL 脱敏;@match 过滤 |
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
| `@updateURL` / `@downloadURL` | ✅ | 大小写双兼容(`@updateURL`/`@updateurl`);管理页手动检查更新 |
| `@background` | ✅ | 脚本在隐藏后台窗口常驻,不参与 URL 匹配(见 §7.5) |

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
| `userscript:log` | send | `{ scriptId, level?, message }` | 限频 10/s;`get-config` 对后台 wc 走 `snapshotBackground` |
| `userscript:cookie-list` | invoke | `{ scriptId, pageUrl, url?, domain?, name? }` | 只读;返回 `{ ok, cookies? }` |
| `userscript:cookie-get` | invoke | `{ scriptId, pageUrl, url, name }` | 只读;返回 `{ ok, cookie? }` |
| `userscript:web-request-register/-unregister` | send | `{ scriptId, documentId }` | 仅观察;事件经 `userscript:web-request-event` 回传 |

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
| `userscripts:for-tab` | `{ tabId, url }` | 侧边栏:匹配脚本 + 命令列表(含后台命令,`background: true`) |
| `userscripts:invoke-command` | `{ tabId, commandId }` | 执行侧边栏命令;tab 找不到时经 `commandTarget` 路由到后台 wc,返回 `{ ok }` |
| `userscripts:check-updates` | (可选无参) | 手动检查更新(`@updateURL`),返回 `{ updates }` |
| `userscripts:apply-update` | `{ id }` | 应用更新(版本更高才装),返回 `{ ok, error? }` |
| `userscripts:background-status` | (可选无参) | 后台运行时状态 `{ scripts: [{ scriptId, running, crashedCount, stopped }], stopped }` |
| `userscripts:background-restart` | (可选无参) | 重启全部后台窗口(清零崩溃计数) |
| `userscripts:export-source` | `{ id }` | 保存对话框导出 .user.js,返回 `{ ok, path? }` |

注意:管理通道 `userscripts:list` 等**无参通道用 `z.object({}).optional()`**(裸 `z.object({})`
校验 `undefined` 会失败——历史坑)。

## 7. 数据、预算与安全

- **脚本持久化**:`ScriptStore`(electron-store,userData 下 `userscripts.json`);**值存储**:
  `ValueStore` 原子持久化到 `userData/userscript-values.json`(200ms debounce;单值 >1KB
  或脚本累计 >8KB 立即 flush;`before-quit` 同步 flush——崩溃/断电可能丢最近 debounce 窗口)。
- **快照预算**:单页脚本源码总量 ≤ `maxSourceBytesPerPage: 512KB`(超出截断不执行),
  快照 ≤ `maxSnapshotBytes: 64KB`(超出丢弃部分脚本,保证 sendSync 响应上限)。
  ⚠️ 快照上限(64KB)≠ GM_xmlhttpRequest 响应上限(2MB),两者独立。
- **GM_xmlhttpRequest**:走 `persist:` 会话(与标签页同会话),`@connect` 校验 +
  仅允许 loopback 白名单(`127.0.0.1`/`localhost`)、重定向 ≤5、响应 ≤2MB、超时 15s、
  每脚本并发 ≤4、全局 ≤16(硬上限,最坏 16 并发 × 15s)。
- **GM_download**:同样会话与 loopback 白名单,单文件 ≤8MB、每脚本并发 ≤4,保存到
  `userData/userscript-downloads/`。
- **校验入口**:每个通道 zod safeParse;`registerMenuCommand` 校验 commandId 形状
  (`documentId:scriptId:正整数` 前缀匹配),防止伪造。
- 凭据类数据**永不**经渲染进程 IPC 或 console 传输(密码模块独立约定)。

### 7.5 后台运行时(`@background`)

带 `@background` 指令的脚本在**每脚本一个隐藏 BrowserWindow** 中常驻(复用 webview-preload
运行时,`contextIsolation: true, plugins: false, partition: 'persist:'`,`backgroundThrottling:
false` 保证定时器准确),不参与任何标签页的 URL 匹配;`get-config` 对后台 wc 经
`event.sender.id` 反查 `getScriptIdForWc` 分派走 `snapshotBackground`(只含该窗口登记的脚本)。
要点:

- **每脚本独立窗口**:一个脚本崩溃/禁用只影响自己(退避 1s→2s→4s→8s→60s 重建自身);
  连续 5 次崩溃该脚本停止(`getStatus().scripts[].stopped`),其余后台脚本不受影响。
- **手动重启清零**:「重启后台运行时」重建全部窗口并清零崩溃计数(不再出现"重启后
  再崩 1 次就停止"的误判)。
- **后台 `@connect` 必填**:后台页面 URL 为 `data:text/html;charset=utf-8,`,origin 为
  `null` → 同源放行永不命中,GM_xmlhttpRequest/GM_download/GM_cookie 只认 `@connect` 列表;
  无 `@connect` 的跨域请求一律 `connect-denied`。
- **不走 Ruffle**:后台窗口始终 PPAPI 语义(mode 报告 `ppapi`);`get-ruffle-mode` 对
  未登记 wc 返回 `{ enabled: false }`(handler 启动即注册,不会触发 Landmine #2)。
- **脚本变更增量同步**:安装/卸载/启停/编辑保存走 `sync()` diff——新脚本建窗、移除的
  销毁、stopped 的保持停止(generation 每窗口独立递增,旧窗口的过期报告被拒);脚本内的
  `setInterval`/命令/值监听随窗口重建重置——**后台脚本需在顶层重新注册 value listener**。
- **命令合并**:各后台窗口命令经 `userscripts:for-tab` 合并进侧边栏(带 `background: true`,
  面板显示「后台」徽标);`invoke-command` 对 tab 找不到时经 `commandTarget` 路由到对应
  后台 wc。

### 7.6 手动检查更新(`@updateURL`)

管理页「检查更新」按钮遍历带 `@updateURL` 且未 `edited` 的脚本(并发调用共享同一
in-flight 执行,防重入);拉取走 `GmRequestService`(系统 scriptId `__platform_updater__`,
pageUrl 为 data: URL → 仅 `@connect` 校验),响应 ≤2MB(可配置)、超时 15s(可配置)、
**串行**执行。

- **host 校验**:`updateHostAllowed(connect, match, url)` — update 源 host 必须在
  `@connect` 内(含 `*.` 通配)或与某条 `@match` 同域(弱路径,UI 标「弱安全更新源」);
  data:/其他协议与无关域名拒绝。
- **双路径解析**:先试 JSON `{ version, updateURL? }`(相对 `updateURL` 按 updateUrl
  基址解析)再拉本体;非 JSON 直接当脚本本体解析 `@version`。
- **语义**:版本更高才装(`compareVersions` 数字分段,短补 0,无预发布语义);
  `edited` 脚本跳过;应用更新后清除 `edited`(新版本已替换用户改动);失败保持原样。

### 7.7 GM_cookie(只读)与 GM_webRequest(仅观察)的安全边界

- **GM_cookie 只实现 `list`/`get`**,不提供 `set`/`delete`——写入/篡改登录态的攻击面
  过大,收益低(绝大多数脚本只读)。cookie 值本身是凭据,读取能力受脚本 `@connect`
  域白名单约束;返回条数上限 100。
- **GM_webRequest 仅观察**:`onBeforeRequest`/`onCompleted`/`onErrorOccurred` 回调只收到
  **脱敏后**的 URL(query 被替换为 `<redacted>`)、method、statusCode/error;平台不拦截、
  不修改、不取消任何请求。事件按脚本 `@match` 过滤。Electron 11 webRequest 监听器
  互斥,观察器组合进 session-manager 的单一 `onBeforeRequest`,`onCompleted`/
  `onErrorOccurred` 独立注册。

### 7.8 容量配置与脚本导出

- 容量上限(响应 MB/超时秒/每脚本并发/全局并发/下载 MB/下载并发/**单值 KB**)在**设置页**
  配置,存 electron-store;响应/超时/并发/下载项保存即热应用(`applyCapacityConfig`),
  单值上限(KB)重启生效(ValueStore 构造时固定)。默认与 §7 一致。
- 脚本可经管理页**导出为 .user.js**(保存对话框);导入走既有两阶段安装(文件/URL/粘贴)。
- 管理页每行「值」按钮可查看/编辑/删除脚本的 GM 值(JSON 编辑,复用持久化文件;
  管理侧写入不广播跨 wc,界面变更由 `userscripts:changed` 刷新)。

### 7.9 后台脚本单独重启

- 管理页停止横幅列出每个 stopped 后台脚本,可**单独重启**(`userscripts:background-restart
  { id }` → `restartScript`,仅重建该脚本窗口并清零其崩溃计数),也可一次性重启全部。
- **自动更新仍为手动触发**(检查更新按钮);后台定时轮询为后续产品决策,未实现。

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
| `tests/electron/values-persistence-smoke.cjs` | 手动 electron 执行(两进程) | GM 值跨重启持久化 |
| `tests/electron/gm-capacity-smoke.cjs` | 手动 electron 执行 | 响应 2MB/下载 8MB/并发上限 |
| `tests/electron/userscripts-update-smoke.cjs` | 手动 electron 执行 | @updateURL JSON/本体双路径、edited 跳过、host 校验 |
| `tests/electron/background-script-smoke.cjs` | 手动 electron 执行 | @background 多窗口隔离/命令/启停/connect-denied |
| `tests/electron/userscripts-cookie-smoke.cjs` | 手动 electron 执行 | GM_cookie 只读 list/get、@connect 拒绝 |
| `tests/electron/userscripts-web-request-smoke.cjs` | 手动 electron 执行 | 事件分发、URL 脱敏、@match 过滤、仅观察 |
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
11. **后台 wc 的 `get-config` 必须按 `event.sender.id` 分派**——后台 preload 的 payload
    无 background 标识;漏掉分支会让后台窗口拿到 `snapshotFor` 的空结果。
12. **隐藏窗口定时器默认被节流**——后台 BrowserWindow 必须 `backgroundThrottling: false`,
    否则 `setInterval` 间歇卡顿(实测 tick 序列 2,2,2,4)。
13. **后台窗口重建后脚本状态全丢**——`setInterval`/命令回调/值监听随窗口销毁重置;
    listener 订阅不重放,后台脚本必须在顶层重新注册。

## 10. 常见扩展任务速查

### 新增一个 GM API(如 `GM_cookie`)

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
