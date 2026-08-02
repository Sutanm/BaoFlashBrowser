# 发布与安装包校验

项目固定使用 Electron 11.5.0。发布脚本不会升级 Electron，也不会从 `package.json` 的 `latest` 标签解析内核版本。

## 构建命令

| 目标 | 命令 | 随包资源 |
| --- | --- | --- |
| Windows x64 | `npm run build:win64` | win64 PPAPI、x64 aria2、Windows mouse hook |
| Windows ia32 | `npm run build:win32` | win32 PPAPI、Windows mouse hook |
| Linux x64 | `npm run build:linux` | linux64 PPAPI、x64 aria2、Linux mouse hook |

Windows ia32 没有捆绑 aria2，因为仓库中现有的 `aria2c.exe` 是 x64。该版本会使用 Chromium 下载后备通道，避免启动不兼容的二进制。

每条发布命令依次执行：

1. 删除旧 `dist` 并重新构建主进程、两个 preload 和 renderer。
2. 校验 Ruffle 脚本、核心 chunk、WASM、字体以及目标平台原生二进制架构。
3. 仅复制目标平台需要的 PPAPI、aria2 和 mouse hook。
4. 生成 NSIS 或 AppImage。
5. 检查解包目录中的 `app.asar`、运行时依赖、原生资源与主程序架构。
6. 将文件大小和 SHA-256 写入 `release/manifests/`。

任何一步失败都会令命令返回非零状态，不会把不完整产物当作成功发布。

## 输出

- Windows 安装包：`release/BaoFlashBrowser-<version>-<arch>.exe`
- Linux 安装包：`release/BaoFlashBrowser-<version>-x86_64.AppImage`
- 解包目录：`release/*-unpacked/`
- 校验清单：`release/manifests/<platform>-<arch>-<stage>.json`

## 平台注意事项

- AppImage 应在 Linux 或 CI 的 Ubuntu runner 上构建。Windows 默认没有创建 AppImage 内部符号链接所需的权限，即使 Linux 解包目录已经生成，也可能在最后一步失败。
- Linux 辅助程序会在打包前后显式设置可执行权限，避免 Git 在 Windows checkout 中丢失执行位。
- 打包器读取隔离的应用文件清单，不扫描整个工作区；临时目录、IDE 文件或异常目录名不会混入安装包。
- `@ruffle-rs/ruffle` 是构建期依赖，成品只包含复制到 `dist/lib/ruffle` 的运行时文件，不会重复打包完整 npm 模块。

## 单独校验

已经完成普通构建后，可以检查某个目标的源资源：

```powershell
npm run verify:release -- --stage source --platform win32 --arch x64
```

已经生成解包目录和安装包后，可以检查成品：

```powershell
npm run verify:release -- --stage unpacked --platform win32 --arch x64
```

CI 会在 Windows 上构建并校验 x64/ia32，在 Ubuntu 上构建并校验 Linux x64。
