# BaoFlashBrowser

> 基于 Electron 11.5.0（Chromium 87）的 Flash 游戏浏览器，在新版本 Windows 和 Linux 上继续运行 PPAPI Flash 内容。

[中文](README.md) **|** [English](README_EN.md)

[![CI](https://github.com/Sutanm/BaoFlashBrowser/actions/workflows/ci.yml/badge.svg)](https://github.com/Sutanm/BaoFlashBrowser/actions/workflows/ci.yml)
[![Electron](https://img.shields.io/badge/Electron-11.5.0-47848f)](https://www.electronjs.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux-blue)](#平台支持)
[![License](https://img.shields.io/badge/Source-MIT-green)](LICENSE)

Adobe Flash Player 已停止维护，现代浏览器也已移除 PPAPI。BaoFlashBrowser 固定使用最后支持 PPAPI 的 Chromium 87，并通过独立 BrowserView 标签页、Ruffle 后备引擎和旧游戏站点兼容处理，提供尽可能接近传统浏览器的 Flash 游戏体验。

## 下载

- [GitHub Releases](https://github.com/Sutanm/BaoFlashBrowser/releases)
- [Gitee Releases](https://gitee.com/sutanm/BaoFlashBrowser/releases)
- [v1.1.0 发行说明](RELEASE_NOTES.md)

Windows 安装包当前**未进行代码签名**，安装或首次运行时可能出现 Microsoft Defender SmartScreen 的“未知发布者”提示。请只从项目 Release 页面下载，并核对页面公布的 SHA-256。

## 平台支持

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| Windows x64 | 主要支持 | 推荐使用，包含 PPAPI、aria2 和鼠标缩放钩子 |
| Windows ia32 | 未完全测试 | 包含匹配的 32 位 PPAPI 与 aria2 |
| Linux x64 | 有限支持 | 推荐从源码运行；AppImage 可能受发行版、FUSE、动态库及 X11/Wayland 影响 |
| Linux x86 / macOS | 不支持 | 缺少完整的 PPAPI 和原生资源支持链 |

## 核心功能

- 每个标签页使用独立 BrowserView，单个 Flash 页面崩溃不会拖垮全部标签。
- PPAPI 与 Ruffle 可按标签页切换；Ruffle 支持内置资源和 CDN `latest` 后备来源。
- 针对淘米、4399、7k7k 等旧游戏站点处理 Flash 版本检测、SWFObject 和登录跳转兼容问题。
- 支持标签管理、地址导航、缩放、静音、全屏、查找、历史记录和收藏夹。
- Chromium 与 aria2 双下载引擎，支持暂停、恢复、进度显示和安全路径检查。
- 密码本支持可选自动捕获、锁定状态自动填充、排除网站和主密码保护；自动填充不会提交表单。
- 内置用户脚本（userscript）平台：油猴风格管理页、两阶段安装、侧边栏脚本面板与菜单命令、GM API、页面壳增强脚本（含 iframe 子框架支持）。
- 可视化自动化脚本平台：在 `about:automation` 中使用积木或 JSON 搭建 `.baoauto` 脚本，通过图片素材定位并操作网页或 Flash 游戏界面。
- 页面内悬浮自动化助手：无需打开侧边栏即可启动/停止脚本、查看进度、实时比对 UI 素材，并直接框选当前游戏画面制作素材。
- 素材测试台支持在指定场景图中高亮最佳匹配区域；自动化截图、识别和输入支持窗口最小化后继续执行。
- 仅在异常退出后询问是否恢复标签页，正常关闭不会保留待恢复会话。
- 支持中英文界面、明暗主题、Toast 通知和可选标签休眠。

## 从源码运行

需要 Node.js 20 和 npm。Electron 固定为 `11.5.0`，请勿升级。

```bash
git clone https://github.com/Sutanm/BaoFlashBrowser.git
cd BaoFlashBrowser
npm ci
npm start
```

### Linux 依赖

Ubuntu/Debian 可先安装 Electron 11 运行所需的图形、音频和系统库：

```bash
sudo apt install -y libnss3 libgtk-3-0 libx11-xcb1 libxtst6 libxss1 \
  libasound2 libdrm2 libgbm1 libxkbcommon0 libpango-1.0-0 libcairo2 \
  libatk1.0-0 libatk-bridge2.0-0 libcups2 libxcomposite1 libxdamage1 \
  libxfixes3 libxrandr2 libxrender1 libxi6 libnotify4 libsecret-1-0 \
  libpulse0 libdbus-1-3 libaria2-0
```

项目随 Linux 构建提供的 `aria2c` 是动态链接程序，需要系统存在 `libaria2.so.0`；在 Ubuntu/Debian 中由 `libaria2-0` 提供，也可通过安装 `aria2` 自动获得。缺少该库时，程序会尝试系统 `aria2c`，仍不可用则回退到 Chromium 下载引擎。

不同发行版的软件包名称可能不同。Linux 原生 Wayland 下的鼠标缩放钩子可能不可用，X11、XWayland 和 WSLg 的兼容性更好。

## 构建安装包

```bash
npm run check       # 类型检查、Lint、单元测试和构建
npm run build:win64 # Windows x64 NSIS
npm run build:win32 # Windows ia32 NSIS（未完全测试）
npm run build:linux # Linux x64 AppImage，建议在 Linux/WSL 中执行
```

发布脚本会检查 Ruffle、字体、PPAPI、aria2、鼠标钩子和目标架构，校验结果写入 `release/manifests/`。

## 常用快捷键

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl+T` / `Ctrl+W` | 新建 / 关闭标签页 |
| `Ctrl+L` | 聚焦地址栏 |
| `Ctrl+Tab` | 切换标签页 |
| `Ctrl++` / `Ctrl+-` / `Ctrl+0` | 页面缩放 |
| `Ctrl+F` | 页内查找 |
| `F11` / `F12` | 全屏 / 开发者工具 |

## 自动化脚本快速开始

1. 打开侧边栏的“自动化”，进入自动化工作台；也可以直接访问 `about:automation`。
2. 新建脚本，在素材区导入图片，或在目标游戏页展开悬浮球并选择“取材”直接框选 UI。
3. 用入口、图像、输入、页面、流程和调试积木搭建流程，然后保存修改。
4. 在目标游戏页的悬浮助手中选择脚本。识图前提满足后可立即运行或倒数启动，并可随时停止。
5. 动图目标只截取稳定部分；先在“素材测试台”或悬浮助手的“识别”页调整阈值并确认高亮区域。

脚本包扩展名为 `.baoauto`，包含经过校验的工作流 JSON 与图片素材，可在工作台中导入、导出和检查。详细说明见[自动化脚本使用手册](docs/automation-user-guide.md)。

## 安全与限制

Electron 11、Chromium 87 和 Adobe Flash Player 均已停止安全更新。本程序只应访问可信的旧游戏站点和本地内容，不建议用于邮箱、支付、网盘、办公系统或其他敏感业务。能由 Ruffle 正常运行的内容应优先使用 Ruffle。

Windows 实际使用 Flash 29.0.0.171，Linux 使用 32.0.0.371；网站侧的版本声明可能为兼容旧站点而不同。Flash Player 是专有软件，使用者应自行了解所在地区适用的授权与分发要求。

## 开发文档

- [架构与模块手册](docs/architecture-manual.md)
- [用户脚本开发手册](docs/userscript-developer-guide.md)（平台扩展与脚本编写）
- [用户脚本使用手册](docs/userscript-user-guide.md)（安装、管理、FAQ）
- [自动化脚本使用手册](docs/automation-user-guide.md)（工作台、取材、识别、运行与脚本包）
- [发布、打包与成品校验](docs/PACKAGE.md)
- [测试与回归清单](docs/FINAL_REGRESSION.md)
- [故障排查与经验记录](docs/lessons-learned.md)
- [第三方组件与许可证](THIRD_PARTY_NOTICES.md)

## License

BaoFlashBrowser 源代码采用 [MIT License](LICENSE)。安装包中的 Flash Player、Ruffle、aria2 和字体等第三方组件仍受各自许可证和权利声明约束，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
