# BaoFlashBrowser

> 跨平台 Flash 浏览器 | Cross-platform Flash Browser

基于 Electron 11 (Chromium 87) + React 17 + TypeScript + Jotai，原生 PPAPI Flash 插件支持。专为 Flash 游戏设计，Windows / Linux 双平台（含 WSLg）。

Built on Electron 11 (Chromium 87) with React 17 + TypeScript + Jotai. Supports native PPAPI Flash plugin on both Windows and Linux (including WSLg).

![platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-blue)
![electron](https://img.shields.io/badge/electron-11.5.0-brightgreen)
![flash](https://img.shields.io/badge/flash-PPAPI%2032%2B-red)

## 功能 Features

- 原生 PPAPI Flash 支持（非 Ruffle 模拟）
- 多标签页浏览（Ctrl+T 新建 / Ctrl+W 关闭 / Ctrl+Tab 切换）
- 地址栏导航、搜索（Bing / Google / 百度）
- 收藏夹管理
- 可配置 Flash 伪装版本（绕过网站反 Flash 检测）
- 链接打开方式可选（当前页 / 新标签页）
- 页面缩放（Ctrl+=/-/0 键盘 + Ctrl+滚轮，Flash 区域内全局生效）
- 浅色 / 暗黑双主题切换
- 主页 URL 自定义 + 简约导航首页
- F12 内嵌 DevTools
- 无边框窗口，自定义窗口控件
- 淘米 61.com 游戏门户反 Flash 检测绕过

## v 1.0.0 → 1.0.1 版本对比

### 升级变更

| 模块 | v1.0.0 | v1.0.1 |
|------|--------|--------|
| 前端框架 | 原生 HTML/JS/CSS（单文件 ~800 行） | **React 17 + TypeScript + Jotai** 组件化重写 |
| 标签管理 | 基础 URL 列表切换 | 完整标签页管理：Ctrl+T/W/Tab，编号切换，webview 不卸载 |
| 收藏夹 | 无 | 双击星标添加/移除，独立面板 |
| 设置面板 | 基础 localStorage | React 面板，electron-store 持久化，版本号伪装同步主进程 |
| 搜索引擎 | 仅 Bing | Bing / Google / 百度三选一 |
| 主页 | about:newtab 固定 | 自定义 URL + 简约导航首页 |
| 缩放 | 无 | **Ctrl+=/-/0 + Ctrl+滚轮**，Flash 区域内全局生效 |
| Ctrl+滚轮在 Flash 内 | 不支持 | **支持**（Windows: WH_MOUSE_LL 钩子，Linux: XRecord） |
| 淘米 61.com | 不支持（触发升级拦截页） | **支持**（webRequest 拦截替换 swfobject.js） |
| 主题 | 浅色 only | 浅色 / 暗黑双主题切换 |

### 保持不变

| 项目 | 说明 |
|------|------|
| **Electron 11.5.0 / Chromium 87** | 最后一个原生支持 PPAPI Flash 的版本，不可升级 |
| **PPAPI Flash 插件** | Windows: `pepflashplayer64.dll` (34.0.0.330) / Linux: `libpepflashplayer64.so` (32.0.0.371) |
| **no-sandbox (Linux)** | 必须参数，否则沙箱与 Flash 不兼容 |
| **contextIsolation: true** | 开启，preload 脚本通过 contextBridge 暴露 API |
| **打包工具** | electron-builder 22.x |

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
| Ctrl+F | 页内查找 |
| F11 | 全屏 |
| F12 | 检查（聚焦地址栏：Electron 壳 DevTools；其他位置：页面 DevTools） |

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

### 打包 Build

```bash
# 构建代码
npm run build

# 打包
npm run build:win    # Windows NSIS 安装器
npm run build:linux  # Linux AppImage

# 添加镜像加速
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
```

## 技术栈 Tech Stack

| 组件 | 版本 | 说明 |
|------|------|------|
| Electron | 11.5.0 | 锁定（最后一个支持 PPAPI Flash 的版本） |
| Chromium | 87 | Electron 11 内置 |
| React | 17 | Node 12 兼容上限 |
| TypeScript | 4.9.5 | ES2019 target |
| Jotai | 1.x | 轻量状态管理 |
| webpack | 5 | target: web, CJS 兼容 |
| Flash PPAPI | 34.0.0.330 (Windows) / 32.0.0.371 (Linux) | 原生插件 |

## 目录结构 Structure

```
BaoFlashBrowser/
├── src/
│   ├── main/
│   │   ├── index.ts              # 主进程入口
│   │   ├── modules/
│   │   │   ├── flash.ts          # Flash 插件加载与版本注入
│   │   │   ├── session.ts        # 会话初始化 + webRequest 拦截
│   │   │   ├── config.ts         # electron-store 配置
│   │   │   └── window.ts         # BrowserWindow 创建
│   │   └── ipc/
│   │       ├── shortcut.ipc.ts   # 快捷键分派 + globalShortcut + 原生鼠标钩子
│   │       └── window.ipc.ts     # 窗口控制 IPC
│   ├── renderer/
│   │   ├── App.tsx               # 应用根组件（缩放、快捷键处理）
│   │   ├── components/           # 标签栏、地址栏、面板、覆盖层等
│   │   ├── atoms/                # Jotai 状态原子
│   │   ├── hooks/                # 自定义 hooks
│   │   └── services/             # 标签管理、键盘等
│   ├── preload/                  # 主窗口 preload 脚本
│   ├── webview-preload/          # Webview 内 preload（navigator.plugins 注入）
│   └── shared/types/             # 公共类型定义
├── plugins/
│   ├── linux64/libpepflashplayer64.so
│   ├── win64/pepflashplayer64.dll
│   └── win32/pepflashplayer.dll
├── native/
│   ├── mouse-hook.cs / .exe      # Windows WH_MOUSE_LL 鼠标钩子
│   └── mouse-hook-linux.c        # Linux XRecord 鼠标钩子
├── docs/lessons-learned.md       # v2 开发经验总结
└── package.json
```

## Flash 与快捷键开发历程

### Flash 插件兼容性

Electron 11 是最后一个原生支持 PPAPI Flash 的版本，无法升级。核心挑战：

- **版本伪装**：`--ppapi-flash-version` 决定 `navigator.plugins` 的描述字段，须传 >32 的版本号以绕过网站版本检测
- **Linux 无 navigator.plugins**：Linux PPAPI Flash 不在 `navigator.plugins` 中注册，需 webview-preload JS 注入
- **淘米 61.com 反检测**：魔改 SWFObject 同时检测版本号 AND 插件文件名后缀。网络层 `webRequest.onBeforeRequest` 拦截替换 `swfobject.js` 是唯一跨平台可靠方案

### 全局快捷键攻克 Flash 区域

Flash 通过 DirectInput / XInput 直读输入设备，绕过了常规的键盘事件通道。在 Flash 游戏内区域：

| 快捷键 | Windows 实现 | Linux 实现 | 原理 |
|--------|-------------|-----------|------|
| Ctrl+=/-/0 | `globalShortcut` (RegisterHotKey) | `globalShortcut` (X11) | 内核键盘驱动层拦截，DirectInput 绕不过 |
| Ctrl+滚轮 | `WH_MOUSE_LL` 全局钩子 (mouse-hook.exe) | XRecord 被动监听 (mouse-hook-linux) | OS 最低层鼠标钩子，比 Flash 更底层 |

失败过的方案：
- `before-input-event`：Flash 捕获事件后 webContents 收不到
- `electron-localshortcut`：`WH_KEYBOARD_LL` 被 DirectInput 绕过
- `XGrabButton`（Linux 滚轮）：compositor 先占了 root 窗口 grab，换 XRecord 解决

## License

MIT
