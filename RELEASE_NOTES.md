# BaoFlashBrowser v1.1.1 正式版

BaoFlashBrowser 1.1.1 在 1.1.0 自动化平台基础上补齐实验性 Flash/macOS 打包、`.baoauto` ZIP 导入导出，并修复积木/JSON 同步及自动化完成提示的状态问题。Electron 继续固定为 11.5.0 / Chromium 87。

## 下载

| 平台 | 安装包 | 支持状态 |
| --- | --- | --- |
| Windows x64 | `BaoFlashBrowser-1.1.1-x64.exe` | 主要支持 |
| Windows ia32 | `BaoFlashBrowser-1.1.1-ia32.exe` | 未完全测试 |
| Linux x64 | `BaoFlashBrowser-1.1.1-x86_64.AppImage` | 有限支持 |

正式安装包见 [GitHub v1.1.1 Release](https://github.com/Sutanm/BaoFlashBrowser/releases/tag/v1.1.1)。Windows 安装包未进行代码签名，首次运行时可能出现 Microsoft Defender SmartScreen 的“未知发布者”提示。

## 文件校验

| 文件 | 大小 | SHA-256 |
| --- | ---: | --- |
| `BaoFlashBrowser-1.1.1-x64.exe` | 95,408,809 字节 | `36688A2063EACEED9640F1DB4B24DECCBD8A789162D6E5077D12844683DC91FA` |
| `BaoFlashBrowser-1.1.1-ia32.exe` | 82,107,998 字节 | `62DB22A69C9D0DD0EC7E5CA2F7E51885969FF4476B60F6B9EBE5405A8AEF9F35` |
| `BaoFlashBrowser-1.1.1-x86_64.AppImage` | 118,412,753 字节 | `903DE0465230F2BA44228F8DA4668C83ECA1E9C947119E8791608A84524C54F9` |

## 1.1.1 更新

- 新增稳定/实验 Flash 插件通道。Windows x64 实验通道可加载随包提供的国内修改版 PPAPI Flash 34.0.0.380；稳定通道保持原插件不变。
- 新增 macOS Intel x64 实验 DMG/ZIP 打包链，一体化捆绑 PPAPI 插件；该平台尚未经过真实 Mac 硬件测试，不属于稳定支持范围。
- 自动化脚本支持标准 `.baoauto` ZIP 包导入和导出，继续执行 manifest、工作流、素材路径、文件数量和解压体积校验。
- 发布版默认启用自动化平台。
- 修复切换脚本后再切回时 Blockly 工作区丢失、积木内容与 JSON 不一致的问题。脚本切换前会提交当前编辑器状态，重新选择时按该脚本已保存的工作流恢复。
- 修复历史“已完成”状态在新页面初始化时反复弹出“自动化脚本执行完成”的问题；只有实际观察到 `running → completed` 状态转换才提示一次。
- CI 的用户脚本管理冒烟改为等待真实页面状态，不再依赖固定延时；版本标签推送不再重复触发整套构建矩阵。

## 1.1.0 功能基线

- 可视化自动化工作台：Scratch 风格积木与 JSON 双编辑、脚本库、素材管理和 `.baoauto` 包。
- BrowserView 截图 + OpenCV 模板匹配，支持最小化运行、可信鼠标/键盘输入、点击前复核、条件和循环。
- 素材测试台、页面内悬浮助手、框选取材、图片组和透明遮罩匹配。
- 油猴风格用户脚本平台，包含受控 GM API、`@background`、只读 `GM_cookie`、仅观测 `GM_webRequest`，以及内置 CSS 修复器。
- 中英文界面、PPAPI/Ruffle 双引擎、密码保险库、下载、会话恢复和诊断能力。

完整使用方法见 [`docs/automation-user-guide.md`](docs/automation-user-guide.md)，实验平台边界见 [`docs/experimental-platform-support.md`](docs/experimental-platform-support.md)。

## 验证状态

- 2026-08-23 GitHub CI 在 Windows 与 Ubuntu 完成 `npm run check`、用户脚本/CSS 冒烟和 BrowserView 兼容性冒烟。
- Windows x64、Windows ia32 与 Linux x64 三个 CI 打包任务全部通过并上传候选制品。
- 本地 Vitest：74 个测试文件、464 项测试通过。
- PPAPI 自动化仍需在真实游戏上保留人工发布门；macOS 实验包构建成功不代表 Flash 已在真实 Mac 上可用。

## 安全提示

Electron 11、Chromium 87 和 Adobe Flash Player 均已停止安全更新。本程序只应用于可信旧游戏站点和本地内容，不建议用于邮箱、支付、网盘、办公系统或其他敏感业务。内容兼容时优先使用 Ruffle。

项目源代码采用 MIT License；Flash Player、Ruffle、aria2、OpenCV、Blockly 和字体等第三方组件仍受各自许可证约束，详见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
