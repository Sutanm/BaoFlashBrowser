# Third-Party Notices

BaoFlashBrowser 的源代码采用 MIT License。安装包内的第三方组件仍分别受其原始许可证和权利声明约束，MIT License 不覆盖这些组件。

## Ruffle

- 项目：https://ruffle.rs/
- 许可证：MIT OR Apache-2.0
- 安装包中的 Ruffle 发行文件保留其上游许可证文件。

## Source Han Sans CN（思源黑体）

- 项目：https://github.com/adobe-fonts/source-han-sans
- 许可证：SIL Open Font License 1.1
- 随附许可证：`assets/SourceHanSans-LICENSE.txt`

## aria2

- 项目：https://github.com/aria2/aria2
- 当前捆绑版本：1.37.0
- 许可证：GNU General Public License v2.0 or later
- 对应源代码：https://github.com/aria2/aria2/releases/tag/release-1.37.0

## OpenCV.js

- npm 包：`@techstark/opencv-js` 4.12.0-release.1
- 项目：https://github.com/TechStark/opencv-js
- 许可证：Apache License 2.0
- 用途：自动化平台的模板匹配与视觉工作线程。

## Blockly

- npm 包：`blockly` 10.4.3
- 项目：https://developers.google.com/blockly/
- 许可证：Apache License 2.0
- 用途：自动化工作台的可视化积木编辑器。

## Paddle OCR（Windows x64 / Linux x64 正式包）

- 项目：https://github.com/PaddlePaddle/PaddleOCR
- 模型：PP-OCRv3，简体中文、英文和数字，许可证 Apache License 2.0。
- Windows 运行时基于 PaddleOCR-json 1.4.1 的模型和 Paddle Inference 2.3.2，来源：https://github.com/hiroi-sora/PaddleOCR-json 。
- Linux 使用 Paddle Inference C++ 2.6.2，在 manylinux_2_28 基线上构建。
- 项目原生 BAO1 sidecar 负责内存帧传输；运行目录随附上游许可证、说明与元数据。

## Tesseract OCR（Windows ia32 正式包）

- 项目：https://github.com/tesseract-ocr/tesseract
- 版本：5.3.0 x86；上游发行来源与 SHA-256 见 `tools/ocr-tesseract/README.md`。
- 模型：`tesseract-ocr/tessdata_fast` 的 `chi_sim` 与 `eng`，固定提交 `87416418657359cb625c412a48b6e1d6d41c29bd`。
- Tesseract 与模型采用 Apache License 2.0；Leptonica、图像/压缩/网络依赖以及 MinGW/GCC 运行库分别适用各自的许可证与运行库例外。
- 组件依赖清单、原始发行来源、Tesseract 许可证及作者信息随 `native/ocr/THIRD-PARTY-NOTICE.txt` 与 `native/ocr/licenses/` 一同发布。GCC 对应来源：https://gcc.gnu.org/ ，Leptonica 来源：https://github.com/DanBloomberg/leptonica 。
- 原生库仅移除了调试信息，导出表保留；项目 BAO1 sidecar 使用静态 MSVC 运行库，安装用户无需安装编译工具或 .NET。

## fflate

- npm 包：`fflate` 0.8.3
- 项目：https://github.com/101arrowz/fflate
- 许可证：MIT
- 用途：导入和导出 `.baoauto` 脚本包。

## Adobe Flash Player PPAPI

Flash Player 是 Adobe 的专有软件，相关商标、二进制和其他权利归其各自权利人所有。项目内的历史 PPAPI 文件仅用于恢复已停止支持的旧网页内容兼容性；BaoFlashBrowser 与 Adobe 无隶属或认可关系。Adobe 已停止维护 Flash Player，使用者应仅访问可信的旧游戏内容，并自行了解所在地区适用的授权与分发要求。
