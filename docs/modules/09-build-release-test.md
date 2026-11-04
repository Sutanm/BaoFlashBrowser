# 09 · 构建、发布与测试管线

> 状态：按 **1.1.2（2026-11-02）** 源码核对，取代
> `docs/archive/modules-v1/09-build-release-test.md`。

## 1 范围与目标

项目固定 Electron 11.5.0。主进程由 esbuild 输出 CJS，renderer 由 Vite 输出固定的
`bundle.js`/`bundle.css`，用户脚本与 Web API polyfill 有独立构建步骤。发布命令在打包
前后执行资源、架构与 OCR 校验。

## 2 静态结构

| 路径 | 职责 |
| --- | --- |
| `package.json` | 全部开发、测试与平台构建命令 |
| `esbuild.main.config.mjs` | 主进程、主窗口 preload、BrowserView preload；含原生助手 i18n 插件 |
| `vite.renderer.config.ts` | renderer 构建与固定输出名 |
| `build/module-flags.cjs` | 解析 `BAO_MODULES`，生成 main/renderer 共用编译常量 |
| `build/build-optional-assets.mjs` | 按模块生成 CSS Fixer 与自动化助手文本资产 |
| `build/native-assistant-i18n.mjs` | 编译期把助手中文源码按 `assistant-ui-en.json` 生成英文变体 |
| `scripts/build-*.mjs` | CSS Fixer、自动化助手、Web polyfill 的独立构建 |
| `build/prepare-release.cjs` | 准备隔离的发布元数据 |
| `build/verify-release.cjs` | source/unpacked 两阶段校验：资源、asar、原生架构、大小、SHA-256、OCR |
| `build/prepare-ocr-runtime.cjs` / `prepare-tesseract-runtime.cjs` / `prepare-linux-ocr-bundle.cjs` | 三种 OCR 运行时准备 |
| `build/prepare-esbuild-runtime.cjs` | 从 lockfile 取目标架构 esbuild 并校验 SHA-512 |
| `build/electron-builder.config.cjs` | Windows / Linux / macOS 实验包配置与资源选择 |
| `scripts/smoke-bundles.cjs` | smoke 构件的唯一清单 |
| `scripts/ensure-build.cjs` / `run-smokes.cjs` | 新鲜度保障与串行执行 |
| `.github/workflows/ci.yml` | check + 三平台 package 矩阵 |
| `.github/workflows/package-macos-experimental.yml` | 手动 macOS Intel x64 实验包 |

## 3 构建命令

```bash
npm start          # i18n → 完整 build → Electron
npm run build      # clean → 可选资产 → Web polyfill/main/preloads → renderer
npm run build:full # 显式启用全部模块（默认 build 也是全部）
npm run build:minimal        # 仅 core
npm run build:no-automation  # 除 automation 外的产品模块
npm run build:no-userscripts # 除 userscripts 外的产品模块
npm run dev        # main 与 renderer watch；不自动重启 Electron
npm run i18n       # typesafe-i18n 代码生成
npm run check      # i18n、typecheck、lint、Vitest(unit)、生产 build
```

`BAO_MODULES` 取 `core`、`userscripts`、`automation`、`passwords`、`screenshot`、
`download`、`diagnostics`、`memory-monitor`、`js-patch`。未设置、`default`、`all` 都是
全模块；自定义列表隐式包含 `core`；未知名称直接构建失败。原生助手只要求 `automation`；
CSS Fixer 的文本资产在 `userscripts` 启用时生成。

## 4 平台发布

| 平台 | 命令 | 产物 |
| --- | --- | --- |
| Windows x64 | `build:win64`（= `build:win64:ocr`） | `release/ocr/BaoFlashBrowser-OCR-<v>-x64.exe` + blockmap |
| Windows ia32 | `build:win32`（= `build:win32:ocr`） | `release/ocr/BaoFlashBrowser-OCR-<v>-ia32.exe` + blockmap |
| Linux x64 | `build:linux`（= `build:linux:ocr`） | `release/ocr/BaoFlashBrowser-<v>-x86_64.AppImage` |
| macOS Intel x64（实验） | `build:mac` | `BaoFlashBrowser-Experimental-<v>-x64.dmg/.zip` |

**1.1.2 起三个正式包都带 OCR**，标准（无 OCR）包仍需显式命令：

```bash
npm run build:win64:standard   # --ocr none
npm run build:win32:standard   # --ocr none
npm run build:linux:standard   # --ocr none
```

每个正式命令的流程：生产构建 → `verify:release --stage source` → `prepare:release` →
electron-builder → `verify:release --stage unpacked`。`verify:release` 支持
`--ocr none|bundled`；`bundled` 要求同时启用 `automation`。

