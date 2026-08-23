# 09 · 构建、发布与测试管线

## 1 范围与目标

项目固定 Electron 11.5.0。主进程由 esbuild 输出 CJS，renderer 由 Vite 输出固定的 `bundle.js`/`bundle.css`，用户脚本与 Web API polyfill 有各自构建步骤。发布命令在打包前后执行资源与架构校验。

## 2 当前结构

| 路径 | 职责 |
| --- | --- |
| `package.json` | 所有开发、测试和平台构建命令 |
| `esbuild.main.config.mjs` | 主进程、主窗口 preload、BrowserView preload 构建 |
| `vite.renderer.config.ts` | renderer 构建与固定输出名 |
| `scripts/build-css-fixer.mjs` | 把内置 CSS 修复器生成到随包源码 |
| `scripts/build-web-polyfills.mjs` | 生成 Chromium 87 Web API polyfill |
| `build/prepare-release.cjs` | 准备隔离的发布元数据 |
| `build/verify-release.cjs` | source/unpacked 资源、asar、原生架构、大小和 SHA-256 清单 |
| `build/electron-builder.config.cjs` | Windows、Linux、macOS 实验包配置与资源选择 |
| `tests/electron/build-*.mjs` | 生成 `release/tests/` 中的 smoke 专用 bundle |
| `scripts/run-smokes.cjs` | 串行执行仓库 Electron smoke，统一超时与临时 userData |
| `.github/workflows/ci.yml` | main/PR 检查及 Win64、Win32、Linux x64 打包 |
| `.github/workflows/package-macos-experimental.yml` | 手动 macOS Intel x64 实验打包 |

## 3 构建命令

```bash
npm start          # i18n → 完整 build → Electron
npm run build      # clean → CSS Fixer → main/preloads → renderer
npm run dev        # main 与 renderer watch；不自动重启 Electron
npm run i18n       # typesafe-i18n 代码生成
npm run check      # i18n、typecheck、lint、Vitest、生产 build
```

`npm run build` 不会生成以下 smoke 专用文件：

- `release/tests/userscripts-admin-module.cjs`
- `release/tests/userscript-runtime-preload.cjs`
- `release/tests/session-compatibility-smoke.cjs`

修改相关源码后必须运行对应 `test:*` 命令，让 `build-*.mjs` 先生成新 bundle。

## 4 平台发布

| 平台 | 命令 | 主要产物 |
| --- | --- | --- |
| Windows x64 | `npm run build:win64` | `BaoFlashBrowser-<version>-x64.exe` + blockmap |
| Windows ia32 | `npm run build:win32` | `BaoFlashBrowser-<version>-ia32.exe` + blockmap |
| Linux x64 | `npm run build:linux` | `BaoFlashBrowser-<version>-x86_64.AppImage` |
| macOS Intel x64（实验） | `npm run build:mac` | `BaoFlashBrowser-Experimental-<version>-x64.dmg/.zip` |

每个正式平台命令执行生产构建、source 校验、发布准备、electron-builder 和 unpacked 校验。`verify-release.cjs` 检查 `dist/main.js`、两个 preload、renderer `bundle.js`/`bundle.css`、Ruffle 核心/WASM/字体以及目标平台原生资源，并把结果写到 `release/manifests/`。

macOS 构建先运行 `prepare:mac-flash`，从仓库 vendor DMG 提取并验证插件；它是实验通道，包结构通过不等于真实硬件通过。

## 5 CI 行为

- `push` 仅限 `main`，`pull_request` 也运行检查；版本标签不会重复触发整套矩阵。
- `check` 在 Windows 和 Ubuntu 分别运行 `npm ci`、`npm run check`、用户脚本/CSS smoke、构建新鲜度探针和 BrowserView 兼容 smoke。
- `package` 依赖两个 check 全部成功，再并行构建 Win64、Win32 和 Linux x64 并上传候选制品。
- macOS 实验包走独立的手动工作流，不进入稳定 CI 矩阵。

## 6 验证矩阵

- 纯逻辑：`npm test -- --run`。
- 类型、Lint、构建：`npm run check`。
- BrowserView/兼容性：`npm run test:electron`、`test:ruffle`、`test:compat`。
- 用户脚本：`npm run test:userscripts`、`test:userscripts-admin`、`test:css-fixer`。
- 汇总 smoke：`npm run test:smokes`。
- 快检与运行时健康：`npm run probe`、`npm run probe:deep`。
- 自动化专项：`probe:automation-m4`、`probe:automation-m5-engines`。

## 7 不变量与雷区

1. 不升级 Electron；PPAPI、Chromium 87 行为和全部兼容层依赖该版本。
2. smoke 必须固定临时 userData，并 mock 文档启动时查询的所有 preload IPC。
3. Linux Electron smoke 使用 `--no-sandbox` 和 xvfb；AppImage 应在 Linux/WSL 或 CI 构建。
4. 不以存在安装包作为成功标准；必须通过 unpacked 校验并记录大小/SHA-256。
5. 发布时只提交明确的源码和文档，不把 `release/tests/`、IDE 状态或本地产物混入提交。
