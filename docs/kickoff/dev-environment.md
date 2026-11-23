# 开发环境搭建（换机器 / 新成员）

本项目用**自编译内核**（Electron 39.8.10 / Chromium 142.0.7444.265），内核产物不在仓库里
（`.gitignore` 忽略 `app/.runtime/`）。所以"新机器能不能马上干活"的关键只有一件事：
**把内核运行时拿到本地并校验来路**。

- 快路径（拷贝运行时）：**约 30 分钟**
- 慢路径（自己重建内核）：**数小时 + 约 100 GB 磁盘**，见 §5

---

## 1. 需要什么

| 项 | 要求 | 实测 |
| --- | --- | --- |
| 操作系统 | Windows x64（内核产物是 win-x64） | Windows 10/11 |
| Node.js | `^22.12.0 \|\| ^24.0.0`（见 `app/package.json` 的 `engines`） | v24.18.0 |
| npm | 随 Node | 11.16.0 |
| git | — | — |
| 磁盘 | 仓库 + `node_modules` ≈ 1 GB；运行时 **436 MB** | — |
| PPAPI 插件（可选） | 30 MB，BYOP 自备 | 29.0.0.171 |

只有"自己重建内核"才需要 Visual Studio BuildTools、depot_tools 与 ~100 GB 空间。

---

## 2. 快路径：拷贝运行时（推荐）

```powershell
git clone <repo>
cd BaoFlashBrowserNext\app
npm ci
```

然后二选一拿到运行时：

**A. 从内部归档导入**（最省事，推荐）

内核运行时按「一种内核 tag = 一个归档」发布，不占仓库体积（`electron.exe` 单个 221 MB，
两家 git 平台都拒）。发送方在**自己的机器**上执行：

```powershell
npm run runtime:export          # internal：含 PPAPI 插件（开发冒烟需要）
npm run runtime:export:byop     # byop：不含 Adobe 二进制，许可最干净
```

产物在 `app/dist/runtime-win-x64-<kernel-tag>-<profile>.zip`（约 150–160 MB），连同脚本打印的
ZIP SHA-256 一起放到**私有 Release / 受限云盘**。接收方：

```powershell
gh release download kernel-bao-v142-265-ppapi-sandbox --pattern 'runtime-win-x64-*.zip'   # 或从云盘下载
npm run runtime:import -- .\runtime-win-x64-bao-v142-265-ppapi-sandbox-internal.zip
npm run runtime:check
```

`runtime:import` **先校验再落盘**：包内 `RUNTIME-MANIFEST.json` 记录了逐文件 SHA-256 与内核
tag，只有与仓库 `scripts/runtime-manifest.json` 期望的内核一致才会安装；不一致会直接报错，
避免"来路不对但静默能用"。已存在的运行时会被移到 `.runtime/win-x64-previous`（`--force` 时）。

两种包的区别：

| 包 | 内含 | 冒烟结果 | 分发限制 |
| --- | --- | --- | --- |
| `internal` | 含 `pepflashplayer64.dll` | **21/21**（PPAPI 用例会跑） | 仅限内部分发（私有 Release / draft / 受限云盘） |
| `byop` | 不含 Adobe 二进制 | 19 通过 + `flash`/`plugin-input` 两条**跳过并说明原因** | 可较自由分发；需要原生引擎时自己放插件 |

**B. 旧机器上还留着内核构建产物**（`dist` 目录）

```powershell
npm run runtime:prepare -- 'D:\electron-build-142\dist'
```

> `runtime:prepare` 在 `app/.runtime/win-x64` 已存在时会**拒绝**执行，避免两套内核混用。
> 换内核前先把旧目录移走（`Move-Item app\.runtime\win-x64 app\.runtime\win-x64-previous`）。

（可选）放插件启用原生引擎：

```powershell
Copy-Item <你的>\pepflashplayer64.dll app\.runtime\win-x64\
```

最后校验并跑冒烟：

```powershell
npm run runtime:check   # 校验内核与插件 SHA-256，失败会给出恢复路径
npm run smoke           # 应用冒烟 21 项
npm run typecheck
```

---

## 3. `npm run runtime:check` 做什么

按 [`app/scripts/runtime-manifest.json`](../../app/scripts/runtime-manifest.json) 逐项校验：

| 检查 | 失败时 |
| --- | --- |
| `.runtime/win-x64/electron.exe` 存在且 SHA-256 匹配 | 硬失败：给出「拷贝」与「重建」两条恢复路径 |
| `vendor/ruffle/*`（随仓库）哈希 | 硬失败：仓库文件被改动 |
| `pepflashplayer64.dll`（可选） | 仅告警：原生引擎停用 / 版本与清单不同 |

成功时输出内核 tag 与体积，并提示下一步跑 `npm run smoke`。

---