OCR 校验的具体内容：

- Win32：`bao-tesseract-ocr-sidecar.exe` 必须是 **ia32 PE**，并读 `OCR-RUNTIME.json`；
- Win64/Linux x64：`bao-paddle-ocr-sidecar.exe` 必须是 x64，`OCR-RUNTIME.json` 的
  `protocol=1 / provider=Paddle Inference / engine=Paddle Inference C++ 2.3.2 CPU MKL /
  model=PP-OCRv3` 必须匹配，并校验 LICENSE、中文词典与 det/rec 模型文件；
- Windows 包内**不得**出现旧版 `PaddleOCR-json.exe`；
- 其他平台/架构声明 bundled OCR 会直接失败。

Win32 OCR 需要 MSVC x86 工具；Linux OCR 首次构建需要 Docker 与 `bsdtar`
（Ubuntu：`libarchive-tools`）。安装用户都不需要这些工具链。

打包前从 lockfile 取目标平台/架构的 esbuild，校验 SHA-512 后复制到
`resources/native/esbuild`；unpacked 校验会检查其原生架构，避免 x64 构建机产出误用
x64 编译器的 Win32 包。`27-packaged-runtime` 探针可在目标架构 Electron 下验证包内 JS
转译与 OpenCV（`BAO_PROBE_PACKAGE_ROOT` 指向 unpacked 目录）。

## 5 CI

- `push` 仅限 `main`，`pull_request` 也运行检查；版本标签不重复触发整套矩阵。
- `check` 在 Windows 与 Ubuntu 分别执行 `npm ci`、`npm run check`、
  `npm run test:integration`、用户脚本/CSS smoke、构建新鲜度探针、BrowserView 兼容
  smoke；Linux 追加 Playwright shell e2e（xvfb）。
- `package` 依赖两个 check 成功，并行构建 `build:win64` / `build:win32` / `build:linux`，
  上传 `release/ocr/` 下的候选制品。
- Win32 打包后额外跑
  `tests/automation-tesseract-sidecar-runtime.integration.test.ts`，验证文字、坐标与
  数字读取，而不是只看文件存在。
- macOS 实验包走独立手动工作流，不进入稳定矩阵。

## 6 测试分层与 smoke 新鲜度

- 单元层：`npm test -- --run`（`unit` project，排除 OpenCV/OCR 重型件）。
- 重型层：`npm run test:integration`（vision-worker、Paddle/Tesseract sidecar）。
- 全量：`npm run test:all`；覆盖率：`npm run test:coverage`（v8，报告在系统临时目录）。
- 外壳 e2e：`npm run test:e2e`（Playwright 驱动项目 Electron 11，只断言 React 外壳；
  BrowserView 内容不可达）。
- Electron smoke：`test:electron` / `test:ruffle` / `test:compat` /
  `test:userscripts` / `test:userscripts-admin` / `test:css-fixer`，汇总 `test:smokes`。
- 探针：`npm run probe`、`npm run probe:deep`、8 个 `probe:automation-*`。

`npm run build` **不重建** `release/tests/` 的 smoke 构件。清单是
`scripts/smoke-bundles.cjs`，共 6 项：userscripts-admin、userscript-runtime、
userscript-runtime-smoke、compatibility、automation-authoring、automation-js-sandbox。
陈旧判断用 `SMOKE_SOURCES` 目录树的最新 mtime，而不是逐构件维护源码列表。
`ensure:smoke-bundles` 被所有 smoke 命令前置调用；`run-smokes.cjs` 遇到陈旧构件直接
拒绝启动；`00-build` 探针也报告新鲜度。

## 7 雷区

1. 不升级 Electron；PPAPI、Chromium 87 行为与全部兼容层依赖该版本。
2. smoke 必须固定临时 userData，并 mock 文档启动时查询的全部 preload IPC。
3. Linux Electron smoke 使用 `--no-sandbox` 与 xvfb；AppImage 应在 Linux/WSL 或 CI 构建。
4. 不以"存在安装包"作为成功标准；必须通过 unpacked 校验并记录大小/SHA-256。
5. 发布时只提交明确的源码与文档，不把 `release/tests/`、IDE 状态或本地产物混入提交。
6. `verify:release --ocr bundled` 与 `BAO_MODULES` 必须一致：裁剪掉 automation 却声明
   捆绑 OCR 会直接失败。
7. 新增 smoke 构件只改 `scripts/smoke-bundles.cjs`，不要在各文档里再抄一份路径表。
