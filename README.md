# BaoFlashBrowser

> 跨平台 Flash 浏览器 | Cross-platform Flash Browser

基于 Electron 11 (Chromium 87) + React 17 + TypeScript + Jotai + BrowserView，原生 PPAPI Flash 插件 + Ruffle WASM 双核支持。标签级渲染进程隔离，Windows / Linux 双平台。

Built on Electron 11 (Chromium 87) with React 17 + TypeScript + Jotai + BrowserView. Native PPAPI Flash + Ruffle WASM dual-engine. Tab-level renderer process isolation. Supports Windows and Linux.

![platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-blue)
![electron](https://img.shields.io/badge/electron-11.5.0-brightgreen)
![flash](https://img.shields.io/badge/flash-PPAPI%2029%2B-red)
![ruffle](https://img.shields.io/badge/ruffle-0.4.1-blueviolet)

## 为什么使用 BrowserView Why BrowserView

Electron 的 `<webview>` 标签在 Flash 场景下存在致命缺陷：当一个标签页正在加载 Flash 内容时，在另一个标签页中打开新页面会导致渲染进程崩溃。这是因为多个 webview 共享同一个渲染管道，Flash 插件的大量 GPU 纹理和渲染指令相互抢占，最终导致整个渲染进程全局崩溃——所有标签页同时白屏。

BrowserView 为每个标签页创建独立的渲染进程，从根本上隔离了 Flash 的渲染管线。即便一个标签页因 Flash 崩溃，其他标签页完全不受影响。这在 Electron 11 中尤为重要——Chromium 87 是最后一个支持 PPAPI Flash 的版本，而 BrowserView 是唯一能在该版本上实现标签级进程隔离的方案。

## 功能 Features

### Flash 双核引擎（PPAPI + Ruffle）

- **PPAPI 原生 Flash**：默认引擎，兼容性最广
- **Ruffle WASM 模拟**：无需 Flash 插件，开源实现
- **标签页级别切换**：每个标签可独立选择 Flash / Ruffle
- **双源支持**：
  - 自托管（bundled）：离线可用，随安装包发布
  - CDN（unpkg）：始终最新版，首次需网络
- **Ruffle 配置可调**：画质 `best`、强制缩放 `forceScale`、中文字体支持
- **导航栏切换按钮**：Flash（暗红）⇄ Ruffle（蓝紫），显示 CDN 标签

### 标签页管理

- 多标签页浏览（Ctrl+T 新建 / Ctrl+W 关闭 / Ctrl+Tab 切换）
- 标签拖拽排序
- 标签压缩（Chrome 风格）——标签多时自动收缩，`+` 按钮始终可见
- **右键菜单**：后退/前进/刷新/复制/粘贴 + 引擎状态显示

### 侧边栏与面板

- 抽屉式侧边栏（⭐ 收藏 🕐 历史 ⬇ 下载 ⚙ 设置）
- 侧边栏折叠按钮——展开/全屏模式一键切换
- 下载面板：文件类型图标 + 红/绿点通知 badge
- 历史记录：自动记录、搜索过滤、按日期分组
- 收藏夹管理 + 导航栏星标快捷收藏
- 设置面板：搜索引擎、主页、Flash 版本伪装、Ruffle 引擎/来源选择
- 页内查找栏（Ctrl+F 嵌入）

### 界面与交互

- 地址栏导航 + 搜索引擎（Bing / Google / 百度 / 4399 站内搜索）
- 缩放比例胶囊（Ctrl+=/-/0 + Ctrl+滚轮，Flash 区域内全局生效）
- 浅色 / 暗黑双主题切换（IndexedDB 持久化）
- 无边框窗口，自定义窗口控件
- F12 独立窗口 DevTools

### 兼容性与稳定性

- 淘米 61.com 游戏门户反 Flash 检测绕过（SWFObject bypass）
- Flash 版本伪装（绕过网站版本检测）
- 低端设备模式（减少 GPU 纹理缓存）
- 跨域 SWF 加载（CORS 头自动注入）
- IndexedDB + Dexie 持久化（收藏/历史/下载/设置）
- 启动时自动清理损坏下载记录

## 快捷键 Shortcuts

| 快捷键 | 功能 |
|--------|------|
| Ctrl+T | 新建标签页 |
| Ctrl+W | 关闭标签页 |
| Ctrl+Tab / Ctrl+Shift+Tab | 切换标签页 |
| Ctrl+1~8 | 切换到第 N 个标签页 |
| Ctrl+= / Ctrl++ | 放大 |
| Ctrl+- | 缩小 |
| Ctrl+0 | 重置缩放 |
| Ctrl+滚轮 | 放大/缩小（Flash 区域内全局生效） |
| Ctrl+L / Alt+D | 聚焦地址栏 |
| Ctrl+R / F5 | 刷新 |
| Ctrl+D | 收藏当前页 |
| Ctrl+H | 历史记录面板 |
| Ctrl+F | 页内查找（嵌入栏） |
| Alt+← / Alt+→ | 后退 / 前进 |
| F11 | 全屏切换 |
| F12 | 页面 DevTools（独立窗口） |
| Ctrl+Shift+I | Electron 壳 DevTools（独立窗口） |

## 技术栈 Tech Stack

| 组件 | 版本 | 说明 |
|------|------|------|
| Electron | 11.5.0 | 锁定（最后一个支持 PPAPI Flash 的版本） |
| Chromium | 87 | Electron 11 内置 |
| React | 17 | Node 12 兼容上限 |
| TypeScript | 4.9.5 | ES2019 target |
| Jotai | 1.x | 轻量状态管理 |
| Dexie | 3.x | IndexedDB 封装 |
| Ruffle | 0.4.1 | WASM Flash 模拟器 |
| webpack | 5 | target: web |
| Flash PPAPI | 29.0.0.171 (Win) / 32.0.0.371 (Linux) | Adobe 官方正式版 |

## 运行 Run

```bash
npm install
npm start
```

### Linux 额外依赖

```bash
sudo apt install -y libnss3 libgtk-3-0 libx11-xcb1 libxtst6 libxss1 \
  libasound2 libdrm2 libgbm1 libxkbcommon0 libpango-1.0-0 libcairo2 \
  libatk1.0-0 libatk-bridge2.0-0 libcups2 libxcomposite1 libxdamage1 \
  libxfixes3 libxrandr2 libxrender1 libxi6 libnotify4 libsecret-1-0 \
  libpulse0 libdbus-1-3
```

## 文档 Docs

- [架构手册](docs/architecture-manual.md) — 面向二次开发的完整系统解析（模块、数据流、经验教训）
- [打包手册](docs/PACKAGE.md)
- [v2 开发经验总结](docs/lessons-learned.md)

## 目录结构 Structure

```
BaoFlashBrowser/
├── src/
│   ├── main/
│   │   ├── index.ts              # 主进程入口
│   │   ├── modules/
│   │   │   ├── flash.ts          # Flash 插件加载 + mms.cfg 写入
│   │   │   ├── session.ts        # 会话初始化 + webRequest 拦截 + CORS 注入
│   │   │   ├── tabs.ts           # BrowserView TabManager（标签进程隔离 + Ruffle 模式）
│   │   │   ├── config.ts         # electron-store 配置
│   │   │   ├── password-store.ts # 主密码 + DPAPI 密码管理器
│   │   │   ├── dpapi.ts          # Windows DPAPI 加密
│   │   │   ├── ruffle-bundle.ts  # Ruffle JS 预加载（内联注入用）
│   │   │   └── window.ts         # BrowserWindow 创建
│   │   └── ipc/
│   │       ├── shortcut.ipc.ts   # 快捷键分派 + globalShortcut + 原生鼠标钩子
│   │       ├── window.ipc.ts     # 窗口控制 IPC
│   │       ├── tabs.ipc.ts       # BrowserView 标签 + Ruffle 模式 + 下载 IPC
│   │       └── config.ipc.ts     # 配置同步 IPC
│   ├── renderer/
│   │   ├── App.tsx               # 应用根组件
│   │   ├── components/
│   │   │   ├── layout/             # TopBar + DrawerSidebar（抽屉侧边栏）
│   │   │   ├── navigation/         # RuffleToggle（Flash/Ruffle 切换开关）
│   │   │   ├── panels/             # Favorites/History/Downloads/Settings
│   │   │   ├── tabs/               # TabItem
│   │   │   ├── shell/              # WindowControls
│   │   │   ├── overlays/           # FindBar, LoadingProgress
│   │   │   └── ErrorBoundary.tsx   # React 错误边界
│   │   ├── atoms/                # Jotai 状态原子
│   │   ├── hooks/                # useTheme, useShortcut
│   │   └── services/             # db.ts (Dexie), id.service.ts
│   ├── preload/                  # 主窗口 preload（contextBridge）
│   ├── webview-preload/          # 页面 preload（Ruffle 注入 + 登录捕获）
│   └── shared/types/             # 公共类型定义
├── plugins/
│   ├── linux64/libpepflashplayer64.so   (32.0.0.371, Adobe 官方)
│   └── win64/pepflashplayer64.dll       (29.0.0.171, Adobe 官方)
├── native/
│   ├── mouse-hook.cs / .exe      # Windows WH_MOUSE_LL 鼠标钩子
│   └── mouse-hook-linux.c        # Linux XRecord 鼠标钩子
├── assets/
│   └── simhei.ttf                # 中文字体（Ruffle 设备字体回退）
├── docs/
│   ├── PACKAGE.md                # 打包手册
│   └── lessons-learned.md        # v2 开发经验总结
├── build/
│   ├── icon.svg / .png / .ico    # 多尺寸应用图标
│   └── make-icon.js              # 图标生成脚本
└── package.json
```

## Flash 插件选择

| 版本 | 来源 | 问题 |
|------|------|------|
| 34.0.0.330 | 重橙网络魔改 | 内置调试器，会弹出 AS3 错误对话框 |
| **29.0.0.171 (Win)** | **Adobe 官方正式版** | 无时间炸弹、无调试弹窗、稳定 |
| **32.0.0.371 (Linux)** | Adobe 官方 | EOL 前最后一版，正常注册 `navigator.plugins` |

版本 29 不被淘米 `checkUpgrade` 拦截（只拦截 major === 32），配合版本伪装 34 + SWFObject bypass 三重保障。

## v 1.0.0 → 当前版本对比

### 升级变更

| 模块 | v1.0.0 | 当前 |
|------|--------|------|
| 前端框架 | 原生 HTML/JS/CSS | **React 17 + TypeScript + Jotai** |
| 页面承载 | `<webview>`（同进程） | **BrowserView**（标签级进程隔离） |
| 标签管理 | 基础 URL 列表 | 完整标签管理 + 拖拽排序 + 压缩 |
| 收藏夹 | 无 | 抽屉侧边栏管理 + 导航栏星标按钮 |
| 设置面板 | localStorage | IndexedDB (Dexie) 持久化 |
| 缩放 | 无 | Ctrl+=/-/0 + Ctrl+滚轮，Flash 区域全局生效 |
| 数据存储 | localStorage | **IndexedDB** (Dexie) |
| 淘米 61.com | 不支持 | SWFObject bypass 支持 |
| 右键菜单 | 无 | 原生 Menu（引擎状态显示） |
| 查找 | 无 | Ctrl+F 嵌入查找栏 |
| 下载管理 | 无 | 文件图标 + 状态通知 + 侧边栏 badge |
| 历史记录 | 无 | 自动记录 + 搜索过滤 + 日期分组 |
| **Flash 引擎** | PPAPI 单一 | **PPAPI + Ruffle 双核**，标签页级别切换 |
| **Ruffle 来源** | 无 | 自托管（bundled）/ CDN（始终最新） |
| **侧边栏** | 无 | 折叠/展开开关，全屏模式 |
| **中文字体** | 无 | Ruffle 设备字体 + 黑体回退 |
| **错误处理** | 白屏 | ErrorBoundary 组件，捕获异常显示重试 |

### 保持不变

| 项目 | 说明 |
|------|------|
| **Electron 11.5.0 / Chromium 87** | 最后一个原生支持 PPAPI Flash 的版本 |
| **contextIsolation** | PPAPI 标签 `true`，Ruffle 标签 `false`（设计如此） |
| **no-sandbox (Linux)** | 必须参数 |

## License

MIT
