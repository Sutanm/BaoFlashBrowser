# 内核补丁记录

自编译内核（[142 真机报告 §10.16](../reports/2026-11-21-142-flash-runtime.md)）的补丁序列记录。这里只登记**已验证**的补丁，每条都附构建标识与复现步骤。

| 项 | 值 |
| --- | --- |
| 补丁 | [`0001-ppapi-renderer-plugin-path-check.patch`](0001-ppapi-renderer-plugin-path-check.patch) |
| 内核树 | `D:\electron-build-142\cr\src`，分支 `bao/142-265` |
| 提交 | `9de35f61aea60` |
| tag | `bao-v142-265-ppapi-sandbox`（回退点 `bao-v142-265-verified`） |
| 产物 | `out/Rel/electron.exe`，232,040,448 B，SHA-256 `68CF2350DAEAB2FD8906AC4FFE282B1136AC3B8A864D80C223E89070C52C8020` |
| 插件 | `pepflashplayer64.dll` 29.0.0.171，SHA-256 `85A836F347D7B3EB06DDDA6573A70C2BC46D03F4B52FDEB4D884E2D71A20B51F` |

上表记录页面渲染沙箱补丁 0001 的基线产物。当前运行时在这一基线上应用了 [Windows PPAPI 进程沙箱补丁 0002](#windows-ppapi-进程沙箱)。

## 症状

页面视图开启渲染进程沙箱（`webPreferences.sandbox: true`）时，PPAPI Flash **注册成功但不实例化**：

- `navigator.plugins` 里有 `Shockwave Flash`，`navigator.mimeTypes['application/x-shockwave-flash']` 为真；
- `<embed>` 元素拿不到插件对象（`typeof embed.PercentLoaded === 'undefined'`）；
- 没有 `ppapi` 子进程，`app.getAppMetrics()` 里没有 `Pepper Plugin`；
- 浏览器日志里连 `PpapiPluginProcessHost::Init()` 的 `Ppapi sandbox on Windows is not supported.` 都没有 —— 插件进程**从未被请求**。

关闭该视图的沙箱（`sandbox: false`，无需进程级 `--no-sandbox`）后一切正常。三组对照（`sandbox` / `--no-sandbox` 的四种组合）见 [M1 增量记录 §3](../reports/2026-11-22-m1-shell-increment.md#3-配置与沙箱例外)。

## 根因

`content/common/pepper_plugin_list.cc` 的 `ComputePluginsFromCommandLine()` 在**渲染进程**里复核插件 DLL：

```cpp
    uint64_t index_mask = 1ULL << i;
    if (!(skip_file_check_flags & index_mask)) {
      if (base::PathExists(plugin.path)) { ... }
      else { DVLOG(1) << "Plugin doesn't exist"; continue; }   // ← 静默丢弃
    }
```

Windows 渲染进程沙箱不给应用目录读权限，`base::PathExists()` 对 `pepflashplayer64.dll` 返回 false，插件被 `continue` 掉；`PepperPluginRegistry` 只剩内部 PDF 插件，`GetInfoForMimeType()` 未命中，`RenderFrameImpl::CreatePlugin()` 返回空，`<embed>` 退化成普通元素。

上游注释写明「这个检查必须在沙箱生效前跑」——那在 Linux 上成立（seccomp 在 `RenderThreadImpl::Init` 之后启用），在 Windows 上不成立（进程从启动起就在沙箱里）。旧产品（Electron 11）从未触发，是因为 Electron 11 的渲染进程默认不启用沙箱。

定位用的插桩日志（已回退）：

```text
[ppgate] HTMLPlugInElement::LoadPlugin mime=application/x-shockwave-flash allowed_to_load=1
[ppgate] HTMLPlugInElement::LoadPlugin allow_plugins=1
[ppgate] RenderFrameImpl::CreatePlugin mime=application/x-shockwave-flash
[ppgate] ComputePepperPluginList allow_command_line=1 before=1 check_file_exists=0
[ppgate] plugin path missing: D:\electron-build-142\dist\pepflashplayer64.dll     ← 根因
[ppgate] GetInfoForMimeType miss application/x-shockwave-flash list_size=1
```

## 补丁

只改 3 个文件、20 行：把「是否复核文件存在」变成显式参数，**浏览器进程仍然校验**，渲染进程只取元数据。

| 文件 | 改动 |
| --- | --- |
| `content/common/pepper_plugin_list.h` | `ComputePepperPluginList(plugins, bool check_file_exists = true)`，说明沙箱渲染进程必须传 false |
| `content/common/pepper_plugin_list.cc` | 参数透传到 `ComputePluginsFromCommandLine()`；`check_file_exists` 为 false 时跳过 `base::PathExists()` |
| `content/renderer/pepper/pepper_plugin_registry.cc` | 渲染进程初始化传 `/*check_file_exists=*/false` |

不采用应用侧 `sandbox: false` 的理由：那会把**所有**页面视图（含 Flash 这类高风险内容）的渲染进程沙箱关掉，而沙箱是浏览器的主干纵深防御；架构 §3 只允许「按证据逐项决定的沙箱例外」，不允许全局永久关闭。

## 重建与验证

```powershell
cd D:\electron-build-142\cr\src
$env:DEPOT_TOOLS_WIN_TOOLCHAIN = '0'      # 用本机 VS，不走 CIPD
$env:vs2022_install = 'C:\BuildTools'    # 本机 VS 不在默认路径
$env:SCCACHE_SERVER_PORT = '47999'        # 默认端口被 Windows 端口排除段占用
.\third_party\ninja\ninja.exe -C out\Rel electron

# 组装干净 dist（含插件二进制）并刷新应用运行时
pwsh -NoProfile -File D:\electron-build-142\flashprobe\assemble-dist.ps1
cd D:\java_workspace\BaoFlashBrowserNext\app
Move-Item .runtime\win-x64 .runtime\win-x64-pre-ppapi-sandbox
npm run runtime:prepare -- 'D:\electron-build-142\dist'
```

验证结果（2026-11-22）：

- 沙箱开启时插件实例化：`PercentLoaded() = 100`、`SetVariable/GetVariable` 往返 `baoValue`、`Pepper Plugin` 进程存在；
- 应用侧 `npm run smoke` **7/7**、`npm run smoke:packaged` 通过（页面视图已改回 `sandbox: true`）；
- 沙箱关闭时行为不变（对照组）。

## 回退

```powershell
cd D:\electron-build-142\cr\src
git revert --no-edit 9de35f61aea60   # 或 git checkout bao-v142-265-verified
```

回退后必须把页面视图改回 `sandbox: false`，否则 PPAPI 插件不会实例化。

## Windows PPAPI 进程沙箱

补丁 [`0002-win-ppapi-process-sandbox.patch`](0002-win-ppapi-process-sandbox.patch) 应用于 `9de35f61aea60`，构建标识为 `bao-v142-265-ppapi-sandbox+win-ppapi-process-sandbox`。
`out/Rel/electron.exe` 的 SHA-256 为 `5BB2274FA9F4FEC51DBCE4CDBCB20076B9E47B888761FEC0D6F6B74612667366`。

Chromium 在 `28df8180bb721` 移除了专用的 Windows PPAPI 沙箱类型。移植后的插件进程以 `--no-sandbox` 启动，Adobe Flash 因此可以运行初始化探测命令 `cmd.exe /c echo NOT SANDBOXED`。
补丁使用 Chromium 现有的 Windows 通用沙箱，给 Pepper 配置独立的策略。插件进程使用受限令牌、Win32k 限制和禁止派生子进程的作业限制。Flash 保留 ActionScript 所需的动态代码能力。

Windows 实测中，`app.getAppMetrics()` 报告 Pepper Plugin 的 `integrityLevel: "untrusted"` 和 `sandboxed: true`。Flash 加载、JS 桥、键盘输入和 Stage3D AUTO / SOFTWARE 均通过。进程及焦点监测未发现测试启动 CMD 或抢占前台。

从基线重建时，在内核树执行 `git apply D:\java_workspace\BaoFlashBrowserNext\docs\kernel\0002-win-ppapi-process-sandbox.patch`，再按上述方法构建 `out/Rel`。
