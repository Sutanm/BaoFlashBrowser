# BaoFlashBrowser v1.1.2 正式版 / Stable release

## 下载 / Downloads

| 平台 / Platform | 安装包 / Package | 离线 OCR / Offline OCR |
| --- | --- | --- |
| Windows x64 | `BaoFlashBrowser-OCR-1.1.2-x64.exe` | Paddle / PP-OCRv3 |
| Windows ia32 | `BaoFlashBrowser-OCR-1.1.2-ia32.exe` | Tesseract 5.3.0 x86 |
| Linux x64 | `BaoFlashBrowser-1.1.2-x86_64.AppImage` | Paddle / PP-OCRv3 |

三个正式包均保留全部功能模块，并内置 OCR 程序、依赖和中英文模型。换电脑后安装对应平台包即可，无需下载源码、另装 OCR 或重新编译。Windows `.blockmap`、`SHA256SUMS-1.1.2.txt` 和成品资源校验清单一同提供。macOS 仍为独立实验通道，不包含在本次正式制品中。

All three packages include every feature module and an offline OCR runtime with Chinese/English models. Moving to another computer requires only the matching package, without source code or rebuilding. Windows blockmaps, SHA-256 checksums and verification manifests are attached. Experimental macOS builds are outside this stable release.

## 主要更新

- 自动化工作台整合 Blockly、JavaScript/TypeScript、共享素材、脚本调用、文字/数字 OCR、页面与游戏画面双坐标体系。
- 原生页面悬浮助手不再依赖启用用户脚本；支持取材、素材匹配、坐标获取、游戏画面绑定、运行控制与状态查看。
- Win32 单独内置原生 Tesseract OCR，返回文字、置信度和矩形坐标；Win64/Linux 继续使用 Paddle。Win32 对低分辨率、描边游戏字的效果较弱，详见仓库中的 OCR 对比报告。
- 完善中英文界面、英文自动化文档、浮窗助手实时语言切换、积木校验提示和原生导入对话框；首次启动提供语言选择。
- 加入全局代理配置与连接诊断，aria2 下载路由跟随代理，并统一下载目录设置。
- 浏览器主题同步到原生网页内容；修复新标签页搜索焦点布局，Bing 搜索入口统一为 `www.bing.com`。
- 增加手动稳定版更新检查，改善 Chromium 87 上的现代 JS/CSS 和 GitHub 页面兼容性。
- 修复设置保存、数据迁移保留、密码捕获重新启用和后台自动化输入时序问题。
- 加强目标架构、运行时 esbuild、OCR 模型/动态库和成品 SHA-256 校验；默认构建及 CI 输出三个全模块、内置 OCR 的包。

## Highlights

- Unified Blockly and JavaScript/TypeScript automation with shared assets, script calls, offline text/number OCR and game-area coordinates.
- Native floating assistant for capture, recognition, game-area binding and run control, independent of userscript enablement.
- Native x86 Tesseract OCR for Win32; Paddle remains the engine on Win64 and Linux. Small outlined pixel text is a weak case for Win32 OCR.
- More complete Chinese/English UI, English automation documentation, live assistant language switching and localized import dialogs.
- Global proxy settings and connection diagnostics, synchronized aria2 proxy routes, unified download folders, native webpage theme synchronization and manual stable-update checks.
- Improved Chromium 87 compatibility, search-focus layout, settings persistence, migration recovery, password capture and background input timing.
- Target-specific esbuild binaries and stricter native/OCR package verification.

## 验证与兼容性 / Validation and compatibility

- Electron 固定为 **11.5.0 / Chromium 87**，保留 PPAPI Flash 支持。
- Win32 已在 32 位 Electron 中验证 OCR、文字坐标、数字读取、esbuild 和 OpenCV；尚未经过真实 32 位 Windows 系统测试。
- Linux AppImage 已在 WSL/Linux 构建与校验，OCR 推理库的 glibc 要求不高于 2.28；FUSE、图形系统库和 X11/Wayland 兼容性仍取决于发行版。
- 类型、Lint、单元/集成测试、Electron 冒烟与界面回归，以及打包前后的资源校验均纳入本次发布验证。

Electron remains fixed at **11.5.0 / Chromium 87** for PPAPI Flash. Win32 was tested in 32-bit Electron, not on a physical 32-bit OS. Linux graphics/FUSE dependencies remain distribution-specific. Package creation does not imply macOS hardware validation.

Windows 安装包未签名。请从本项目 Release 下载并核对 SHA-256。Electron 11、Chromium 87 和 Flash 已停止安全更新，请仅访问可信的旧游戏站点与本地内容，内容兼容时优先使用 Ruffle。

Windows installers are unsigned. Verify the attached SHA-256 checksums. Electron 11, Chromium 87 and Flash no longer receive security updates; use trusted legacy content and prefer Ruffle where compatible.

项目源码采用 MIT License，第三方组件分别适用其原始许可证，见 `THIRD_PARTY_NOTICES.md`。
