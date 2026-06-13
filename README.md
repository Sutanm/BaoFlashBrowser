# BaoFlashBrowser

> 跨平台 Flash 浏览器 | Cross-platform Flash Browser

基于 Electron 11 (Chromium 87) + PPAPI 原生 Flash 插件，专为运行 Flash 游戏设计，支持 Windows 和 Linux 双平台(只在wsl上测试)。

A desktop Flash browser built on Electron 11 (Chromium 87) with native PPAPI Flash plugin support. Designed for Flash gaming on both Windows and Linux.

![platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-blue)
![electron](https://img.shields.io/badge/electron-11.5.0-brightgreen)
![flash](https://img.shields.io/badge/flash-PPAPI%2032%2B-red)
<img width="1280" height="770" alt="wsl" src="https://github.com/user-attachments/assets/4f789df8-9baf-4f49-8cf5-81d78d8dc3ef" />
<img width="1280" height="770" alt="windows" src="https://github.com/user-attachments/assets/6226719d-7e1e-49f1-b6e5-c0f34254ac69" />

## 功能 Features

- 🎮 原生 PPAPI Flash 支持（非 Ruffle 模拟）
- 🧩 多标签页浏览（Ctrl+T 新建 / + 按钮）
- 🎨 浅色/暗黑双主题切换
- 🔗 链接打开方式可选（当前页 / 新标签页）
- ⭐ 收藏夹管理（双击星标添加/移除）
- 🔧 Flash 伪装版本（绕过网站版本检测）
- 🔍 地址栏搜索回退（Bing）
- 🏠 简约导航首页
- ⌨️ F12 右侧内嵌 DevTools
- 🇨🇳 中文界面

## 运行 Run

### 开发模式 Development

```bash
npm install
npm start
```

### 已打包版本 Packaged

| 平台 | 文件 | 运行方式 |
|------|------|----------|
| Windows | `dist/BaoFlashBrowser Setup 1.0.0.exe` | 双击安装 |
| Linux | `dist/BaoFlashBrowser-1.0.0.AppImage` | `chmod +x` 后双击 |

### 🐧 Linux 额外依赖

AppImage 需要 FUSE 运行，请先安装：

```bash
# Ubuntu / Debian
sudo apt install -y fuse libfuse2

# Fedora
sudo dnf install -y fuse fuse-libs

# Arch
sudo pacman -S fuse2

```bash

## 打包 Build

# 安装依赖
npm install

# 生成图标（可选）
npm run icon

# 打包 Windows (NSIS 安装器)
npm run build:win

# 打包 Linux (AppImage)
npm run build:linux

# 双平台
npm run build
```

> **提示：** 在内网/国内环境构建时，可设置镜像加速：
> ```powershell
> # Windows PowerShell
> $env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
> npm run build:win
> ```
> ```bash
> # Linux
> export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
> npm run build:linux
> ```

## 技术栈 Tech Stack

| 组件 | 版本 |
|------|------|
| Electron | 11.5.0 |
| Chromium | 87 |
| Node.js (运行时) | 12.x |
| Flash PPAPI 插件 | 32.0.0.371 (Linux) / 34.0.0.330 (Win64) / 32.0.0.156 (Win32) |
| electron-builder | 22.x |

## 目录结构 Structure

```
BaoFlashBrowser/
├── plugins/                Flash 插件
│   ├── linux64/            libpepflashplayer64.so
│   ├── win64/              pepflashplayer.dll
│   └── win32/              pepflashplayer32_32_0_0_156.dll
├── src/
│   ├── main.js             Electron 主进程
│   └── preload.js          IPC 预加载脚本
├── renderer/
│   ├── index.html          浏览器主界面
│   ├── app.js              工具栏/标签页逻辑
│   ├── style.css           样式
│   └── newtab.html         导航首页
├── build/
│   ├── icon.svg            图标源文件
│   └── make-icon.js        图标生成脚本
└── package.json
```

## License

MIT
