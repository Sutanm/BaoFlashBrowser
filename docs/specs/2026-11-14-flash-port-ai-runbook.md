# Flash 接入复现手册（AI 读者版）

> 目标读者：**另一个 AI 代理**，在**另一台电脑**上，从零复现"自建 Electron 单内核 + 原生 PPAPI Flash"。
> 本文是**可执行 runbook**：每一步都给出命令、判定标准和已知失败模式。
> 配套背景文档：[`2026-11-14-electron138-flash-port.md`](2026-11-14-electron138-flash-port.md)（历程）、[`2026-11-11-qax-chromium102-flash.md`](https://github.com/Sutanm/BaoFlashBrowser/blob/8973e6a5740d0bd0252d1948aec9e4f8ac37eda2/docs/specs/2026-11-11-qax-chromium102-flash.md)（前期调研）。

---

## 0. 给 AI 的执行约定

1. **按阶段顺序执行**，不要跳步；每个阶段末尾都有"✅ 判定"，未通过不要进入下一阶段。
2. **每个命令行都要先看退出码**；Windows 上被强杀会表现为 `exit code 1` 但没有错误输出，重跑即可。
3. **改文件前先读文件**；本文给出的补丁都是"精确字符串替换"，替换前先 `Select-String`/`grep` 确认原文存在。
4. **不要用命令行正则批量杀进程**：`Get-CimInstance Win32_Process | Where CommandLine -match ... | Stop-Process` 会匹配到你自己所在的 shell（真实事故：曾杀掉宿主桌面端）。只按 PID 终止。
5. 遇到报错先查 **§12 错误字典**；字典里没有的，按"根因分层"排查：配置（gn args）→ 缺失文件（hook）→ 代码漂移（87 vs 当前版本）。
6. 本文中的版本号是**已验证组合**：Electron `v37.0.0` + Chromium `138.0.7204.35` + Node `v22.16.0`。不要自行升级。

---

## 1. 目标与验收标准

最终目标：Electron 单内核进程里，Web 页面上的 Flash（`<embed type="application/x-shockwave-flash">`）能**创建实例并渲染帧**。

分阶段验收（每阶段独立可验证）：

| 阶段 | 验收标志 | 验证方式 |
| --- | --- | --- |
| B 源码 | `src` 是 Chromium 138、`src/electron` 是 v37.0.0 | `git describe --tags` |
| C 依赖 | `src/third_party/v8`、`src/buildtools/win/gn.exe`、`src/third_party/ninja/ninja.exe` 存在 | `Test-Path` |
| D 构建 | `out/Testing/electron.exe` 存在且 `--version` 输出 `v37.0.0` | 运行 exe |
| E PPAPI 编入 | exe 中含 `PpapiPluginProcessHost`、`ppapi plugin process` 字符串 | 字符串扫描（§7.1） |
| F 插件注册 | 进程列表出现 `--type=ppapi` 子进程 | 运行测试页（§7.2） |
| G Flash 加载 | trace 出现 `OnLoadPlugin: got get_interface` | trace 文件（§7.3） |
| H 初始化 | trace 出现 `OnLoadPlugin: init OK` | 同上 |
| I 出帧 | 测试页截图出现**真实 SWF 内容**（用游戏 SWF 验证，三态摘要＞1） | 测试页 report + 截图 |

> **实测结论（2026-11-14 23:45）**：完成阶段 H 后，Flash 已经 `init OK` 并能渲染真实 SWF（FlxInvaders 游戏画面），**I 达成**。
> Phase 2/3（渲染/浏览器宿主）不再是出帧前提，只影响剪贴板/代理/导航/全屏/LSO 等外围功能。

---

## 2. 前置条件

| 项 | 要求 | 检查命令 |
| --- | --- | --- |
| OS | Windows 10/11 x64 | `[Environment]::OSVersion` |
| 内存 | ≥ 32 GB（16 并发编译需要 ~25 GB 峰值） | `(Get-CimInstance Win32_OperatingSystem).TotalVisibleMemorySize/1MB` |
| 磁盘 | ≥ 150 GB 空闲（源码 20 GB + 缓存 15 GB + out 30 GB + 工具链 10 GB） | `Get-PSDrive D` |
| CPU | ≥ 8 核（推荐 16+） | `(Get-CimInstance Win32_Processor).NumberOfLogicalProcessors` |
| Visual Studio | VS 2022 Build Tools 17.9+（含 MSVC x64 + Windows SDK 10.0.26100 + **ATL**） | `& "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe" -products * -all` |
| Python | 3.11（Chromium 脚本要求），且 PATH 里必须有 `python3.exe` | `python3 --version` |
| 网络 | 能访问 `chromium.googlesource.com` / `github.com` / `storage.googleapis.com`（中国大陆需代理） | `curl -s -o NUL -w "%{http_code}" https://chromium.googlesource.com` |
| 工具 | `git`、`aria2c`（可选，下载加速）、`depot_tools` | `git --version` |

### 2.1 安装 VS Build Tools 组件（ATL 必须）

Chromium 的 `base/win/atl_throw.cc` 需要 ATL：

```powershell
# 已安装 Build Tools 时补装 ATL（需要管理员，会弹 UAC）
$inst = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vs_installer.exe'
Start-Process $inst -Verb RunAs -ArgumentList @(
  'modify','--installPath','C:\BuildTools',
  '--add','Microsoft.VisualStudio.Component.VC.ATL',
  '--passive','--norestart'
)
# 验证
Get-ChildItem 'C:\BuildTools\VC\Tools\MSVC\*\atlmfc\include\atldef.h'
```

> 备注：`--quiet` 在该安装器版本会返回 87（参数错误），用 `--passive`。

### 2.2 Python 3.11 的 `python3.exe`

Windows 官方安装包只提供 `python.exe`，而 Chromium 脚本调用 `python3`。复制一份即可：

```powershell
$py = 'C:\Users\<user>\AppData\Local\Programs\Python\Python311'
Copy-Item "$py\python.exe" "$py\python3.exe" -Force
# 并把 $py 放到 PATH 最前面（临时会话）
$env:PATH = "$py;$py\Scripts;" + $env:PATH
python3 --version   # 必须输出 3.11.x
```

> 注意：Windows 商店的 `WindowsApps\python3.exe` 是占位符，会报 "Python was not found"，必须让 3.11 排在它前面。

### 2.3 depot_tools

```powershell
git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git D:\depot_tools
$env:PATH = "D:\depot_tools;" + $env:PATH
# 首次运行会 bootstrap（需要能访问 CIPD/GCS）
cmd /c "D:\depot_tools\gclient.bat --version"
```

✅ 判定：`D:\depot_tools\.cipd_bin` 非空，`gclient.bat --version` 正常输出。

---

## 3. 阶段 A：目录与工作副本规划

```
D:\electron-build\cr\          ← gclient 根（.gclient 所在）
  src\                        ← Chromium 源码
    electron\                 ← Electron 源码（solution）
  out\Testing\                ← 构建输出
D:\git_cache\                 ← git 缓存（可选，加速）
D:\depot_tools\               ← depot_tools
```

```powershell
New-Item -ItemType Directory -Force D:\electron-build\cr | Out-Null
cd D:\electron-build\cr
$env:DEPOT_TOOLS_WIN_TOOLCHAIN = '0'      # 使用本机 VS，不下载 Google 内部工具链
cmd /c "D:\depot_tools\gclient.bat config --name `"src/electron`" --unmanaged https://github.com/electron/electron"
```

生成的 `D:\electron-build\cr\.gclient` 应包含：

```
solutions = [
  { "name": "src/electron",
    "url": "https://github.com/electron/electron",
    "deps_file": "DEPS",
    "managed": False, ... }
]
```

---

## 4. 阶段 B：获取 Chromium 源码（三选一）

### B1（推荐，已验证）：官方 git-cache 对象 + aria2 多连接

Chromium 官方把一个提交的 git 缓存拆成对象放在 GCS：

- 桶：`chromium-git-cache`
- 前缀：`v2/chromium.googlesource.com-chromium-src/<snapshot-id>/`
- 每个对象 = `objects/pack/*.pack` 或 `refs/*` 等

先用 GCS JSON API 列对象：

```powershell
$prefix = 'v2/chromium.googlesource.com-chromium-src/<snapshot>/'
$url = 'https://storage.googleapis.com/storage/v1/b/chromium-git-cache/o?prefix=' + [uri]::EscapeDataString($prefix) + '&maxResults=1000'
(Invoke-WebRequest -UseBasicParsing $url).Content | ConvertFrom-Json | Select-Object -ExpandProperty items |
  Select-Object name, size
```

生成 aria2 输入文件（每行 `URL` + `dir=`），用多连接下载：

```powershell
aria2c -i aria-input.txt -j 8 -x 16 -s 16 -k 1M --min-split-size=1M `
       --file-allocation=none --continue=true --max-tries=0 --retry-wait=2 `
       --all-proxy=http://127.0.0.1:10808     # 走代理；直连也可
```

> 关键经验：
> - 单连接会被限到 ~500 KB/s；`-x 16 -s 16` 可到 3–7 MB/s；
> - **限速按出口 IP 配额**，换节点/换 IP（或代理↔直连切换）能重置；
> - 断点续传靠 `*.aria2` 控制文件，**不要删缓存目录**；
> - 完成后逐个对象比对 `size`（GCS 列出的 size），必须 46/46 一致。

✅ 判定：所有对象尺寸与桶列表一致，且目录内无 `*.aria2` 残留。

### B2（已下载过缓存时）：复用本地 bare 仓库

如果已有一个 **bare** 的 `chromium.googlesource.com-chromium-src` 缓存目录（含 `objects/HEAD/config/packed-refs`），只需把它放到工作树能访问的位置，并用 **git alternates** 共享对象（见 §5.2）。

### B3（网络好时）：浅克隆

```powershell
git clone --filter=blob:none --no-checkout --depth 1 --branch 138.0.7204.35 https://github.com/chromium/chromium.git src
```

> `--depth 1` 无法后续切版本；仅适合"只做 138"的一次性验证。

---

## 5. 阶段 C：切到 Electron 37 / Chromium 138 并同步依赖

### 5.1 取 Electron 源码并切标签

```powershell
cd D:\electron-build\cr
git clone https://github.com/electron/electron src\electron
git -C src\electron checkout v37.0.0
# 验证 DEPS 里的版本
Select-String -Path src\electron\DEPS -Pattern "chromium_version|node_version"
# 期望：chromium_version='138.0.7204.35'  node_version='v22.16.0'
```

### 5.2 让工作树与缓存共享对象（避免 14 GB 重下）

在 `src/.git/objects/info/alternates` 写入缓存的对象目录（**ASCII、LF 结尾、无 BOM**）：

```powershell
$dst = 'D:\git_cache\chromium.googlesource.com-chromium-src\objects'
[System.IO.File]::WriteAllText('D:\electron-build\cr\src\.git\objects\info\alternates',
  $dst + "`n", (New-Object System.Text.ASCIIEncoding))
# 验证
git -C D:\electron-build\cr\src cat-file -e '138.0.7204.35:DEPS'; "exit=$LASTEXITCODE"
```

> 不写 alternates 的后果：`gclient sync` 会用本地传输重新 `pack-objects` 14 GB，吃 7 GB 内存、跑十几分钟。

### 5.3 gclient sync

```powershell
cd D:\electron-build\cr
$env:HTTP_PROXY='http://127.0.0.1:10808'; $env:HTTPS_PROXY=$env:HTTP_PROXY
$env:http_proxy=$env:HTTP_PROXY; $env:https_proxy=$env:HTTPS_PROXY
$env:DEPOT_TOOLS_WIN_TOOLCHAIN='0'; $env:GIT_CACHE_PATH='D:\git_cache'
cmd /c "set GIT_TERMINAL_PROMPT=0&& D:\depot_tools\gclient.bat sync --nohooks --jobs 8 -v > D:\electron-build\sync.log 2>&1"
```

判定：日志末尾无 `ERROR`，`src/third_party/v8`、`src/third_party/pdfium`、`src/buildtools/win/gn.exe`、`src/third_party/ninja/ninja.exe` 均存在。

---

## 6. 阶段 D：hooks 补齐（Electron 方案不跑 Chromium 的 hooks）

`gclient runhooks` 在 Electron 方案下只跑 Electron 自己的 hooks；Chromium 的生成文件/hook 需要**手动补**。

### 6.1 跑 Electron hooks（会应用 patch、装 node_modules）

```powershell
cmd /c "D:\depot_tools\gclient.bat runhooks -v > D:\electron-build\hooks.log 2>&1"
```

#### 已知失败 1：dugite 内嵌 Git 下载被墙

症状：`error D:\...\node_modules\dugite: Command failed ... ECONNRESET`

原因：dugite 的 postinstall 用 Node `https.get` **不走代理**。

修复（先手动把 tarball 放到 dugite 缓存目录，它会校验 sha256 后直接解压）：

```powershell
# 1) 读 url 与 checksum
$json = Get-Content src\electron\node_modules\dugite\script\embedded-git.json -Raw | ConvertFrom-Json
$e = $json.'win32-x64'
# 2) 走代理下载到 %TEMP%\<fileName>
$tmp = Join-Path $env:TEMP (($e.url -split '/')[-1])
curl.exe -L --fail --ssl-no-revoke --retry 5 --proxy http://127.0.0.1:10808 -o $tmp $e.url
(Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower() -eq $e.checksum.ToLower()   # 必须 True
# 3) 手动执行 postinstall（会解压到 node_modules/dugite/git）
cd src\electron\node_modules\dugite; node .\script\download-git.js
# 4) 重跑 yarn（几秒完成）
cd src\electron; npx.cmd yarn@1.15.2 install --frozen-lockfile
```

#### 已知失败 2：二次 `runhooks` 报 `git am ... returned 128`

原因：patch 已应用，`git am` 不能再打。

修复：

```powershell
git -C src am --abort   # 若存在 .git/rebase-apply
```

> 教训：**hooks 只跑一次**；需要补生成文件时手动执行对应脚本，不要重跑整个 `runhooks`。

### 6.2 手动补 Chromium 生成文件

```powershell
$env:PATH = "<python311>;<python311>\Scripts;D:\electron-build\cr\src\buildtools\win;" + $env:PATH
cd D:\electron-build\cr
python3 src/build/util/lastchange.py -o src/build/util/LASTCHANGE
python3 src/build/util/lastchange.py -s src/third_party/dawn --revision src/gpu/webgpu/DAWN_VERSION
python3 src/build/util/lastchange.py -m SKIA_COMMIT_HASH -s src/third_party/skia --header src/skia/ext/skia_commit_hash.h
python3 src/build/util/lastchange.py -m GPU_LISTS_VERSION --revision-id-only --header src/gpu/config/gpu_lists_version.h
```

### 6.3 补内置 `rc.exe`（Windows 资源编译）

```powershell
$sha1 = (Get-Content src\build\toolchain\win\rc\win\rc.exe.sha1).Trim()
$out  = 'src\build\toolchain\win\rc\win\rc.exe'
curl.exe -L --fail --ssl-no-revoke -o $out "https://storage.googleapis.com/chromium-browser-clang/rc/$sha1"
(Get-FileHash $out -Algorithm SHA1).Hash.ToLower() -eq $sha1   # 必须 True
```

### 6.4 补 `gn.bat`（Node 的 `config.gypi` 生成步骤需要）

```powershell
$bat = 'src\buildtools\win\gn.bat'
"@echo off`r`n`"%~dp0gn.exe`" %*`r`n" | Set-Content -Encoding ascii $bat
cmd /c "`"$bat`" --version"
```

---

## 7. 阶段 E：构建（带 PPAPI）

### 7.1 关键补丁：让 Windows 真的编进 PPAPI

`ppapi/buildflags/buildflags.gni` 原文：

```gn
enable_ppapi = enable_plugins && enable_nacl && !is_fuchsia
```

而 `components/nacl/features.gni` 里 `enable_nacl = ... && target_os == "chromeos"`，所以 Windows 上 PPAPI 永远为 false。

改为：

```gn
enable_ppapi = enable_plugins && !is_fuchsia
```

### 7.2 其它构建期补丁

| 文件 | 补丁 | 原因 |
| --- | --- | --- |
| `build/vs_toolchain.py` | `debug_files` 里 `('dbghelp.dll', False)` → `True` | 未装 "Debugging Tools for Windows" 时 gn gen 失败 |
| `src/buildtools/win/gn.bat` | 新建包装脚本 | node `generate_config_gypi.py` 调用 `gn.bat` |
| `src/ppapi/shared_impl/ppb_trace_event_impl.cc` | `base::PlatformThreadId(thread_id)` → `base::PlatformThreadId(static_cast<base::PlatformThreadId::UnderlyingType>(thread_id))` | `PlatformThreadId` 已改强类型 |

### 7.3 gn gen

```powershell
cd D:\electron-build\cr\src
$env:DEPOT_TOOLS_WIN_TOOLCHAIN='0'
$env:vs2022_install='C:\BuildTools'          # VS 不在默认 Program Files 时必需
$env:PATH = "<python311>;<python311>\Scripts;D:\electron-build\cr\src\buildtools\win;" + $env:PATH

& .\buildtools\win\gn.exe gen out/Testing --args='import("//electron/build/args/testing.gn") enable_plugins=true symbol_level=1'
# 期望：Done. Made ~27000 targets from ~4100 files
```

✅ 判定：`out/Testing/args.gn` 含 `enable_plugins = true`；`out/Testing/gen/ppapi/buildflags/buildflags.h` 中 `BUILDFLAG_INTERNAL_ENABLE_PPAPI() (1)`。

### 7.4 编译

```powershell
cd D:\electron-build\cr\src
cmd /c "set PATH=<python311>;<python311>\Scripts;D:\electron-build\cr\src\buildtools\win;%PATH%&& set vs2022_install=C:\BuildTools&& set DEPOT_TOOLS_WIN_TOOLCHAIN=0&& D:\depot_tools\autoninja.bat -j 16 -C out\Testing electron > D:\electron-build\build.log 2>&1"
```

并行度建议：

| 内存 | `-j` |
| --- | --- |
| 32 GB | 16（14–16 安全；20 有 OOM 风险） |
| 64 GB | 24–32 |

✅ 判定：`out/Testing/electron.exe` 生成（约 299 MB），`git describe` 为 `v37.0.0`。

---

## 8. 阶段 F：运行期四道注册门

即便 PPAPI 编进去了，Flash 插件在 138 上默认仍然**不会被注册**，需要四处改动。

### 8.1 允许命令行注册的 MIME 白名单

`content/common/pepper_plugin_list.cc` 的 `IsAllowedFromCommandLine`：

```cpp
static constexpr auto kMimeTypeAllowlist =
    base::MakeFixedFlatSet<std::string_view>({
        "application/x-blink-deprecated-test-plugin",
        "application/x-blink-test-plugin",
        "application/x-ppapi-tests",
        // ↓ 新增
        "application/x-shockwave-flash",
        "application/futuresplash",
    });
```

### 8.2 启动参数必须带 `--allow-command-line-plugins`

`ComputePepperPluginList` 只有在命令行含该开关时才会解析 `--register-pepper-plugins`。

### 8.3 ppapi 子进程沙箱类型

`sandbox/policy/sandbox_type.cc` 的 `SandboxTypeFromCommandLine`：

```cpp
#if BUILDFLAG(ENABLE_PPAPI) && !BUILDFLAG(IS_WIN)   // 原文
  if (process_type == switches::kPpapiPluginProcess)
    return Sandbox::kPpapi;
#endif
```

改为（Windows 上 PPAPI 本来就不支持沙箱）：

```cpp
#if BUILDFLAG(ENABLE_PPAPI)
  if (process_type == switches::kPpapiPluginProcess) {
#if BUILDFLAG(IS_WIN)
    return Sandbox::kNoSandbox;
#else
    return Sandbox::kPpapi;
#endif
  }
#endif
```

不修的症状：ppapi 子进程启动后立刻退出，`OnProcessCrashed` 报告 **`0x80000003`**（`NOTREACHED` → `__debugbreak`）。

### 8.4 重新编译（增量）

```powershell
D:\depot_tools\autoninja.bat -j 16 -C out\Testing electron
```

---

## 9. 阶段 G：验证 Flash 是否被加载

### 9.1 二进制字符串检查

```powershell
node -e "const fs=require('fs');const s=fs.readFileSync('out/Testing/electron.exe','latin1');for(const p of ['register-pepper-plugins','ppapi plugin process','PpapiPluginProcessHost','ppapi_plugin'])console.log((s.includes(p)?'YES':'no ')+'  '+p)"
```

期望：全部 YES（`PPB_Flash` 此时仍是 no，因为 Flash 私有层还没移植）。

### 9.2 运行测试页（参数必须用 `.cmd` 传）

`#`、`;`、空格在 PowerShell / `Start-Process` 里会被拆坏，**必须用批处理文件**：

```bat
@echo off
set E19_OUT=D:\electron-build\run1
set E19_MODE=control
set ELECTRON_RUN_AS_NODE=
"D:\electron-build\cr\src\out\Testing\electron.exe" ^
  --allow-command-line-plugins ^
  "--register-pepper-plugins=D:\path\pepflashplayer64.dll#Shockwave Flash#Shockwave Flash 34.0 r0#34.0.0.380;application/x-shockwave-flash#swf#spl" ^
  --enable-logging=stderr --v=1 ^
  "D:\app\electron19\app"
```

> 测试 app 需要 `webPreferences.plugins = true`，并在页面里读 `navigator.plugins`。

### 9.3 诊断埋点（可选，正式前应回滚）

| 埋点 | 位置 | 输出 |
| --- | --- | --- |
| 插件生命周期 | `content/ppapi_plugin/ppapi_thread.cc` 写 `ppapi-trace.log` | `OnLoadPlugin: enter / library loaded / got get_interface / calling initialize_module / init OK|FAILED` |
| 宿主接口请求 | `ppapi/proxy/plugin_dispatcher.cc::GetBrowserInterface` 写 `ppapi-ifaces.log` | `PPB_Flash_Clipboard;5.1 -> NULL` 等 |
| 子进程退出码 | `content/browser/ppapi_plugin_process_host.cc::OnProcessCrashed` | `[ppdbg] ppapi child exit_code=0x...` |
| 子进程日志 | `PpapiPluginProcessHost` 构造子命令行时加 `--enable-logging=stderr --log-file=...` | 子进程 FATAL/CHECK 文本 |

### 9.4 判读

- `got get_interface` 出现 → `PPP_GetInterface` 成功（138 上不复现 102 的 CFG fastfail）；
- `init FAILED` 且退出码正常 → **缺 Flash 私有宿主接口**，进入阶段 H；
- `0x80000003` → §8.3 没修；
- `0x80000002`（access violation）→ 插件 DLL 或接口表不匹配。

---

## 10. 阶段 H：Phase 1 移植（ppapi 层，插件侧）

### 10.1 从 87 分支取文件

```powershell
cd D:\electron-build\cr\src
$tag = '87.0.4280.141'
git checkout $tag -- `
  ppapi/c/private/ppb_flash.h ppapi/c/private/ppb_flash_clipboard.h ppapi/c/private/ppb_flash_drm.h `
  ppapi/c/private/ppb_flash_file.h ppapi/c/private/ppb_flash_font_file.h ppapi/c/private/ppb_flash_fullscreen.h `
  ppapi/c/private/ppb_flash_menu.h ppapi/c/private/ppb_flash_message_loop.h ppapi/c/private/ppb_flash_print.h `
  ppapi/c/private/ppp_flash_browser_operations.h `
  ppapi/proxy/flash_clipboard_resource.cc ppapi/proxy/flash_clipboard_resource.h `
  ppapi/proxy/flash_drm_resource.cc ppapi/proxy/flash_drm_resource.h `
  ppapi/proxy/flash_file_resource.cc ppapi/proxy/flash_file_resource.h `
  ppapi/proxy/flash_font_file_resource.cc ppapi/proxy/flash_font_file_resource.h `
  ppapi/proxy/flash_fullscreen_resource.cc ppapi/proxy/flash_fullscreen_resource.h `
  ppapi/proxy/flash_menu_resource.cc ppapi/proxy/flash_menu_resource.h `
  ppapi/proxy/flash_resource.cc ppapi/proxy/flash_resource.h `
  ppapi/proxy/ppb_flash_message_loop_proxy.cc ppapi/proxy/ppb_flash_message_loop_proxy.h `
  ppapi/proxy/serialized_flash_menu.cc ppapi/proxy/serialized_flash_menu.h `
  ppapi/shared_impl/flash_clipboard_format_registry.cc ppapi/shared_impl/flash_clipboard_format_registry.h `
  ppapi/shared_impl/ppb_flash_font_file_shared.h ppapi/shared_impl/ppp_flash_browser_operations_shared.h `
  ppapi/thunk/interfaces_ppb_private_flash.h ppapi/thunk/ppb_flash_thunk.cc ppapi/thunk/ppb_flash_clipboard_thunk.cc `
  ppapi/thunk/ppb_flash_drm_thunk.cc ppapi/thunk/ppb_flash_file_fileref_thunk.cc ppapi/thunk/ppb_flash_file_modulelocal_thunk.cc `
  ppapi/thunk/ppb_flash_font_file_thunk.cc ppapi/thunk/ppb_flash_fullscreen_thunk.cc ppapi/thunk/ppb_flash_menu_thunk.cc `
  ppapi/thunk/ppb_flash_message_loop_thunk.cc ppapi/thunk/ppb_flash_print_thunk.cc `
  ppapi/thunk/ppb_flash_clipboard_api.h ppapi/thunk/ppb_flash_drm_api.h ppapi/thunk/ppb_flash_file_api.h `
  ppapi/thunk/ppb_flash_font_file_api.h ppapi/thunk/ppb_flash_fullscreen_api.h ppapi/thunk/ppb_flash_functions_api.h `
  ppapi/thunk/ppb_flash_menu_api.h ppapi/thunk/ppb_flash_message_loop_api.h
```

### 10.2 合并 `ppapi_messages.h`

从 87 版追加（**不要整文件替换**）：

1. include：`ppb_flash.h`、`ppp_flash_browser_operations.h`、`serialized_flash_menu.h`、`ppp_flash_browser_operations_shared.h`；
2. enum traits：`PP_Flash_BrowserOperations_{Permission,SettingType}`、`PP_FlashSetting`；
3. struct traits：`ppapi::FlashSiteSetting`；
4. 消息块：`// Flash ---` 起，包含 Flash / Clipboard / DRM / File / FontFile / Fullscreen / FlashMenu / PPBFlashMessageLoop 共 ~35 条，插入到 `#endif  // !BUILDFLAG(IS_NACL)` 之前。

> 陷阱：87 的该区段之后紧跟着 `// DeviceEnumeration` 段，而 138 里已有该段——**重复定义会报 `redefinition of 'kName'`**。只取到 `PpapiHostMsg_PPBFlashMessageLoop_Quit` 为止。

### 10.3 参数序列化

- `ppapi/proxy/serialized_structs.h/.cc`：加 `PPBFlash_DrawGlyphs_Params` 结构体 + 构造/析构；
- `ppapi/proxy/ppapi_param_traits.h/.cc`：加 `PPBFlash_DrawGlyphs_Params` 与 `SerializedFlashMenu` 的 `Write/Read/Log`，**必须写在 `namespace IPC { ... }` 内部**。

### 10.4 注册与 GN 接线

| 文件 | 改动 |
| --- | --- |
| `ppapi/proxy/BUILD.gn` | sources 加 7 个 `flash_*_resource.cc`、`ppb_flash_message_loop_proxy.cc`、`serialized_flash_menu.cc` |
| `ppapi/shared_impl/BUILD.gn` | 加 `flash_clipboard_format_registry.cc` |
| `ppapi/thunk/BUILD.gn` | 加 10 个 thunk + `interfaces_ppb_private_flash.h` 到 headers |
| `ppapi/thunk/thunk.h` | include `interfaces_ppb_private_flash.h` |
| `ppapi/proxy/interface_list.cc` | 新增 `#if !BUILDFLAG(IS_NACL) { Permission current_required_permission = PERMISSION_FLASH; #include "ppapi/thunk/interfaces_ppb_private_flash.h" }` |
| `ppapi/shared_impl/singleton_resource_id.h` | 补 `FLASH_CLIPBOARD/FILE/FULLSCREEN/FLASH_SINGLETON_ID` |
| `ppapi/shared_impl/api_id.h` | 补 `API_ID_PPB_FLASH_MESSAGELOOP` |
| `ppapi/shared_impl/resource.h` | `FOR_ALL_PPAPI_RESOURCE_APIS` 补 8 个 `F(PPB_Flash_*_API)` |
| `ppapi/thunk/resource_creation_api.h` + `ppapi/proxy/resource_creation_proxy.{h,cc}` | 补 `CreateFlash{DRM,FontFile,Menu,MessageLoop}` |
| `ppapi/proxy/ppb_instance_proxy.cc` | `GetSingletonResource` switch 补 4 个 Flash 分支 |

### 10.5 87 → 138 漂移修复（必须全做）

| 现象 | 修复 |
| --- | --- |
| `base/macros.h` not found | 删除 include |
| `DISALLOW_COPY_AND_ASSIGN` 未定义 | 替换为 `X(const X&) = delete;` + `X& operator=(const X&) = delete;` |
| `base/stl_util.h` not found / `base::size` 未定义 | 删 include，`base::size(` → `std::size(`，加 `#include <iterator>` |
| `base/callback_forward.h` not found | 改 `base/functional/callback_forward.h` |
| `'return' will never be executed` | `NOTREACHED()` 后不能有 `return`，删除 |
| `no template named 'ParamTraits'` | 特化必须放 `namespace IPC` 内 |
| `only virtual member functions can be marked 'override'` | API 必须加进 `FOR_ALL_PPAPI_RESOURCE_APIS` |
| `base::TimeDelta::FromSeconds` 未定义 | 改 `base::Seconds(...)` |
| `base::SupportsWeakPtr` 未定义 | 改成员 `base::WeakPtrFactory<T> weak_factory_{this};`，`AsWeakPtr()` → `weak_factory_.GetWeakPtr()` |
| `EnableMessagePumping` 未定义 | 删掉该调用（或自行实现消息泵） |
| `base/containers/mru_cache.h` not found | 改 `base/containers/lru_cache.h` + `base::LRUCache` |
| `PpapiGlobals::GetCmdLine()` 未定义 | 改读 `base::CommandLine::ForCurrentProcess()->GetSwitchValueASCII("ppapi-flash-args")` |
| `PreCacheFontForFlash` 未定义 | 空实现 |
| `PP_Flash_Menu` 未声明 | `resource_creation_api.h` 加 `#include "ppapi/c/private/ppb_flash_menu.h"` |

✅ Phase 1 判定（已实测通过）：`autoninja ... electron` 成功；`ppapi-ifaces.log` 中 `PPB_Flash_Clipboard;5.1`、`PPB_Flash_File_ModuleLocal;3`、`PPB_Flash_FontFile;0.2`、`PPB_FlashFullscreen;1.0` 全部 `-> OK`；trace 出现 `OnLoadPlugin: init OK`；测试页截图出现 SWF 画面。

> 补充：`interfaces_ppb_private_flash.h` 里原本缺 `PPB_FLASHFULLSCREEN_INTERFACE_1_0`（87 该接口注册在 `interfaces_ppb_private.h`），需手工补一行 `PROXIED_IFACE(PPB_FLASHFULLSCREEN_INTERFACE_1_0, PPB_FlashFullscreen_1_0)`。

---

## 11. 阶段 I：Phase 2/3 宿主移植（尚未完成，供后续实现）

### 11.1 Phase 2：渲染进程宿主

从 87 取（`chrome/renderer/pepper/`）：

```
pepper_flash_font_file_host.cc/h
pepper_flash_fullscreen_host.cc/h
pepper_flash_menu_host.cc/h
pepper_flash_renderer_host.cc/h
pepper_flash_drm_renderer_host.cc/h
chrome_renderer_pepper_host_factory.cc/h
pepper_helper.cc/h
```

接线点：Electron 的 renderer client（`electron/shell/renderer/electron_renderer_client.cc`）→ `ContentRendererClient::CreatePepperHostFactory`（先核对 138 的 `content/public/renderer/content_renderer_client.h` 是否仍有该钩子；若已删，需在 `content/renderer/pepper/...` 里恢复 factory 注入）。

### 11.2 Phase 3：浏览器进程宿主

从 87 取（`chrome/browser/renderer_host/pepper/` + `chrome/common/`）：

```
chrome_browser_pepper_host_factory.cc/h
pepper_flash_browser_host.cc/h      （代理 / 导航 / 设置 / LSO 限制）
pepper_flash_clipboard_message_filter.cc/h
pepper_flash_drm_host.cc/h
device_id_fetcher.cc/h
chrome/common/pepper_flash.cc/h     （PERMISSION_FLASH 权限位与白名单）
```

接线点：Electron 的 browser client（`electron/shell/browser/electron_browser_client.cc`）→ 创建 `PpapiHost`/`HostFactory` 的位置；把 Profile 依赖改为 Electron 的 `Session`/`BrowserContext`。

### 11.3 验证顺序

1. 页面 `navigator.plugins` 出现 Shockwave Flash；
2. `--type=ppapi` 子进程常驻；
3. trace `init OK`；
4. 测试 SWF 三态截图摘要 > 1（有动画）；
5. 全屏 / 代理 / 外部跳转 / LSO 存档逐项回归。

---

## 12. 错误字典（症状 → 根因 → 修复）

| 症状 | 根因 | 修复 |
| --- | --- | --- |
| `No supported Visual Studio can be found` | VS 不在默认路径 | `vs2022_install=C:\BuildTools` |
| `'atldef.h' file not found` | 缺 ATL | §2.1 |
| `dbghelp.dll not found` | 缺 Debugging Tools | 装该 SDK 组件，或把 `build/vs_toolchain.py` 里 dbghelp 改成 optional |
| `LASTCHANGE.committime` 不存在 | Chromium hook 未跑 | §6.2 |
| `DAWN_VERSION` / `gpu_lists_version.h` 不存在 | 同上 | §6.2 |
| `Vulkan.res` FileNotFoundError | 内置 `rc.exe` 缺失 | §6.3 |
| `config.gypi` 失败：找不到 `gn.bat` | node 脚本调用 `gn.bat` | §6.4 |
| `LLVM ERROR: out of memory` | 并行度过高 | 降 `-j`（32 GB → 12–16） |
| 二进制无 PPAPI 字符串 | `enable_ppapi` 被 NaCl 门挡住 | §7.1 |
| 插件不注册（plugins 无 Flash） | MIME 白名单 / 缺 `--allow-command-line-plugins` | §8.1、§8.2 |
| ppapi 子进程 `0x80000003` | sandbox type NOTREACHED | §8.3 |
| `PPP_InitializeModule` 返回 -2 | 缺 `PPB_Flash_*` 宿主接口 | 阶段 H |
| `git am returned 128` | patch 已应用 | `git am --abort`，别再跑 runhooks |
| `extra tokens at end of #include directive` | 补丁脚本把 `` `n `` 写进源码 | 手工修正 include 行 |
| `redefinition of 'kName'` | 消息块重复插入 | 只插到 `PPBFlashMessageLoop_Quit` |
| `unterminated function-like macro invocation` | 消息块截断（少了续行） | 检查每个 `IPC_MESSAGE_*` 的续行完整 |

---

## 13. 快速自检脚本（可整段复制）

```powershell
# 1) 版本
git -C D:\electron-build\cr\src describe --tags
git -C D:\electron-build\cr\src\electron describe --tags
# 期望：138.0.7204.35-<n>-g<hash> / v37.0.0

# 2) 关键产物
foreach ($p in @('src\out\Testing\electron.exe','src\buildtools\win\gn.exe','src\third_party\ninja\ninja.exe',
                 'src\build\util\LASTCHANGE','src\gpu\webgpu\DAWN_VERSION','src\gpu\config\gpu_lists_version.h',
                 'src\build\toolchain\win\rc\win\rc.exe','src\buildtools\win\gn.bat')) {
  '{0,-55} {1}' -f $p, (Test-Path (Join-Path 'D:\electron-build\cr' $p))
}

# 3) PPAPI 是否编入
$exe = 'D:\electron-build\cr\src\out\Testing\electron.exe'
$s = [System.Text.Encoding]::Latin1.GetString([System.IO.File]::ReadAllBytes($exe))
foreach ($p in @('register-pepper-plugins','ppapi plugin process','PpapiPluginProcessHost')) {
  '{0,-40} {1}' -f $p, $s.Contains($p)
}

# 4) 插件接口是否已注册（需要先跑过测试页）
Get-Content D:\electron-build\ppapi-ifaces.log -ErrorAction SilentlyContinue | Select-Object -Last 20

# 5) 插件初始化结果
Get-Content D:\electron-build\ppapi-trace.log -ErrorAction SilentlyContinue
```

---

## 14. 交付物与收尾

### 14.1 必须保留

- `src`（Chromium 138 + Electron v37）
- `out/Testing`（可复现构建）
- 补丁清单（本文 §7.2、§8、§10.5）**建议以 patch 文件形式纳入版本管理**，而不是散落在工作树

### 14.2 必须在正式版前回滚的临时埋点

| 文件 | 埋点 |
| --- | --- |
| `content/ppapi_plugin/ppapi_thread.cc` | `PpapiTrace` 写文件 |
| `content/ppapi_plugin/ppapi_plugin_main.cc` | `PpapiTrace2` |
| `content/browser/plugin_service_impl.cc` | `[ppdbg]` LOG |
| `content/browser/ppapi_plugin_process_host.cc` | `[ppdbg] exit_code` + 子进程日志开关 |
| `content/common/pepper_plugin_list.cc` | `[ppdbg]` LOG |
| `ppapi/proxy/plugin_dispatcher.cc` | `ppapi-ifaces.log` |

### 14.3 三条硬经验

1. **改 `ppapi_messages.h` 的代价是几千个目标重编**——一次改完，别反复动；
2. **`args.gn` 改动 = 一次全量重编**（30 分钟–2 小时）——版本/开关一次定死；
3. **87 代码迁移是"批量替换已知漂移 + 按编译错误逐个修"**，不要试图一次性猜全。
