# BaoFlashBrowser

> 基于 Electron 11 的跨平台 Flash 浏览器——让 PPAPI Flash 在现代系统上继续运行。

[中文](README.md) **|** [English](README_EN.md)

[![platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-blue)](https://github.com/Sutanm/BaoFlashBrowser)
[![electron](https://img.shields.io/badge/electron-11.5.0-brightgreen)](https://www.electronjs.org/)
[![react](https://img.shields.io/badge/react-18.3-blue)](https://react.dev/)
[![flash](https://img.shields.io/badge/flash-PPAPI%2029%2F32-red)](#flash-插件版本)
[![ruffle](https://img.shields.io/badge/ruffle-0.4.1-blueviolet)](https://ruffle.rs/)

## 目录

- [为什么做这个](#为什么做这个)
- [核心特性](#核心特性)
- [技术架构](#技术架构)
- [快速开始](#快速开始)
- [功能详解](#功能详解)
- [快捷键](#快捷键)
- [目录结构](#目录结构)
- [开发指南](#开发指南)
- [Flash 插件版本](#flash-插件版本)
- [License](#license)

## 为什么做这个

2020 年 12 月 31 日，Adobe 正式停止 Flash Player 支持。此后所有主流浏览器移除了 PPAPI（Pepper Plugin API）支持，大量基于 Flash 的网页游戏和内容无法再运行。虽然 Ruffle 等开源替代品在持续进步，但对 ActionScript 3 的支持仍不完整。

**Chromium 87 是最后一个原生支持 PPAPI Flash 的浏览器内核**。本项目基于 Electron 11（内嵌 Chromium 87）构建，旨在提供一个开箱即用的 Flash 浏览体验，同时通过 BrowserView 架构解决传统方案中的稳定性问题。

### BrowserView vs `<webview>` 标签

Electron 的 `<webview>` 标签在 Flash 场景下有致命缺陷——多个 webview 共享同一渲染管道，当一个标签页加载 Flash 内容时，在另一个标签页中打开新页面会导致渲染进程崩溃，所有标签页同时白屏。

BrowserView 为每个标签页创建独立的渲染进程，从根本上隔离了 Flash 的渲染管线。一个标签页崩溃不会影响其他标签页。

## 核心特性

- **PPAPI + Ruffle 双核引擎**：原生 Flash 插件和 WASM 模拟器，标签页级别独立切换
- **标签页管理**：多标签、拖拽排序、Chrome 风格压缩、完整的导航控制
- **密码管理器**：CDP 自动捕获登录凭据、AES-256-GCM 加密存储、主密码保护
- **下载管理器**：aria2 多线程引擎、三级启动保底、路径安全校验
- **侧边栏面板**：收藏夹、历史记录、下载、密码本、设置
- **淘米 61.com 兼容**：SWFObject 网络层绕过、Flash 版本伪装
- **跨平台**：Windows / Linux 双平台（WSL 可用）

## 技术架构

| 层级 | 技术 | 说明 |
|------|------|------|
| 桌面壳 | Electron 11.5.0 | 锁定——Chromium 87，最后支持 PPAPI |
| 前端框架 | React 18 + TypeScript 5 | createRoot 并发模式 |
| 状态管理 | Zustand 5 + Dexie 4 | Persist 中间件 + liveQuery 响应式 |
| 主进程构建 | esbuild 0.28 | ~14ms 构建，CJS 输出 |
| 渲染进程构建 | Vite 6 | ~1.8s 构建，HMR 开发 |
| 样式 | Tailwind CSS 3.4 | 锁版本——Chromium 87 不支持 v4 |
| 加密 | AES-256-GCM + PBKDF2 | 250,000 迭代密钥派生 |
| 测试 | Vitest + Playwright | 单元测试 + E2E |
| 代码质量 | ESLint 9 + Prettier | Flat config |

完整架构图：

```
┌──────────────────────────────────────────────────────────┐
│                     Electron 11 (Chromium 87)               │
│                                                            │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  main process │  │  BrowserViews │  │  renderer process │  │
│  │               │  │  (tab 1..N)   │  │                   │  │
│  │  tab manager  │  │  ┌──────────┐ │  │  React 18 App     │  │
│  │  download mgr │  │  │ PPAPI or │ │  │  ┌─────────────┐ │  │
│  │  password     │  │  │ Ruffle   │ │  │  │ TopBar       │ │  │
│  │  session      │  │  │ engine   │ │  │  │ + Drawer     │ │  │
│  │  flash loader │  │  └──────────┘ │  │  │ + Panels     │ │  │
│  │  ipc handlers │  │               │  │  └─────────────┘ │  │
│  └──────┬────────┘  └──────┬────────┘  └────────┬─────────┘  │
│         │                  │                     │            │
│         └────── IPC ───────┴────── IPC ──────────┘            │
│                            │                                  │
│                    ┌───────┴───────┐                          │
│                    │ electron-store │  (配置文件 + 密码加密)     │
│                    │ Dexie/IndexedDB│  (收藏/历史/下载/设置)      │
│                    └───────────────┘                          │
└──────────────────────────────────────────────────────────┘
```

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式（热更新）
npm run dev

# 构建 + 启动
npm start

# 打包
npm run build:win      # Windows NSIS 安装包
npm run build:linux    # Linux AppImage
```

### Linux 依赖

```bash
sudo apt install -y libnss3 libgtk-3-0 libx11-xcb1 libxtst6 libxss1 \
  libasound2 libdrm2 libgbm1 libxkbcommon0 libpango-1.0-0 libcairo2 \
  libatk1.0-0 libatk-bridge2.0-0 libcups2 libxcomposite1 libxdamage1 \
  libxfixes3 libxrandr2 libxrender1 libxi6 libnotify4 libsecret-1-0 \
  libpulse0 libdbus-1-3
```

## 功能详解

### Flash 双核引擎

每个标签页可以独立选择 Flash 引擎：

- **PPAPI 原生**（默认）：Adobe 官方插件，兼容性最好
- **Ruffle WASM**：开源模拟器，无需原生插件

Ruffle 支持两种来源：
- **自托管（Bundled）**：随应用打包，离线可用
- **CDN**：始终使用最新版 Ruffle，首次需要网络

Ruffle 配置项：画质（`best`）、强制缩放（`forceScale`）、中文字体回退（黑体）。

### 标签页管理

- 完整的导航控制：前进、后退、刷新、停止
- 页面标题和 favicon 实时同步
- 静音开关、媒体播放状态指示
- 页面内缩放（每个标签独立）
- 崩溃恢复——单个标签崩溃不影响其他标签
- 链接拖拽到标签栏打开新标签

### 密码管理器

采用 CDP（Chrome DevTools Protocol）捕获登录凭据，支持 8 种捕获策略：

| 策略 | 适用场景 |
|------|----------|
| `form.submit` | 传统表单提交 |
| `beforeunload` | 页面离开时捕获 |
| 轮询检测（200ms） | AJAX 无刷新登录 |
| `fetch` / `xhr` 拦截 | 从请求体中提取凭据 |
| `sendBeacon` 拦截 | 异步上报登录 |
| Script.src / Image.src 拦截 | JSONP 登录（如 7k7k） |
| MutationObserver | DOM 动态变化检测 |

加密方案：
- 主密码 → PBKDF2-SHA256（250,000 迭代）→ KEK
- DEK（数据加密密钥）用 KEK 加密存储
- 每条密码用 DEK 通过 AES-256-GCM 加密
- 主密码要求：8 字符以上，含大小写字母和数字

### 下载管理器

双引擎架构，自动选择最佳引擎：

| 特性 | aria2 | Chromium 内置 |
|------|-------|--------------|
| 多线程 | 16 线程分片 | 单线程 |
| 断点续传 | 支持 | 有限支持 |
| 下载速度 | 更快 | 一般 |
| 优先级 | 捆绑 > 系统 PATH | 回退方案 |

aria2 启动三级保底：捆绑二进制 → 系统已安装 → 降级为 Chromium 内置引擎。

安全措施：下载路径防目录穿越、危险扩展名黑名单（`.exe/.bat/.cmd/.ps1/.vbs/.js/.wsf/.scr/.com`）。

### 消息通知

采用地址栏翻转动画作为 Toast 通知——因 BrowserView 始终处于最顶层，传统浮动 Toast 会被其遮挡。支持两种模式：

- **纯文本消息**：自动消失（如「已复制到剪贴板」）
- **交互式覆盖层**：需要用户操作（如「保存密码？」保存/忽略按钮）

### 主题系统

支持浅色 / 深色 / 跟随系统 三种模式，通过 CSS 变量实现，所有面板和 UI 元素自动适配。

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+T` | 新建标签页 |
| `Ctrl+W` | 关闭当前标签页 |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 下一个 / 上一个标签页 |
| `Ctrl+1` ~ `8` | 切换到第 N 个标签页 |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | 放大 / 缩小 / 重置缩放 |
| `Ctrl+滚轮` | 缩放（Flash 区域内全局生效） |
| `Ctrl+L` / `Alt+D` | 聚焦地址栏 |
| `Ctrl+R` / `F5` | 刷新 |
| `Ctrl+D` | 收藏当前页 |
| `Ctrl+H` | 打开历史记录面板 |
| `Ctrl+F` | 页内查找 |
| `Ctrl+S` | 保存页面 |
| `Ctrl+N` | 新建窗口 |
| `Alt+←` / `Alt+→` | 后退 / 前进 |
| `F11` | 全屏切换 |
| `F12` / `Ctrl+Shift+I` | 打开 DevTools |

## 目录结构

```
BaoFlashBrowser/
├── src/
│   ├── main/                          # 主进程
│   │   ├── index.ts                   # 入口：窗口创建、模块初始化
│   │   ├── modules/
│   │   │   ├── window.ts              # BrowserWindow 创建（ready-to-show）
│   │   │   ├── tabs.ts                # TabManager：BrowserView 生命周期
│   │   │   ├── flash.ts               # PPAPI 插件加载 + mms.cfg
│   │   │   ├── session-manager.ts     # UA、crossdomain.xml、SWFObject 补丁、CORS
│   │   │   ├── download.ts            # aria2 下载管理器
│   │   │   ├── password-capture.ts    # CDP 密码捕获
│   │   │   ├── password-store.ts      # AES-256-GCM 加密密码存储
│   │   │   ├── crypto-helper.ts       # 密码学工具
│   │   │   ├── config.ts              # electron-store 主配置
│   │   │   └── ruffle-bundle.ts       # Ruffle JS 懒加载
│   │   ├── ipc/                       # IPC 处理器
│   │   │   ├── tabs.ipc.ts            # 标签页操作（15 通道）
│   │   │   ├── window.ipc.ts          # 窗口控制（7 通道）
│   │   │   ├── shortcut.ipc.ts        # 全局快捷键 + 鼠标钩子
│   │   │   ├── download.ipc.ts        # 下载管理（10 通道）
│   │   │   ├── password.ipc.ts        # 密码管理（12 通道）
│   │   │   └── config.ipc.ts          # 配置同步（2 通道）
│   │   └── utils/
│   │       └── ipc-wrapper.ts         # IPC handler 统一封装
│   ├── renderer/                      # 渲染进程（React）
│   │   ├── App.tsx                    # 根组件
│   │   ├── index.tsx                  # 渲染入口（createRoot）
│   │   ├── styles.css                 # 全局样式 + 自定义组件 + 动画
│   │   ├── components/
│   │   │   ├── layout/                # TopBar + DrawerSidebar
│   │   │   ├── navigation/            # RuffleToggle
│   │   │   ├── panels/                # Favorites / History / Downloads / Passwords / Settings
│   │   │   ├── tabs/                  # TabItem（React.memo）
│   │   │   ├── shell/                 # WindowControls
│   │   │   ├── overlays/              # FindBar / LoadingProgress
│   │   │   ├── newtab/                # NewTabPage
│   │   │   └── ErrorBoundary.tsx      # 错误边界
│   │   ├── hooks/                     # useTabManager / useTheme / useShortcut 等
│   │   ├── store/                     # Zustand stores（useDataStore / useTabsStore）
│   │   ├── services/                  # db.ts（Dexie）/ keyboard / url / id
│   │   └── types/                     # electron.d.ts 类型声明
│   ├── preload/index.ts               # 主窗口 preload（contextBridge + IPC 白名单）
│   ├── webview-preload/index.ts       # 页面 preload（Ruffle + 登录识别 + 自动填充）
│   └── shared/types/                  # 公共类型（tab / settings / downloads / passwords / history / bookmarks / ipc）
├── plugins/                           # Flash 插件（随应用打包）
│   ├── linux64/libpepflashplayer64.so
│   ├── win32/pepflashplayer.dll
│   └── win64/pepflashplayer64.dll
├── native/                            # 原生工具
│   ├── aria2/                         # 捆绑的 aria2 二进制
│   ├── mouse-hook.exe                 # Windows 鼠标钩子（WH_MOUSE_LL）
│   └── mouse-hook-linux               # Linux 鼠标钩子（XRecord）
├── assets/
│   ├── images/                        # 新标签页背景图
│   └── simhei.ttf                     # 中文字体（Ruffle 回退）
├── docs/
│   ├── PACKAGE.md                     # 打包手册
│   └── lessons-learned.md             # v2 开发经验总结
├── test/                              # 独立测试脚本
├── build/                             # 图标资源
├── esbuild.main.config.mjs            # esbuild 主进程构建配置
├── vite.renderer.config.ts            # Vite 渲染进程构建配置
└── package.json
```

## 开发指南

### 浏览器兼容性约束

本项目锁定 Electron 11 / Chromium 87，**不得升级任何内核相关组件**：

- **Electron**：11.5.0 是最后一个支持 PPAPI Flash 的版本
- **Tailwind CSS**：锁定 3.4——v4 使用 `oklch()` 颜色空间和 CSS `@property`，Chromium 87 不支持
- **Node.js**：Electron 11 内嵌 Node 12，依赖需兼容该版本

### 关键注意事项

1. **CDP `debugger.attach` 会阻塞 `<script>` 的 `onload` 回调**：密码捕获后必须在非 `beforeunload` 来源时执行 `detach`，否则 JSONP 登录（如 7k7k）会卡死
2. **跨域 iframe 无法用 `executeJavaScript`**：必须走 CDP `Runtime.evaluate` + `contextId`
3. **登录方式因站点而异**：4399 用 `<form>` submit，7k7k 用 `<script>` JSONP 注入——先探测再编码
4. **Linux 必须加 `--no-sandbox`**；WSLg 需三个 GPU flag：`--ignore-gpu-blacklist`、`--enable-gpu-rasterization`、`--enable-zero-copy`
5. **`did-fail-load` 不要调用 `wc.stop()`**：会杀死登录后重定向
6. **BrowserView 始终在最顶层**：DOM 元素无法覆盖它，Toast 等 UI 需特殊处理

### 调试流程

1. 先理清完整链路再动手
2. 先用独立测试脚本验证（参考 `test/` 目录）
3. 测试通过后再集成到主项目
4. 站点特有问题：用 Python/Node.js + Playwright 探测实际网络请求和 DOM 行为

## Flash 插件版本

| 版本 | 平台 | 来源 | 说明 |
|------|------|------|------|
| 29.0.0.171 | Windows | Adobe 官方 | 无时间炸弹、无调试弹窗、稳定 |
| 32.0.0.371 | Linux | Adobe 官方 | EOL 前最后一版 |
| ~~34.0.0.330~~ | ~~Windows~~ | ~~重橙网络~~ | 内置调试器、弹 AS3 错误，不使用 |

版本 29 不被淘米 `checkUpgrade` 拦截（只拦截 `major === 32`），配合版本伪装 34 + SWFObject bypass 三重保障。

## License

[MIT](LICENSE)
