# BaoFlashBrowser v1.0.1 正式版

BaoFlashBrowser 是基于 Electron 11.5.0（Chromium 87）、React 18 和 TypeScript 构建的跨平台 Flash 浏览器。1.0.1 由此前的预览版迭代为首个正式版本，继续固定 Electron 11.5.0 以保留原生 PPAPI Flash 支持。

## 下载

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | [BaoFlashBrowser-1.0.1-x64.exe](https://gitee.com/sutanm/BaoFlashBrowser/releases/download/v1.0.1/BaoFlashBrowser-1.0.1-x64.exe) |
| Windows ia32（未完全测试） | [BaoFlashBrowser-1.0.1-ia32.exe](https://gitee.com/sutanm/BaoFlashBrowser/releases/download/v1.0.1/BaoFlashBrowser-1.0.1-ia32.exe) |
| Linux x64（AppImage 可能存在兼容缺陷） | [BaoFlashBrowser-1.0.1-x64.AppImage](https://gitee.com/sutanm/BaoFlashBrowser/releases/download/v1.0.1/BaoFlashBrowser-1.0.1-x64.AppImage) |

正式发布的文件名、大小和 SHA-256 校验值以 GitHub/Gitee Release 页面为准。Windows ia32 已包含匹配的 aria2 1.37.0，但该平台尚未完成充分实机测试。Linux 仅提供 x64，不提供 x86；AppImage 可能受发行版、FUSE、动态库和显示环境影响，建议优先下载源码并使用 Node.js 20 执行 `npm install`、`npm start`。

## 核心能力

- 每个标签页使用独立 BrowserView 渲染进程，单个 Flash 页面崩溃不会拖垮其他标签。
- 原生 PPAPI 与 Ruffle 可按标签切换；Ruffle 支持内置资源和 CDN `latest` 两种来源。
- 针对淘米、4399、7k7k 等旧游戏站点处理 Flash 版本检测、SWFObject、跨域策略和登录跳转兼容问题。
- 支持历史、收藏、下载、标签恢复、页面查找、缩放、静音、全屏和网页右键菜单。
- 正常关闭不会恢复标签；仅异常退出后通过 Toast 询问是否恢复上次标签。

## 密码与隐私

- 密码本支持自动捕获、手动确认保存、自动填充、排除网站和主密码加密。
- 自动填充只填写字段，不自动提交登录表单。
- 密码捕获使用 CDP binding，明文凭据不会经过网页控制台或渲染进程 IPC。
- 历史、崩溃会话和日志会移除账号、令牌、会话等敏感 URL 参数。

## 下载与稳定性

- 支持 Chromium 与 aria2 下载，aria2 使用动态本地端口和随机 RPC 密钥。
- 下载记录支持暂停、恢复、中断恢复和安全路径检查。
- 可选休眠静音且未加载的非活动标签，切回后按原内核、缩放和静音状态恢复。
- BrowserView 替换、刷新、前进和后退均包含旧事件隔离与 CDP 安全卸载。

## 验证状态

- TypeScript 主进程、渲染进程和 preload 类型检查通过。
- ESLint 无错误。
- 48 项 Vitest 单元测试通过。
- BrowserView、Ruffle、Flash Session 兼容冒烟测试通过。
- Windows x64、Windows ia32 和 Linux x64 构建及安装包资源校验由 CI 覆盖；Windows ia32 尚未完成充分实机测试，Linux AppImage 仍可能存在环境兼容缺陷。
- Flash 网站与日常功能已在持续开发游玩中验证，已知问题将在后续维护版本中修复。

## 安全提示

Electron 11、Chromium 87 和 Adobe Flash Player 均已停止安全更新。本程序用于可信的旧游戏站点和本地内容，不建议用于邮箱、支付、网盘、办公系统或其他敏感业务。能由 Ruffle 正常运行的内容，优先使用 Ruffle。

Windows 安装包当前未进行代码签名，安装或首次运行时可能出现 Microsoft Defender SmartScreen 的“未知发布者”提示。请只从项目的 GitHub/Gitee Release 页面下载，并对照发布页公布的 SHA-256 校验值确认文件完整性。

## 第三方组件

项目源代码采用 MIT License；Flash Player、Ruffle、aria2 和字体等第三方组件仍受各自许可证约束，详见 `THIRD_PARTY_NOTICES.md`。
