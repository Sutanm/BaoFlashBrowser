# BaoFlashBrowser 架构手册

> 历史说明：本文包含早期实现和演进过程，部分文件名、状态管理与构建工具描述已经过时。当前开发基线请从 [`docs/README.md`](README.md) 和 [`docs/modules/00-overview.md`](modules/00-overview.md) 进入，并以源码与 `AGENTS.md` 为准。

> 面向二次开发者的完整系统解析，涵盖模块、数据流、开发阻力和经验教训。

---

## 目录

1. [项目概述](#1-项目概述)
2. [技术栈与版本锁定](#2-技术栈与版本锁定)
3. [架构总览](#3-架构总览)
4. [主进程详解](#4-主进程详解)
   - [4.1 启动入口 (index.ts)](#41-启动入口-indexts)
   - [4.2 Flash 插件系统 (flash.ts)](#42-flash-插件系统-flashts)
   - [4.3 会话管理 (session.ts + session-manager.ts)](#43-会话管理-sessionts--session-managerts)
   - [4.4 BrowserView 标签管理器 (tabs.ts)](#44-browserview-标签管理器-tabsts)
   - [4.5 CDP 密码捕获 (password-capture.ts)](#45-cdp-密码捕获-password-capturets)
   - [4.6 密码存储 (password-store.ts + dpapi.ts)](#46-密码存储-password-storets--dpapits)
   - [4.7 Ruffle 内联脚本 (ruffle-bundle.ts)](#47-ruffle-内联脚本-ruffle-bundlets)
   - [4.8 下载管理器 (download.ts)](#48-下载管理器-downloadts)
   - [4.9 窗口管理 (window.ts)](#49-窗口管理-windowts)
   - [4.10 配置系统 (config.ts)](#410-配置系统-configts)
5. [渲染进程详解](#5-渲染进程详解)
   - [5.1 应用壳 (App.tsx)](#51-应用壳-apptsx)
   - [5.2 状态管理 (Zustand Stores)](#52-状态管理-zustand-stores)
   - [5.3 核心 Hooks](#53-核心-hooks)
   - [5.4 组件层级](#54-组件层级)
   - [5.5 数据持久化 (Dexie/IndexedDB)](#55-数据持久化-dexieindexeddb)
6. [IPC 通信层](#6-ipc-通信层)
   - [6.1 主窗口 preload (contextBridge)](#61-主窗口-preload-contextbridge)
   - [6.2 页面 preload (webview-preload)](#62-页面-preload-webview-preload)
   - [6.3 IPC Handlers](#63-ipc-handlers)
7. [Ruffle WASM 集成](#7-ruffle-wasm-集成)
8. [测试与探查策略](#8-测试与探查策略)
9. [开发阻力与经验教训](#9-开发阻力与经验教训)
10. [关键文件索引](#10-关键文件索引)
11. [用户脚本运行时](#11-用户脚本运行时)
12. [视觉自动化平台](#12-视觉自动化平台)

---

## 1. 项目概述

BaoFlashBrowser 是一个跨平台 Flash 浏览器，基于 **Electron 11.5.0 (Chromium 87)** 构建。核心目标：在现代操作系统上无缝运行传统的 Flash 内容。

**两大核心引擎：**
- **PPAPI 原生 Flash**：Adobe 官方插件，兼容性最广
- **Ruffle WASM 模拟器**：开源实现，无需 Flash 插件

**设计理念：** 每个标签页使用独立的 `BrowserView` 实现渲染进程隔离——一个标签的 Flash 崩溃不影响其他标签。

---

## 2. 技术栈与版本锁定

| 组件 | 版本 | 锁定原因 |
|------|------|----------|
| **Electron** | 11.5.0 | 最后一个原生支持 PPAPI Flash 的版本。**绝不升级。** |
| Chromium | 87 | Electron 11 内置 |
| React | 18.3.x | 主窗口渲染层 |
| TypeScript | 5.5.x | 主进程、renderer 与 preload 类型检查 |
| Zustand | 5.x | renderer 状态管理 |
| Dexie | 4.x | IndexedDB 封装 |
| esbuild / Vite | 0.28.x / 7.x | 主进程与 preload / renderer 构建 |
| Ruffle | 0.5.x | WASM Flash 模拟器 |
| Blockly | 10.4.3 | 自动化积木工作台 |
| OpenCV.js | 4.5.5 | 自动化模板匹配工作线程 |
| Flash PPAPI | 29.0.0.171 Win / 32.0.0.371 Linux | Adobe 官方 EOL 前稳定版 |

**构建边界：** esbuild 生成主进程与 preload 的 CJS bundle，Vite 生成 renderer；Electron 及主进程原生运行时依赖保持 Node/Electron 侧加载。Electron 版本必须继续锁定为 11.5.0。

---

## 3. 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                    主进程 (Main Process)                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────────┐ │
│  │ flash.ts │ │session.ts│ │ tabs.ts  │ │password-capture │ │
│  │ PPAPI注册│ │ UA/CORS  │ │BrowserView│ │  CDP 密码捕获   │ │
│  │ mms.cfg  │ │ SWF拦截  │ │ 标签管理  │ │  8种策略        │ │
│  └──────────┘ └──────────┘ └──────────┘ └─────────────────┘ │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────────┐ │
│  │config.ts │ │pwd-store │ │ download │ │ruffle-bundle.ts │ │
│  │配置持久化│ │加密存储  │ │ aria2管理│ │ WASM/JS内联     │ │
│  └──────────┘ └──────────┘ └──────────┘ └─────────────────┘ │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                  IPC Handlers                         │   │
│  │ shortcut | window | tabs | download | password |config│   │
│  └──────────────────────────────────────────────────────┘   │
└──────────────────────────────────┬──────────────────────────┘
                                   │ IPC (contextBridge)
┌──────────────────────────────────┴──────────────────────────────┐
│                    渲染进程 (Renderer Process)                     │
│  ┌────────┐  ┌─────────────┐  ┌─────────────────────────────┐   │
│  │App.tsx │  │ Hooks        │  │ Panels                      │   │
│  │应用壳  │  │ TabManager   │  │ Favorites│History│Downloads  │   │
│  │        │  │ Password     │  │ Settings│Passwords│Search    │   │
│  │        │  │ Download     │  │                             │   │
│  └────────┘  └─────────────┘  └─────────────────────────────┘   │
│  ┌────────┐  ┌─────────────┐  ┌─────────────────────────────┐   │
│  │ Stores │  │ Services     │  │ Components                   │   │
│  │Zustand │  │ db.ts(Dexie)│  │ TopBar│Drawer│FindBar│Tabs   │   │
│  │ 状态   │  │ idxdb       │  │ RuffleToggle│WindowControls  │   │
│  └────────┘  └─────────────┘  └─────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                 BrowserView (每标签独立进程)                        │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  PPAPI 标签: contextIsolation=true, plugins=true           │  │
│  │  Ruffle 标签: contextIsolation=false, plugins=false        │  │
│  │  preload: webview-preload.js (Ruffle 注入 + 登录捕获)      │  │
│  │  session: partition:'persist:' (独立 session)              │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 数据流核心路径

```
用户输入 URL → renderer handleNavigate
  → IPC tab:navigate → tabs.ts navigate()
  → BrowserView.loadURL()

页面加载 → tabs.ts did-stop-loading
  → setupSessionOnce (首次) + setupCapture
  → CDP attach + CAPTURE_SCRIPT 注入

密码捕获 → CDP consoleAPICalled
  → console.log({_type:'baop_capture',...})
  → password-capture 解析 + globalPendingCredentials
  → IPC password:captured → renderer toast
  → 用户点保存 → IPC password:save-confirm
  → DPAPI 加密 → IndexedDB 存储
```

---

## 4. 主进程详解

### 4.1 启动入口 (index.ts)

`src/main/index.ts` — 应用启动的中央编排器。

**启动顺序（严格）：**

1. `app.requestSingleInstanceLock()` — 单实例锁
2. **命令行开关**（`app.whenReady` 之前！）
   - Linux: `no-sandbox`, `enable-gpu-rasterization`, `enable-zero-copy`
   - 通用: `ignore-gpu-blacklist`, `disable-gpu-process-crash-limit`, `disable-renderer-backgrounding`, `disable-flash-sandbox`
   - 低端模式: `enable-low-end-device-mode`
3. `setupFlash()` — 注册 PPAPI 插件路径 + 写入 `mms.cfg`
4. `protocol.registerSchemesAsPrivileged('ruffle-resource')` — 自定义协议注册
5. **`app.whenReady().then()`** — 以下按顺序执行：
   - `loadRuffleJs()` — 预加载 Ruffle WASM 内容
   - `protocol.registerBufferProtocol('ruffle-resource')` — 自定义资源协议
   - `createWindow()` — 创建主 BrowserWindow
   - `tabManager.setPreload()` — 设置 BrowserView preload 路径
   - `initSession()` — 初始化 defaultSession (UA, CORS, SWFObject)
   - `initDownloadManager()` — 启动 aria2 子进程
   - `registerZoomShortcuts()` + `startMouseHook()` — 快捷键 + 原生鼠标钩子
   - 注册全部 IPC handlers
   - `initPasswordStore()` — 异步初始化加密密码本
   - `dpapiSelfTest()` — 验证 DPAPI 可用性

**崩溃保护：** `render-process-gone` 监听器计数崩溃（30 秒窗口内 >3 次则退出），否则 500ms 后 reload 主窗口。

**`web-contents-created` 监听器：** 对所有 webContents 注入 `before-input-event` handler（快捷键转发）和 `new-window` 拦截（URL 转发到 renderer）。

---

### 4.2 Flash 插件系统 (flash.ts)

`src/main/modules/flash.ts`

**职责：** 注册 PPAPI Flash 插件到 Chromium + 写入 `mms.cfg` 抑制调试弹窗。

**插件路径解析（`getFlashPluginPath`）：**
- **Windows x64** → `plugins/win64/pepflashplayer64.dll`
- **Windows ia32** → `plugins/win32/pepflashplayer.dll`
- **Linux x64** → `plugins/linux64/libpepflashplayer64.so`
- 开发模式下路径相对于 `__dirname/..`（未打包），打包模式相对于 `process.resourcesPath`

**版本提取（`extractVersion`）：**
从 DLL 文件名中通过正则 `/^\d+\.\d+\.\d+\.\d+$/` 提取版本号。**DLL 文件名必须包含版本号**（如 `pepflashplayer64_29_0_0_171.dll`），否则返回 `0.0.0.0`，触发网站 Flash 版本检测拦截。

**命令行开关：**
```ts
app.commandLine.appendSwitch('ppapi-flash-path', pluginPath);
app.commandLine.appendSwitch('ppapi-flash-version', ver);
```
`--ppapi-flash-version` 是 `navigator.plugins["Shockwave Flash"].description` 的唯一数据来源。始终传大于 32 的版本号（如 `34.0.0.330`）来绕过淘米等游戏门户的反 Flash 检测。

**mms.cfg 写入：** 抑制 AS3 运行时错误弹窗（Flash 29 无调试弹窗、Flash 32 抑制 `SuppressDebuggerExceptionDialogs`）。写入到多个可能路径（cwd、userData/PepperFlash/System、Roaming/Macromedia/Flash Player、插件目录等），覆盖所有 Flash 可能读取的路径。

---

### 4.3 会话管理 (session.ts + session-manager.ts)

#### session.ts — defaultSession 初始化

初始化 `session.defaultSession`（主窗口 + 首个 BrowserView）：

1. **UA 设置** → Chrome 87 标准 UA 字符串
2. **crossdomain.xml 拦截** → 直接 serve 全放行 XML（Flash 跨域请求用）
3. **淘米 SWFObject 拦截** → 网络层将 `webres.61.com/common/js/swfobject.js` 重定向到修补版（`patchedSWFObject()`）

#### patchedSWFObject() — 淘米反检测核心

淘米站点（`*.61.com`）的 `checkUpgrade` 函数检测 Flash 版本：
- `major === 32` → 强制升级
- `navigator.plugins["Shockwave Flash"].filename` 不含 `.dll` → 拦截非 PPAPI 插件

**修补方案：** `checkUpgrade: function(a){return false;}` — 始终返回不拦截。在网络层用 `webRequest.onBeforeRequest` 拦截 + `data:text/javascript` 注入修补后的整个 SWFObject 库。

#### session-manager.ts — persist: session 初始化

对使用 `partition:'persist:'` 的 BrowserView 调用 `setupSessionOnce(sess)`：
- 确保单次初始化（`sessionSetup` flag）
- 同样设置 UA + SWFObject 拦截 + 下载 handler

**⚠️ 陷阱：** `defaultSession` 和 `persist:` session 是**两个独立 session**。webRequest 拦截器必须分别在两者上注册！

---

### 4.4 BrowserView 标签管理器 (tabs.ts)

`src/main/modules/tabs.ts` — 最复杂的模块。

**核心数据结构：**
```ts
TabEntry { id, browserView, isRuffle, ruffleSource, lastTargetUrl }
wcToId: Map<webContents.id → tabId>
```

**`create(tabId, url, ruffleConfig)` — 创建标签：**
1. 创建 `BrowserView`（`partition:'persist:'`）
2. **根据引擎设置 webPreferences：**
   - PPAPI: `contextIsolation:true, plugins:true`
   - Ruffle: `contextIsolation:false, plugins:false`
3. 初始 bounds 设为 `(-9999, -9999, 1, 1)`（隐藏，等待激活）
4. 调用 `setupSessionOnce(wc.session)` — 首次才执行
5. 注册 **11 个 webContents 事件监听器**（见下文）
6. 加载 URL

**事件监听器清单：**

| 事件 | 处理 |
|------|------|
| `page-title-updated` | IPC `tab:updated` |
| `page-favicon-updated` | IPC `tab:updated` |
| `did-start-loading` | IPC `tab:updated` isLoading |
| **`did-stop-loading`** | IPC + 500ms 延迟 executeJS 抓 title/favicon + **`setupCapture(wc)`** |
| `did-navigate` / `did-navigate-in-page` | IPC url + updateNav |
| `media-started-playing` / `media-paused` | IPC isAudible |
| `found-in-page` | IPC 搜索结果 |
| `did-fail-load` | IPC load-error（跳过 -3）|
| `render-process-gone` | 清理 wcToId + IPC crashed |
| `new-window` | 阻止默认 + IPC newwindow |
| `context-menu` | 自定义右键菜单 |

**`setRuffleMode(tabId, enabled, source)` — 引擎切换：**
引擎切换不能仅 reload——`plugins` 和 `contextIsolation` 在 BrowserView 创建时就固定。策略：**销毁旧 BrowserView → 创建新 BrowserView → 重新注册全部事件 → reload 当前 URL**。

**`_destroyView(tab)` — 安全销毁：**
```ts
teardownCapture()  →  wcToId.delete()  →  win.removeBrowserView()
  →  wc.destroy()  →  tab.destroy()
```

---

### 4.5 CDP 密码捕获 (password-capture.ts)

`src/main/modules/password-capture.ts` — 核心密码捕获引擎，使用 Chrome DevTools Protocol (CDP) 跨域注入。

#### 架构决策：为什么用 CDP 而不是 executeJavaScript

| 方案 | 跨域 iframe | 对页面干扰 | BrowserView 兼容 |
|------|------------|------------|-----------------|
| `executeJavaScript` | ❌ 无法触及 | 无干扰 | ✅ |
| **CDP `Runtime.evaluate`** | ✅ `contextId` 按需注入 | `debugger.attach` 可能阻塞 `<script>` onload | ✅ |

**关键教训：** 4399 登录在 `ptlogin.4399.com` 的跨域 iframe 中，必须用 CDP；7k7k JSONP 登录用 `<script>` 标签插入，CDP attached 会阻塞其 `onload` 回调。

#### CAPTURE_SCRIPT — 8 种捕获策略

注入到页面上下文的 JavaScript 代码（通过 CDP `Runtime.evaluate`），包含：

| 策略 | 触发方式 | 覆盖场景 |
|------|---------|---------|
| **A: input 监听** | `document.addEventListener('input')` 捕获阶段 | 实时跟踪密码+用户名输入 |
| **A: submit 监听** | `document.addEventListener('submit')` 捕获阶段 | 传统 `<form>` 提交 (4399) |
| **A: beforeunload** | `window.addEventListener('beforeunload')` | 页面导航前的最后兜底 |
| **B: 200ms 轮询** | `setInterval` 检测密码框清空/加密替换 | AJAX 登录后不跳转 |
| **D: fetch/XHR 拦截** | 原型链 hook `window.fetch` + `XMLHttpRequest.prototype.send` | SPA/AJAX 登录 |
| **E: form.submit() 拦截** | `HTMLFormElement.prototype.submit` hook | 程序化提交（不触发 submit 事件）|
| **F: sendBeacon 拦截** | `navigator.sendBeacon` hook | Beacon API 上报 |
| **G: 点击触发** | `document.addEventListener('click')` | 检测登录按钮点击 |
| **H: JSONP URL 拦截** | `HTMLScriptElement.src` setter hook + `MutationObserver` + `HTMLImageElement.src` hook | **7k7k `<script src="?password=">`** 注入 |

**策略 H 三层防护（7k7k 专用）：**
1. `HTMLScriptElement.prototype.src` setter 重定义 — 拦截 `script.src = url`
2. `MutationObserver(childList+subtree)` — fallback，观察 DOM `<script>` 插入
3. `HTMLImageElement.prototype.src` setter 重定义 — 拦截 `<img>` ping

**`tryReportFromUrl(urlStr, src)`** 解析 URL query string 提取 `password=`/`username=` 参数。

#### setupCapture 流程

```
setupCapture(wc)
  → 如果已存在 state → teardownCapture (detach + 清理)
  → wc.debugger.attach('1.3')
  → Runtime.enable
  → Runtime.evaluate(CAPTURE_SCRIPT) — 主框架
  → debugger.on('message') → 监听 executionContextCreated / consoleAPICalled
  → 3s 定时器 → injectAllFrames — 跨域 iframe 注入
  → 再次 4s → 二次批量注入
```

#### 捕获后的处理

```
consoleAPICalled → 解析 JSON
  → baop_diag: 日志输出
  → baop_capture:
      → 去重 (capturedSet)
      → 存入 globalPendingCredentials
      → IPC password:captured (captureId, host, username)
      → 对 script-src/script-mo/img-src 等源 detach 释放 debugger
        （避免阻塞 JSONP <script> onload 回调）
      → submit/beforeunload 类保持 attached
```

**`globalPendingCredentials`** 是模块级的全局 Map，不受 `teardownCapture` / `setupCapture` 重建 state 影响。这是后来修的 bug——之前 pendingCredentials 存在 state 里，JSONP 捕获后 detach→teardown→重建 state 时丢失。

---

### 4.6 密码存储 (password-store.ts + dpapi.ts)

`src/main/modules/password-store.ts` — 加密密码管理器

**加密方案：** DEK（数据加密密钥）+ DPAPI（系统级密钥保护）
- DEK 用 AES-256-GCM 加密密码条目
- DEK 本身用 DPAPI 保护（Windows）或 AES-KW 密钥包裹（跨平台）
- 用户主密码用 PBKDF2 派生，加盐 32 字节

**IndexedDB 表：** `passwords` (electron-store)
- 存储加密后的密码条目：`{id, host, origin, title, username, encryptedPassword, iv, tag, updatedAt}`
- `_dek` 元条目：DPAPI 加密后的 DEK
- `_config` 元条目：`{enabled, defaultId}`

**核心 API：**
| 函数 | 用途 |
|------|------|
| `init()` | 从 DB 加载 DEK 并解密，初始化状态 |
| `setupMaster(password)` | 创建 DEK + PBKDF2 派生，DPAPI 加密存储 |
| `unlockWithMaster(password)` | 用主密码解密 DEK |
| `addEntry({host, username, password})` | DEK 加密密码 → 存储 |
| `getDecryptedPassword(id)` | 解密单条密码 |
| `setDefault(id)` | 设置默认填充条目 |
| `resetAll()` | 清空所有密码数据 |

**状态机：** `uninitialized → locked → unlocked`
- `isInitialized()`: DEK 存在
- `isUnlocked()`: DEK 已解密可用
- `isEnabled()`: 用户已启用密码本

`src/main/modules/dpapi.ts` — Windows DPAPI 封装
- 通过 `powershell` 或 `win-dpapi` npm 包调用
- `selfTest()` 验证 DPAPI 可用性（加密→解密往返）

---

### 4.7 Ruffle 内联脚本 (ruffle-bundle.ts)

`src/main/modules/ruffle-bundle.ts`

**职责：** 在应用启动时同步读取 Ruffle JS 文件内容到内存，供 webview-preload 通过 `ipcRenderer.sendSync('get-ruffle-mode')` 同步获取 + `eval()` 注入页面上下文。

```ts
let _ruffleJs: string | null = null;
export function loadRuffleJs(): void { /* fs.readFileSync → _ruffleJs */ }
export function ruffleJsContent(): string { return _ruffleJs || ''; }
```

这是同步方案的关键——在 `document-start` 时 preload 需要立即拿到 Ruffle JS，不能用异步 IPC。

---

### 4.8 下载管理器 (download.ts)

`src/main/modules/download.ts`

**双引擎下载：** Chromium 原生 + aria2 多线程

**aria2 管理：**
- 查找内置 aria2c.exe（`native/aria2/` 或 PATH）
- 启动子进程：RPC 端口 16800，secret token，多连接(16) + 分片(16) + 续传
- RPC 通信通过 HTTP POST `/jsonrpc`
- `addUri` 添加任务 → `tellStatus` 轮询进度 → `remove` 取消

**下载 handlers（`setupDownloadHandlers`）：**
- `will-download` → 构建统一 `DownloadItem` → IPC `download:progress`
- `updated` → 实时进度上报
- `done` → 完成/取消/中断通知

---

### 4.9 窗口管理 (window.ts)

创建主 `BrowserWindow`：`1200×850`，`frame:false`（无边框），`contextIsolation:true`，`nodeIntegration:false`。单例模式 `getMainWindow()`。

**可恢复性设计：** reload 而非重启——主窗口渲染崩溃时 `render-process-gone` 监听器在 500ms 后调 `win.reload()` 恢复。

---

### 4.10 配置系统 (config.ts)

基于 `electron-store`（JSON 文件持久化）。默认值：
```ts
flashVersion: '34.0.0.330',  // 伪装给网站的版本号
lowEndMode: false,
homepage: 'about:newtab',
searchEngine: 'bing',
downloadEngine: 'aria2',
ruffleSource: 'bundled',     // CDN 可选
```

---

## 5. 渲染进程详解

### 5.1 应用壳 (App.tsx)

`src/renderer/App.tsx` — React 根组件。

**启动流程：**
1. **Hydration**：`loadAll()` 从 IndexedDB 拉取数据并写入 Zustand store。
2. **持久化副作用**：组件和 store action 通过服务层把收藏、历史、下载与设置回写 DB。
3. **BrowserView 区域**：`#browserview-area` div 通过 `ResizeObserver` 跟踪尺寸 → IPC `tab:setBounds` 同步位置
4. **抽屉动画**：侧边栏展开/折叠时 `calcBounds(animated=true)` 用 `requestAnimationFrame` + ease-out-cubic 做 250ms 平滑动画

**Hydration Guard（关键设计）：**
```ts
const hydrationDone = useRef(false);
useEffect(() => {
  if (!hydrationDone.current) return; // 水合未完成不写 DB
  db.favorites.bulkPut(favorites);
}, [favorites]);
```
防止启动时短暂的默认值覆盖 DB 数据。

### 5.2 状态管理 (Zustand Stores)

- `src/renderer/store/useDataStore.ts` — 设置、历史、收藏与下载状态。
- `src/renderer/store/useTabsStore.ts` — 标签页列表、活动标签和导航状态。
- 地址栏 Toast 使用独立队列服务，避免页面状态更新覆盖高优先级运行提示。

### 5.3 核心 Hooks

| Hook | 职责 |
|------|------|
| `useTabManager` | 标签生命周期：创建/关闭/切换/导航/缩放 + IPC 事件监听 |
| `useShortcut` | 全局快捷键分发（通过 `keyboard.service`）|
| `useTheme` | 深色/浅色主题切换 + IndexedDB 持久化 |
| `useDownloadListener` | 下载进度 + toast 通知 |
| `usePasswordListener` | 密码捕获 toast + 密码本启用检测 |

**`useTabManager` 详细行为：**
- `createTab` → `tabsAtom` 追加 + IPC `tab:create` + `switchTab`
- `updateTab` → debounced 1.5s 历史记录写入（重定向场景去重）
- `closeTab` → 清理未提交历史 + IPC `tab:close` + 智能切换活跃标签
- `handleNavigate` → URL 标准化 + `tab:stop` + `tab:navigate`

### 5.4 组件层级

```
App
├── TopBar
│   ├── WindowControls
│   ├── TabItem (×N, 支持拖拽排序)
│   ├── 地址栏 (带 toast overlay flip 动画)
│   ├── RuffleToggle (Flash⇄Ruffle 切换)
│   └── 缩放胶囊 + 星标收藏
├── [内容区]
│   ├── DrawerSidebar (图标条 + 抽屉面板)
│   │   ├── FavoritesPanel
│   │   ├── HistoryPanel
│   │   ├── DownloadsPanel
│   │   ├── SettingsPanel
│   │   └── PasswordsPanel
│   ├── NewTabPage (about:newtab 时显示)
│   └── #browserview-area (BrowserView 区域)
├── FindBar (Ctrl+F)
└── LoadingProgress (顶部加载条)
```

### 5.5 数据持久化 (Dexie/IndexedDB)

`src/renderer/services/db.ts`

**数据库：** `BaoFlashDB` (IndexedDB via Dexie)，版本 1

| 表 | 主键/索引 | 内容 |
|------|---------|------|
| `favorites` | `url` | 收藏链接 |
| `history` | `id, lastVisit` | 浏览历史 |
| `downloads` | `id` | 下载记录 |
| `settings` | `searchEngine` | 应用设置 |
| `meta` | `key` | 元数据（theme, migrated_v1 flag）|

**迁移策略：** `migrateFromLocalStorage()` — 首次启动自动将 localStorage（v1 数据）批量迁移到 IndexedDB，然后设置 `migrated_v1` flag。

**清空数据的特殊性：** `bulkPut([])` 不会清空已有数据，必须用 `table.clear()`。清空操作立即执行（不 debounce），防止用户关 app 前数据未同步。

---

## 6. IPC 通信层

### 6.1 主窗口 preload (contextBridge)

`src/preload/index.ts` — 通过 `contextBridge.exposeInMainWorld('electronAPI', ...)` 暴露安全 API。

**白名单机制：**
- `ALLOWED_ON_CHANNELS` (on) — 14 个允许的 push 通道
- `ALLOWED_INVOKE_CHANNELS` (invoke) — 30 个允许的 invoke 通道

**暴露的 API 命名空间：**
- `electronAPI.tab.*` — 标签操作
- `electronAPI.config.*` — 配置读写
- `electronAPI.dl.*` — 下载控制
- `electronAPI.pwd.*` — 密码本操作
- `electronAPI.win.*` — 窗口控制
- `electronAPI.on(channel, callback)` — 通用事件订阅
- `electronAPI.invoke(channel, ...args)` — 通用 invoke

### 6.2 页面 preload (webview-preload)

`src/webview-preload/index.ts` — 注入到每个标签页（BrowserView）的 preload 脚本。

**双重职责：**

**A. Ruffle 注入（contextIsolation: false 时）：**
```
ipcRenderer.sendSync('get-ruffle-mode')
  → 同步获取 {enabled, source, js: ruffleJsContent}
  → eval(ruffle_js) 在页面上下文执行
  → Ruffle 自注册到 navigator.plugins
```

CDN 模式：用 `requestAnimationFrame` 轮询等待 `documentElement` 出现后 `createElement('script')` 动态加载 CDN 版 Ruffle。

**B. PPAPI 模式：** 注入 fake Flash plugin 到 `navigator.plugins`（Linux 需要）、登录表单侦测 + 自动填充 + `Ctrl+滚轮` 缩放（`contextIsolation: true` 时 `require('electron')` 失败，只是优雅降级）。

### 6.3 IPC Handlers

| 文件 | 职责 |
|------|------|
| `shortcut.ipc.ts` | 全局快捷键注册 + 原生鼠标钩子（Windows `WH_MOUSE_LL` / Linux `XRecord`）|
| `window.ipc.ts` | 窗口最小化/最大化/关闭/全屏 |
| `tabs.ipc.ts` | 标签 CRUD + `get-ruffle-mode` 同步 handler |
| `download.ipc.ts` | 下载控制 + 路径穿越校验 + 危险扩展名黑名单 |
| `config.ipc.ts` | 配置读写 |
| `password.ipc.ts` | 密码本 CRUD + 捕获确认/忽略 + `password:changed` 通知 |

**`get-ruffle-mode` 特殊处理：** 使用 `ipcMain.on` 而非 `ipcMain.handle`——需要 `e.returnValue` 同步返回，因为 preload 在 `document-start` 时运行，需要同步获取 Ruffle JS。

---

## 7. Ruffle WASM 集成

### 为什么 Ruffle 标签必须 `contextIsolation: false`

Ruffle 需要在页面上下文执行：
1. 修改 `navigator.plugins`（伪装 Flash 插件 → `filename: "ruffle.js"`）
2. `RufflePlayer.config.favorFlash = false` → 激活 polyfill
3. 拦截 `<embed>`/`<object>` Flash 元素

`contextIsolation: true` 下 preload 和页面是隔离世界，preload 的 `navigator.plugins` 修改对页面不可见。

### 注入时机问题

- **Bundled 模式：** `sendSync('get-ruffle-mode')` → 同步 `eval()` — 页面上下文立即执行
- **CDN 模式：** `documentElement` 在 document-start 时为 `null`，用 `requestAnimationFrame` 轮询等待后 `appendChild(scriptElement)`
- **CDN 版本匹配：** 不能设 `publicPath`——让 Ruffle 从 CDN 自动加载配套 WASM 版本

### 中文字体

- `fontSources: ['ruffle-resource://SourceHanSansCN-Regular.otf']` — OFL-1.1 思源黑体
- `defaultFonts` 将 Flash 默认字体族（`_sans`/`_serif`/`_typewriter`）映射到 Source Han Sans CN
- SWF 内嵌字体不受 `fontSources` 影响（Ruffle 底层限制）

### `ruffle-resource://` 自定义协议

```ts
protocol.registerSchemesAsPrivileged([{
  scheme: 'ruffle-resource',
  privileges: { secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);
protocol.registerBufferProtocol('ruffle-resource', (req, cb) => {
  // 从 dist/lib/ruffle/ 读取 → Buffer 响应
});
```

---

## 8. 测试与探查策略

项目采用 **demo 先行** 的调试方法论——在与主项目环境一致的独立 Electron 应用中验证功能，再移植到主项目。

### 测试 Demo 清单

| Demo | 环境 | 用途 |
|------|------|------|
| `test/cdp-capture-test/` | **BrowserWindow** + CDP | 验证 CDP 密码捕获基本能力 (confirmed: 4399 ✅ 7k7k ✅) |
| `test/ws-capture-test/` | **BrowserWindow** + eval/WebSocket | 对比 eval 模式 vs CDP 的差异 (4399 ❌ 7k7k ✅) |
| **`test/bv-capture-test/`** | **BrowserView** + CDP/eval 双模式 | 验证 BrowserView 环境下的捕获 (CDP 完美，eval 仅 7k7k) |
| `test/download-test/` | BrowserWindow + aria2 子进程 | 验证 aria2 RPC 通信 + 下载进度轮询 |

### 网站探查

**`test/7k7k-probe.py`** — Playwright 脚本，自动抓 7k7k 登录时的所有网络请求 + POST body。
用法：
```bash
python test/7k7k-probe.py
# → 打开 Chromium → 手动登录 → 按 Enter → 保存到 7k7k-reqs.json
```

**核心发现（驱动后续开发）：** 7k7k 登录是 GET 请求 JSONP（`<script src="Post_pay.php?username=&password=">`），不是 POST——所有 fetch/XHR 钩子空转。

### 调试四步法

1. **想方案** — 先在脑中走通完整链路
2. **写 demo** — 环境必须与主项目一致（BrowserView 不是 BrowserWindow）
3. **demo 通过后移植**
4. **网站不生效** → Playwright 抓包 + 分析实际网络行为

---

## 9. 开发阻力与经验教训

### 9.1 Flash PPAPI 版本兼容性

**Windows：** 29.0.0.171（Adobe 官方，无时间炸弹）。34.0.0.330（重橙网络魔改版）内置调试器弹出 AS3 错误对话框，不可用。

**DLL 文件名陷阱：** DLL 文件名必须含版本号（如 `pepflashplayer64_29_0_0_171.dll`），否则 `extractVersion` 返回 `0.0.0.0` → 网站检测到错误版本 → 拦截 Flash 加载。

### 9.2 淘米 61.com 反 Flash 检测

淘米使用魔改 SWFObject，`checkUpgrade` 函数：
- `major === 32` → 强制升级
- `filename` 不含 `.dll` → 拦截（检测非 PPAPI）

**方案：** 网络层 webRequest 拦截 + `data:text/javascript` 替换整个 SWFObject。在网络层、页面拿到脚本之前完成替换。

### 9.3 密码捕获的演进

**第一版：** 仅 `input` + `submit` + `beforeunload` — 4399 可用，7k7k 失败。

**根因分析：**
- 4399 登录在 `ptlogin.4399.com` 的**跨域 iframe** → `executeJavaScript` 无法触及 → 必须 CDP
- 7k7k 用 **JSONP `<script>` 注入** 提交 → 绕过了所有 submit/fetch/XHR 钩子

**最终方案：** 8 种捕获策略（A-H），覆盖所有提交方式。Strategy H（JSONP URL 解析）专门解决 7k7k。

### 9.4 CDP `debugger.attach` 的副作用

**现象：** 7k7k 登录后页面卡在"正在登录"，无法跳转。

**根因：** CDP `debugger.attach` 在 BrowserView 中会阻塞 `<script>` 标签的 `onload` 回调。7k7k JSONP 通过 `<script src="">` 加载回调函数，`onload` 被阻塞 → 回调不执行 → 页面不跳转。

**修复：** 对 `script-src`/`script-mo` 等源捕获后立即 `detachQuietly`，`did-stop-loading` 自动触发 `setupCapture` 重连。`submit`/`beforeunload` 类保持 attached。

### 9.5 `pendingCredentials` 丢失 Bug

**现象：** JSONP 捕获后 `detach → teardown → setupCapture`，state 重建时 `pendingCredentials` 随旧 state 销毁，用户点"保存"时找不到凭据。

**修复：** `globalPendingCredentials` 提升为模块级全局 Map，不受 state 生命周期影响。

### 9.6 Linux/WSLg 配置

- 必须 `--no-sandbox`
- WSLg 下 GPU 三旗缺一不可：`--ignore-gpu-blacklist` + `--enable-gpu-rasterization` + `--enable-zero-copy`
- 缺少任一旗标 → `viz_main_impl.cc` GPU 进程退出 → 窗口变白/透明

### 9.7 BrowserView vs BrowserWindow

**为什么 demo 用 BrowserWindow 不能证明主项目可行：**

BrowserView 的渲染模型与 BrowserWindow 不同——CDP `debugger.attach` 对 `<script>` onload 的阻塞行为在 BrowserView 中表现更严重。所有 demo 必须与主项目环境一致。

### 9.8 跨域 iframe 的 CDP 局限

跨域 iframe 创建独立的 `Runtime.executionContext`，必须通过 `contextId` 注入脚本。`wc.debugger.sendCommand('Runtime.evaluate', {contextId})` 按帧注入，新 context 需要在 `executionContextCreated` 事件中立即注入 + 定时器兜底。

### 9.9 `did-fail-load` + `wc.stop()` 组合陷阱

在 `did-fail-load` handler 中调用 `wc.stop()` 会**杀死页面跳转后的正常导航**。7k7k 登录成功后有重定向，`did-fail-load` 恰好在这时触发 → `wc.stop()` 终止了重定向 → 页面卡死。

**修复：** 彻底删除 `wc.stop()` 调用。`did-fail-load` 只负责 IPC 通知错误码。

### 9.10 download 模块的双 session 监听

`will-download` 监听在 `session.defaultSession` 上，但 BrowserView 使用 `partition:'persist:'`（独立 session）。需要**双 session 监听**——在 `setupSessionOnce()` 中分别注册。

### 9.11 IndexedDB 持久化竞争条件

**启动 hydration 是异步的**。在 hydration 完成前用户操作可能修改 atom → persist effect 覆盖用户修改。

**修复：** `hydrationDone` ref guard，hydration 完成前 persist effect 不写入 DB。

### 9.12 System32/SysWOW64 写入权限

Windows 上 Flash 也会读取 `C:\Windows\System32\Macromed\Flash\mms.cfg`，但需要管理员权限。跳过 System32 路径，仅在 userData、Roaming 等用户级路径写入 `mms.cfg`。

---

## 10. 关键文件索引

### 主进程

| 文件 | 行数(约) | 职责 |
|------|---------|------|
| `src/main/index.ts` | 160 | 启动编排、崩溃保护、单实例锁 |
| `src/main/modules/flash.ts` | 60 | PPAPI 插件加载 + mms.cfg 写入 |
| `src/main/modules/session.ts` | 160 | defaultSession: UA/CORS/SWFObject |
| `src/main/modules/session-manager.ts` | 30 | persist: session 初始化 + 去重 |
| `src/main/modules/tabs.ts` | 410 | BrowserView TabManager（核心）|
| `src/main/modules/password-capture.ts` | 370 | CDP 密码捕获（8 种策略）|
| `src/main/modules/password-store.ts` | 250 | DPAPI 加密密码本 |
| `src/main/modules/dpapi.ts` | 80 | Windows DPAPI 封装 |
| `src/main/modules/ruffle-bundle.ts` | 70 | Ruffle WASM 预加载 |
| `src/main/modules/download.ts` | 350 | aria2 子进程 + 下载 handler |
| `src/main/modules/window.ts` | 40 | BrowserWindow 创建 + 可恢复性 |
| `src/main/modules/config.ts` | 40 | electron-store 配置 |
| `src/main/utils/ipc-wrapper.ts` | 20 | IPC handler 工厂函数 |

### IPC Handlers

| 文件 | 职责 |
|------|------|
| `src/main/ipc/shortcut.ipc.ts` | 快捷键 + 鼠标钩子 |
| `src/main/ipc/window.ipc.ts` | 窗口控制 |
| `src/main/ipc/tabs.ipc.ts` | 标签 + get-ruffle-mode 同步 |
| `src/main/ipc/download.ipc.ts` | 下载 + 安全检查 |
| `src/main/ipc/config.ipc.ts` | 配置读写 |
| `src/main/ipc/password.ipc.ts` | 密码本 + 捕获确认通知 |

### Preload

| 文件 | 职责 |
|------|------|
| `src/preload/index.ts` | 主窗口 contextBridge（白名单 IPC）|
| `src/webview-preload/index.ts` | 页面 preload（Ruffle eval + 登录捕获）|

### 渲染进程

| 文件 | 职责 |
|------|------|
| `src/renderer/App.tsx` | React 根，hydration + 持久化 |
| `src/renderer/atoms/data.atom.ts` | 全局状态原子 |
| `src/renderer/atoms/tabs.atom.ts` | 标签状态原子 |
| `src/renderer/services/db.ts` | Dexie/IndexedDB 封装 |
| `src/renderer/services/keyboard.service.ts` | 键盘快捷键分发 |
| `src/renderer/services/id.service.ts` | Nano ID + URL 标准化 |
| `src/renderer/hooks/useTabManager.ts` | 标签生命周期 (302 行) |
| `src/renderer/hooks/usePasswordListener.ts` | 密码捕获 toast |
| `src/renderer/hooks/useDownloadListener.ts` | 下载进度 toast |
| `src/renderer/hooks/useShortcut.ts` | 快捷键 hook |
| `src/renderer/hooks/useTheme.ts` | 深色/浅色主题 |
| `src/renderer/components/layout/TopBar.tsx` | 顶部栏 (地址/tabs/缩放/控制) |
| `src/renderer/components/layout/DrawerSidebar.tsx` | 抽屉侧边栏 |
| `src/renderer/components/panels/*.tsx` | 收藏/历史/下载/设置/密码面板 |
| `src/renderer/components/overlays/FindBar.tsx` | 页内查找栏 |
| `src/renderer/components/navigation/RuffleToggle.tsx` | Flash⇄Ruffle 开关 |
| `src/renderer/components/tabs/TabItem.tsx` | 标签页 UI 组件 |
| `src/renderer/components/shell/WindowControls.tsx` | 窗口控制按钮 |
| `src/renderer/components/newtab/NewTabPage.tsx` | 新标签页 |
| `src/renderer/components/ErrorBoundary.tsx` | React 错误边界 |

### 共享类型

| 文件 | 内容 |
|------|------|
| `src/shared/types/tab.ts` | Tab 接口 |
| `src/shared/types/bookmarks.ts` | BookmarkEntry 接口 |
| `src/shared/types/history.ts` | HistoryEntry 接口 |
| `src/shared/types/downloads.ts` | DownloadItem/DownloadState |
| `src/shared/types/settings.ts` | Settings/LinkBehavior/FlashEngineMode |
| `src/shared/types/passwords.ts` | PasswordEntry/PasswordStoreStatus |
| `src/shared/types/ipc.ts` | ShortcutAction/IPCMainToRenderer |

### 配置

| 文件 | 用途 |
|------|------|
| `package.json` | 依赖 + 脚本 |
| `tsconfig.json` | 基础 TS 配置 (paths aliases) |
| `tsconfig.main.json` | 主进程 TS 配置 |
| `tsconfig.renderer.json` | 渲染进程 TS 配置 |
| `esbuild.main.config.mjs` | 主进程 + preload CJS bundle |
| `vite.renderer.config.ts` | renderer 构建与静态资源处理 |
| `.eslintrc.js` | ESLint 配置 |
| `AGENTS.md` | Agent 操作指南（landmines + 调试流程）|

### 资源

| 路径 | 内容 |
|------|------|
| `plugins/win64/pepflashplayer64.dll` | Flash PPAPI 29.0.0.171 (Windows) |
| `plugins/win32/pepflashplayer.dll` | Flash PPAPI 32.0.0.xxx (Windows x86) |
| `plugins/linux64/libpepflashplayer64.so` | Flash PPAPI 32.0.0.371 (Linux) |
| `assets/SourceHanSansCN-Regular.otf` | 思源黑体（Ruffle 中文字体，OFL-1.1） |
| `native/mouse-hook.exe` | Windows WH_MOUSE_LL 鼠标钩子 |
| `native/mouse-hook-linux` | Linux XRecord 鼠标钩子 |
| `native/aria2/aria2c.exe` | aria2 下载引擎 |
| `docs/PACKAGE.md` | electron-builder 打包指南 |
| `docs/lessons-learned.md` | v2 开发经验 (详细版) |

### 测试

| 路径 | 用途 |
|------|------|
| `test/cdp-capture-test/` | BrowserWindow CDP 捕获 demo |
| `test/ws-capture-test/` | BrowserWindow eval 模式 demo |
| `test/bv-capture-test/` | BrowserView CDP/eval 双模式 demo |
| `test/download-test/` | aria2 下载测试 demo |
| `test/7k7k-probe.py` | 7k7k 登录探查脚本 |

---

> 基础架构记录始于 2026-07-31，自动化章节更新于 2026-08-14 | Electron 11.5.0 / Chromium 87

---

## 11. 用户脚本运行时

> 移植日期: 2026-08-05 | 模块来源: tests/electron/userscripts（demo，已验证）

### 11.1 模块布局

| 模块 | 职责 |
|---|---|
| `src/main/modules/userscripts/userscript-parser.ts` | 元数据解析 |
| `userscript-matcher.ts` | match/include/exclude 编译与 URL 匹配 |
| `userscript-values.ts` / `userscript-store.ts` | GM 值序列化与命名空间存储（内存，阶段 2 接持久化） |
| `userscript-require-cache.ts` | @require 抓取缓存（注入 fetcher） |
| `userscript-request.ts` / `userscript-request-service.ts` | GM_xmlhttpRequest 策略 + net 执行（connect/地址/大小/并发） |
| `userscript-download.ts` / `userscript-download-service.ts` | GM_download 文件名消毒 + net 下载 |
| `userscript-manager.ts` | 快照/报告/菜单命令/值监听/通知/SPA 记录 |
| `index.ts` | 单例工厂（initUserscriptManager） |
| `src/main/ipc/userscripts.ipc.ts` | 全部通道（zod 校验） |
| `src/webview-preload/userscripts/` | bootstrap/scheduler/sandbox/gm-api/page-bridge/unsafe-proxy |
| `src/shared/userscript-types.ts` | 共享类型（main + preload 两个 tsconfig 都 include） |

### 11.2 执行模型

- preload 在 document 创建时 `sendSync('userscript:get-config')` 拿**受限快照**（64KB 预算、每页源 512KB）；无匹配脚本返回空。
- 调度器按 run-at 阶段执行（document-start 等 documentElement 出现、body 等待有绝对超时）；每 document 每脚本执行一次。
- 沙箱：词法注入（never globals）；ppapi 模式 stripNodeGlobals + `new Function`；ruffle 共享世界受 CSP 时回退 `vm.runInThisContext`。
- 错误隔离：脚本异常 → script-error 报告，不阻断后续脚本与 Ruffle。

### 11.3 页世界桥（D5）

- ppapi 隔离世界下 `unsafeWindow` 是 Proxy，经 `window.postMessage` 转发到主世界桥（`window.__bfBridge`，由 preload `webFrame.executeJavaScript` 注入主世界）。
- 协议：`reply` 标记防自反馈循环；expected 集合配对；握手重试 + 就绪前队列。
- 语义边界：同步读复杂值返回路径 Wrapper；函数参数字符串化还原（严格 CSP 页还原失败则忽略）。

### 11.4 SPA 导航（D4）

- `did-navigate-in-page`（主框架）→ `manager.spaNavigate` 记录；软导航不重跑脚本。

### 11.5 已知边界

- 用户脚本不能直接访问 Node.js、Electron IPC 或本地文件系统；GM 能力按 grant、`@connect` 和主进程策略开放。
- `GM_cookie` 只读；后台脚本使用每脚本独立隐藏窗口，崩溃与重建策略和普通页面脚本不同。
- 下载目录位于受控用户数据目录，脚本管理页和侧边栏只通过校验后的 IPC 操作运行时。

---

## 12. 视觉自动化平台

> 集成版本：1.1.0。用户手册见 `docs/automation-user-guide.md`，M0–M5 的设计和探针记录位于 `docs/superpowers/specs/2026-08-09-automation-*.md`。

### 12.1 模块布局

| 模块 | 职责 |
| --- | --- |
| `src/shared/automation/types.ts` / `schema.ts` | 工作流、步骤、组合条件、脚本包清单及 zod 校验 |
| `src/main/modules/automation/runtime.ts` | 顺序、分支、循环、等待、取消和运行状态 |
| `browserview-driver.ts` | BrowserView 截图、可信鼠标/键盘输入、导航和最小化执行 |
| `vision-worker.cjs` / `vision-worker-matcher.ts` | OpenCV 模板匹配、预热、缓存、超时与工作线程隔离 |
| `service.ts` | 脚本包存储、运行编排、素材测试、状态与历史 |
| `package.ts` / `assets.ts` | `.baoauto` 导入导出、路径安全、素材扫描与诊断 |
| `src/main/ipc/automation.ipc.ts` | 工作台、测试台、取材、运行和调试 IPC |
| `AutomationPage.tsx` | `about:automation` 脚本库与编辑器壳 |
| `AutomationBlocklyEditor.tsx` | Blockly 定义、工作流双向转换和积木工具箱 |
| `AutomationAssetTestBench.tsx` | 指定场景图、素材列表、匹配分数和高亮结果 |
| `AutomationPanel.tsx` | 侧边栏状态与运行控制 |
| `automation-frame-assistant.user.js` | 页面内悬浮球、比对、运行控制和框选取材 |

### 12.2 数据流

```text
工作台/悬浮助手
  → preload 受限 API
  → automation IPC（zod 校验）
  → AutomationService
  → AutomationRunner
  → BrowserViewDriver.capture / trusted input
  → VisionWorkerMatcher（OpenCV worker）
  → 结构化状态事件
  → 工作台、侧栏、悬浮助手与 Toast
```

测试台和正式执行必须从同一 BrowserView 内容截图链路取图。悬浮助手只在截图瞬间隐藏，截图完成后恢复；不能通过改变 BrowserView 尺寸的侧边栏来承担执行期的唯一反馈。

### 12.3 坐标语义

工作流不持久化桌面绝对坐标。模板匹配返回 BrowserView 内容坐标，可信输入在执行瞬间换算并发送给目标 `webContents`。积木中的 `region` 和点击 `offset` 也属于内容图坐标，因此窗口移动和最小化不会改变其语义；页面缩放或游戏内部缩放仍可能改变目标像素外观。

### 12.4 `.baoauto` 边界

- `manifest.json` 的 `format` 固定为 `baoauto`，当前 `formatVersion` 为 1。
- 工作流固定为 `workflow.json`，素材位于 `assets/`。
- 脚本 ID 仅允许安全的字母、数字、点、下划线和连字符组合。
- 素材必须是安全相对 POSIX 路径，禁止绝对路径、反斜杠、空段、`.` 和 `..`。
- 导入包和素材都有大小、尺寸和数量边界；任何解压路径必须先通过越界检查。
- 运行前由 schema 再次校验工作流，不信任编辑器或外部脚本包传入的数据。

### 12.5 页面内助手的权限边界

自动化相框助手通过内置用户脚本运行，但只获得 `GM.baoAutomation` 暴露的专用能力：列出脚本和素材、读取状态、启动/停止、截图比对及保存框选素材。它不能直接访问 Node.js、任意 Electron IPC 或本地文件系统。

修改助手源码后必须执行完整构建或用户脚本管理 smoke。它与 CSS 修复器一样以文本嵌入主 bundle，直接启动旧 `dist/main.js` 会测试到陈旧版本。

### 12.6 关键回归

- `npm run probe:automation-m4`：工作台与 Blockly。
- `npm run probe:automation-m5-engines`：Web、PPAPI 注册和 Ruffle 的最小化视觉/输入链路。
- `npm run test:userscripts-admin`：内置助手、可见取消按钮和取材布局。
- `npm run test:smokes`：用户脚本、菜单命令和兼容性组合回归。
- 最终安装包仍需在真实 PPAPI 游戏人工验证，不得用“插件注册成功”代替“插件内容已渲染并接受输入”。
