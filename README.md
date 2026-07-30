# BaoFlashBrowser

> 跨平台 Flash 浏览器 | Cross-platform Flash Browser

基于 Electron 11 (Chromium 87) + React 17 + TypeScript + Jotai + BrowserView，原生 PPAPI Flash 插件支持。标签级渲染进程隔离，Windows / Linux 双平台（含 WSLg）。

Built on Electron 11 (Chromium 87) with React 17 + TypeScript + Jotai + BrowserView. Tab-level renderer process isolation for Flash. Supports native PPAPI Flash plugin on both Windows and Linux (including WSLg).

![platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-blue)
![electron](https://img.shields.io/badge/electron-11.5.0-brightgreen)
![flash](https://img.shields.io/badge/flash-PPAPI%2029%2B-red)

## 为什么使用 BrowserView Why BrowserView

Electron 的 `<webview>` 标签在 Flash 场景下存在致命缺陷：当一个标签页正在加载 Flash 内容时，在另一个标签页中打开新页面会导致渲染进程崩溃。这是因为多个 webview 共享同一个渲染管道，Flash 插件的大量 GPU 纹理和渲染指令相互抢占，最终导致整个渲染进程全局崩溃——所有标签页同时白屏。

BrowserView 为每个标签页创建独立的渲染进程，从根本上隔离了 Flash 的渲染管线。即便一个标签页因 Flash 崩溃，其他标签页完全不受影响。这在 Electron 11 中尤为重要——Chromium 87 是最后一个支持 PPAPI Flash 的版本，而 BrowserView 是唯一能在该版本上实现标签级进程隔离的方案。

## 功能 Features

- 原生 PPAPI Flash 支持（非 Ruffle 模拟）
- **标签级进程隔离**（BrowserView）——一个 Flash 崩溃不影响其他标签
- 多标签页浏览（Ctrl+T 新建 / Ctrl+W 关闭 / Ctrl+Tab 切换 / 拖拽排序）
- 抽屉式侧边栏（⭐ 收藏 🕐 历史 ⬇ 下载 ⚙ 设置）
- 地址栏导航、搜索（Bing / Google / 百度）+ 缩放比例胶囊
- 收藏夹管理（侧边栏内操作）
- 可配置 Flash 伪装版本（绕过网站反 Flash 检测）
- 链接打开方式可选（当前页 / 新标签页）
- 页面缩放（Ctrl+=/-/0 键盘 + Ctrl+滚轮，Flash 区域内全局生效）
- 浅色 / 暗黑双主题切换（IndexedDB 持久化）
- 主页 URL 自定义 + 简约导航首页
- F12 独立窗口 DevTools（页面 DevTools / Ctrl+Shift+I 壳 DevTools）
- 无边框窗口，自定义窗口控件
- 淘米 61.com 游戏门户反 Flash 检测绕过
- 右键原生菜单（新标签打开 / 复制 / 检查元素）
- 页内查找（Ctrl+F 嵌入查找栏）
- 历史记录自动记录 + 搜索过滤
- 下载管理 + 进度条
- 低端设备模式（减少 GPU 纹理缓存）
- IndexedDB + Dexie 持久化（收藏/历史/下载/设置）

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
| Ctrl+D | 收藏当前页（需先打开侧边栏） |
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

## 目录结构 Structure

```
BaoFlashBrowser/
├── src/
│   ├── main/
│   │   ├── index.ts              # 主进程入口
│   │   ├── modules/
│   │   │   ├── flash.ts          # Flash 插件加载 + mms.cfg 写入
│   │   │   ├── session.ts        # 会话初始化 + webRequest 拦截
│   │   │   ├── tabs.ts           # BrowserView TabManager（标签进程隔离）
│   │   │   ├── config.ts         # electron-store 配置
│   │   │   └── window.ts         # BrowserWindow 创建
│   │   └── ipc/
│   │       ├── shortcut.ipc.ts   # 快捷键分派 + globalShortcut + 原生鼠标钩子
│   │       ├── window.ipc.ts     # 窗口控制 IPC
│   │       ├── tabs.ipc.ts       # BrowserView 标签 IPC
│   │       └── config.ipc.ts     # 配置同步 IPC
│   ├── renderer/
│   │   ├── App.tsx               # 应用根组件
│   │   ├── components/
│   │   │   ├── layout/             # TopBar（合并标签+导航栏）+ DrawerSidebar（抽屉侧边栏）
│   │   │   ├── panels/             # Favorites/History/Downloads/Settings
│   │   │   ├── tabs/               # TabItem
│   │   │   └── overlays/           # FindBar, LoadingProgress
│   │   ├── atoms/                # Jotai 状态原子
│   │   ├── hooks/                # useTheme, useShortcut
│   │   └── services/             # db.ts (Dexie), id.service.ts
│   ├── preload/                  # 主窗口 preload（contextBridge）
│   ├── webview-preload/          # 页面 preload（navigator.plugins 注入）
│   └── shared/types/             # 公共类型定义
├── plugins/
│   ├── linux64/libpepflashplayer64.so   (32.0.0.371, Adobe 官方)
│   └── win64/pepflashplayer64.dll       (29.0.0.171, Adobe 官方)
├── native/
│   ├── mouse-hook.cs / .exe      # Windows WH_MOUSE_LL 鼠标钩子
│   └── mouse-hook-linux.c        # Linux XRecord 鼠标钩子
├── docs/
│   ├── layout-demo.html          # 抽屉侧边栏布局 Demo
│   ├── sidebar-demo.html         # 侧边栏交互 Demo
│   └── lessons-learned.md        # v2 开发经验总结
└── package.json
```

## Flash 插件选择

| 版本 | 来源 | 问题 |
|------|------|------|
| 34.0.0.330 | 重橙网络魔改 | 内置调试器，会弹出 AS3 错误对话框 |
| **29.0.0.171** | **Adobe 官方正式版** | 无时间炸弹、无调试弹窗、稳定 |
| 32.0.0.371 (Linux) | Adobe 官方 | EOL 前最后一版，正常注册 `navigator.plugins` |

版本 29 不被淘米 `checkUpgrade` 拦截（只拦截 major === 32），配合版本伪装 34 + SWFObject bypass 三重保障。

## v 1.0.0 → 当前版本对比

### 升级变更

| 模块 | v1.0.0 | 当前 |
|------|--------|------|
| 前端框架 | 原生 HTML/JS/CSS | **React 17 + TypeScript + Jotai** |
| 页面承载 | `<webview>`（同进程） | **BrowserView**（标签级进程隔离） |
| 标签管理 | 基础 URL 列表 | 完整标签管理 + 拖拽排序 |
| 收藏夹 | 无 | 抽屉侧边栏管理 |
| 设置面板 | localStorage | IndexedDB (Dexie) 持久化 |
| 缩放 | 无 | Ctrl+=/-/0 + Ctrl+滚轮，Flash 区域全局生效 |
| 数据存储 | localStorage | **IndexedDB** (Dexie) |
| 淘米 61.com | 不支持 | SWFObject bypass 支持 |
| 右键菜单 | 无 | 原生 Menu |
| 查找 | 无 | Ctrl+F 嵌入查找栏 |
| 下载管理 | 无 | 进度条 + 面板 |

### 保持不变

| 项目 | 说明 |
|------|------|
| **Electron 11.5.0 / Chromium 87** | 最后一个原生支持 PPAPI Flash 的版本 |
| **contextIsolation: true** | preload 通过 contextBridge 暴露 API |
| **no-sandbox (Linux)** | 必须参数 |

## License

MIT
