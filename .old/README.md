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
```

### ❄️ NixOS

本项目在 NixOS 25.11 + Intel CET 环境中无法原生运行（Electron 11 与 glibc 2.40 / 内核 6.12 不兼容）。推荐使用 `distrobox` 在 Ubuntu 22.04 容器中运行。

#### 一次性环境搭建

```bash
# 1. 创建 Ubuntu 22.04 容器
distrobox create -i ubuntu:22.04 -n cn-apps
distrobox enter cn-apps

# 2. 在容器内安装系统依赖
sudo apt-get update
sudo apt-get install -y nodejs npm libnss3 libgtk-3-0 libx11-xcb1 libxtst6 \
  libxss1 libasound2 libdrm2 libgbm1 libxkbcommon0 libpango-1.0-0 libcairo2 \
  libatk1.0-0 libatk-bridge2.0-0 libcups2 libxcomposite1 libxdamage1 \
  libxfixes3 libxrandr2 libxrender1 libxi6 libnotify4 libsecret-1-0 \
  libpulse0 libdbus-1-3 libexpat1 libuuid1 libxcb1 fontconfig libfreetype6

# 3. 安装 npm 依赖
cd ~/java_workspace/BaoFlashBrowser
npm install --ignore-scripts
printf electron > node_modules/electron/path.txt

# 4. 下载 Electron 11.5.0 二进制
wget https://mirrors.huaweicloud.com/electron/v11.5.0/electron-v11.5.0-linux-x64.zip
unzip -o electron-v11.5.0-linux-x64.zip -d node_modules/electron/dist/
```

#### 日常启动

```bash
./run.sh start
```

`run.sh` 会自动通过 distrobox 容器启动应用，无需手动进入容器。

.desktop 文件已生成到 `~/.local/share/applications/baoflash-browser.desktop`，可在应用菜单中搜索 "BaoFlashBrowser"。

## 打包 Build

```bash
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
├── plugins/
│   ├── linux64/libpepflashplayer64.so
│   ├── win64/pepflashplayer.dll
│   └── win32/pepflashplayer32_32_0_0_156.dll
├── src/
│   ├── main.js
│   └── preload.js
├── renderer/
│   ├── index.html
│   ├── app.js
│   ├── style.css
│   └── newtab.html
├── build/
│   ├── icon.svg
│   └── make-icon.js
├── run.sh
├── shell.nix
└── package.json
```

## License

MIT

ps：淘米自家微端用的flash才26版本，甚至不是最后一个32版本，还检测版本必须大于32，逼着用户去搞国产浏览器。百田用的31版本也没说有flash检测层要求版本大于32。我还奇怪怎么1.0.0版本在linux玩不了淘米游戏，兜了一大圈发现版本伪装没生效。1.0.0就不修复了，感兴趣的可以自己改js文件修复版本伪装。唉，未来是html的天下了，存活下来的flash页游都慢慢转向html了，可能后续会打包成docker来让这个项目活下来吧。2026/7/15

对了，本项目由OpenCode+surperpowers全力开发，由TRAE负责方案审计和辅助开发，主要使用模型是DeepSeek V4 Pro 和 opencode免费的 MiMo v2.5 Free,多模态主要用来修界面样式，没钱的时候拿免费的顶一顶。几乎可以说是一个vibecoding的产物，本人在开发时除了架构设计技术选型以外，代码层面几乎没有参与，毕竟功力不到家，写的没有AI好，除了特定bug手动修复了一下，打了几个补丁，95%的代码都是AI生成的。

1.0.0版本，也就是.old的，用了3天开发完成，勉强可用，其实用着还挺舒服的，而且我在linux nixos实体机上尝试使用了一段时间，可惜存在上限，比如那个密码本在1.0.0版本就在构思，始终没法实现，还有那个多标签页管理也是个麻烦事，当初开发时只顾着选架构，忘记选技术依赖了，要是chrome内核能再高几个版本就好了，现在有时间，我就重构了一下，努力把这个变成一个可用的浏览器，总构思架构到探讨方案，再到第一个可用的预览版，总共耗时两周，AI太好用了。

其实我有想过CEF框架的，毕竟目前可用的ceflashbrowser就用的这个，可惜我C++功底还不如js呢，读代码都很吃力，其次我最初的需求是跨平台，electron刚好符合跨平台的需求，试了一下做了个demo，确实符合需求，于是就选这个了，可惜版本太老了，又不像java那么兼容，还是稍稍吃力的，尤其是那个破全局快捷键，处处受限，最后还是靠盘外招，上了个hook解决的。

但是我还是希望用CEF的，在我的构思里，其实应该有双核驱动的，一个是chrome最新内核，另一个是现在这个，这样运行现代html5游戏也不会太吃力，可惜electron绑定chrome内核版本，根本实现不了，想让这个项目保持活力，还是很难的，没有特色功能你拿什么跟主流浏览器打啊。CEF就不局限于单个内核，它可以在某方面做到动态切换或者绑定标签页的本领，本来想抄一下ceflash的，但他压根没有标签页，是不是有点偷懒了？也不一定，毕竟他就是为了玩游戏诞生的，也不需要主流浏览器，而我更希望一个不耽误正常使用的flash浏览器，至少在不抢edge活的情况下，把浏览器本职工作做好，别不小心点个下载链接就跳转到外面去了。

另一个想用CEF的点就是那个密码本功能，CEF天然在chrome内核内部，而electron在外面，chrome内核跟个黑箱一样无法干涉，只能曲线救国用debugtool来拦截，完全不符合安全规范啊，而CEF就能做到这一点，可惜了，说到这就不得不吐槽一下7k7k竟然不是表单提交登录，而是GET携带明文参数，不通过fetch和xhr发送请求，害得我查了半天，最后用playwright让AI查出来的，还针对他做了策略处理，而且它登录面板点击登录，登陆成功会执行一次意义不明的刷新，这个刷新也卡了我好久，我用CDP捕获会导致这个刷新不通过，有个请求卡住，卡死这个标签页，然后整个面板都点不了按钮，普通刷新还无效，必须卸载browserview再重载才生效，后来还是主动发送请求来解决的。越古老越强大啊，完全想不到老项目怎么解决的问题。CEF好啊，CEF就没这么吃力了。

其他的也没什么好说的了，就是UI设计是真的尽力了，我实在想不出好办法，为了解决WebView的问题，换成BrowserView这个强制置顶的渲染，没办法搞浮窗，甚至想做一个提示弹窗都做不出来，脑子一闪想到把地址栏翻转来通知，醒目还不占空间，只能这么干了，要是electron30+就没这个烦恼了，可惜11.5只能用这个来解决了。要是不局限于flash支持，我肯定能抄一个带有完整功能界面相似的套壳浏览器。能做类浏览器应用的框架本来也不多，这么一看如果只是简单的浏览页面，electron开发难度居然是最低的那个，可是一旦想上点现代化功能，居然是最难的那个，而且由于electron框架的特殊性，还不支持chrome扩展插件，想装个油猴什么的是想都不要想了，只能自己实现。
2026/8/1

其实老内核也有点好处的，比如上古的jsp项目，运行起来比chrome新内核快多了，显示的也不错。