## 4. 日常命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | Vite 开发服务器（外壳热更新） |
| `npm run build` | typecheck + 构建 `out/` |
| `npm run smoke` | 应用冒烟（27 项，临时 profile，窗口会出现在屏幕上并获得焦点） |
| `npm run smoke:bg` | 同一套冒烟的后台跑法：窗口移到屏幕外、不激活，边工作边跑不抢前台（`permissions` 的 pointerLock/fullscreen 会跳过并说明原因） |
| `npm run pack:win` | 打内部验证包（带插件，仅供内部） |
| `npm run pack:win:public` | 打公开包（BYOP，不含 Adobe 二进制） |
| `npm run smoke:packaged` | 成品冒烟（按产物 `manifest.json` 判定 profile） |
| `npm run runtime:check` | 本地运行时自检 |
| `npm run runtime:prepare -- <dist>` | 从内核构建输出刷新运行时 |
| `npm run runtime:export` / `runtime:export:byop` | 导出运行时 zip（internal 含插件 / byop 不含 Adobe 二进制） |
| `npm run runtime:import -- <zip>` | 校验后安装运行时 |

---

## 5. 慢路径：自己重建内核

需要 Visual Studio BuildTools、depot_tools、Chromium 源码与 ~100 GB 磁盘；耗时数小时。
补丁与验证记录见 [`docs/kernel/README.md`](../../docs/kernel/README.md)。

```powershell
# 1) 构建（路径按你的 checkout 调整）
cd <cr>\src
$env:DEPOT_TOOLS_WIN_TOOLCHAIN = '0'   # 用本机 VS，不走 CIPD
$env:vs2022_install = 'C:\BuildTools'  # VS 不在默认路径时
$env:SCCACHE_SERVER_PORT = '47999'     # 默认端口可能被 Windows 端口排除段占用
.\third_party\ninja\ninja.exe -C out\Rel electron

# 2) 组装干净 dist（脚本随仓库）
pwsh -NoProfile -File app\scripts\assemble-kernel-dist.ps1 `
  -Out <cr>\src\out\Rel -Dist D:\kernel-dist `
  -Flash <你的>\pepflashplayer64.dll

# 3) 刷新应用运行时并校验
cd app
Move-Item .runtime\win-x64 .runtime\win-x64-previous   # 若已存在
npm run runtime:prepare -- D:\kernel-dist
npm run runtime:check
```

> `assemble-kernel-dist.ps1` 原先只存在于仓库外的临时目录，2026-11-23 随仓库入库，
> 所以新机器不需要再找那份脚本。

换内核后必须同步更新 `app/scripts/runtime-manifest.json` 的 SHA-256 与 tag，否则 `pack:win`
的来源门禁会失败（这是刻意的）。

---

## 6. 已知坑（每台新机器几乎都会踩）

| 坑 | 现象 | 解法 |
| --- | --- | --- |
| `ELECTRON_RUN_AS_NODE=1` | Playwright 报 `Process failed to launch!` | 冒烟脚本内部会删掉；手工启动前先 `Remove-Item Env:\ELECTRON_RUN_AS_NODE` |
| 未设置 `ELECTRON_EXEC_PATH` | electron-builder **静默下载官方 Electron**（210 MB），成品冒烟报 `flash:timeout bridge-unavailable` | `npm run pack:win` 已兜底并校验体积；手工调用 electron-builder 时务必设置 |
| 内核 ninja 报端口被占用 | sccache 启动失败 | `$env:SCCACHE_SERVER_PORT = '47999'` |
| `No supported Visual Studio` | VS 不在默认路径 | `$env:vs2022_install = 'C:\BuildTools'` |
| 插件缺失 | 原生引擎停用，所有标签回落 Ruffle，引擎面板「Flash」档置灰 | 把 `pepflashplayer64.dll` 放到 `app/.runtime/win-x64/`（开发）或 `<exe目录>\flash\`（打包版） |
| 目录改名报「路径或设备名称」 | `Rename-Item` 对某些目录失败 | 改用 `Move-Item` |
| `runtime:prepare` 拒绝执行 | 提示"本地运行时已准备" | 先把旧 `.runtime/win-x64` 移走，这是防混用的保护 |
| 冒烟抢前台 | 每跑一条用例都弹一个窗口抢焦点 | 用 `npm run smoke:bg`（窗口移到屏幕外且不激活）；只有需要 pointerLock/fullscreen 的那条会跳过 |
| 后台模式仍失败在 Ruffle 输入 | 窗口完全不显示时 Ruffle 出帧被节流 | 用 `BAO_SMOKE_BACKGROUND=1`（默认后台档），不要用 `BAO_SMOKE_HIDDEN=1` 跑全量 |

---

## 7. 校验清单（新机器就绪的判定）

```powershell
npm run runtime:check   # ✔ 内核匹配（含 tag）+ ✔ 插件匹配（或明确的告警）
npm run typecheck       # 通过
npm run smoke           # 21/21
npm run pack:win        # 来源校验 5 个文件 + 内核校验通过（可选，验证打包链）
npm run smoke:packaged  # 通过（可选，验证真产物）
```

四项全绿即可认为环境就绪。前两项任何一项失败，先回到 §2 的运行时路径排查。
