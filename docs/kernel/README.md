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

## 候选登记册（未采用的补丁）

看过但因故没落的补丁统一登记在 [`patch-candidates.md`](patch-candidates.md)：每条都写清"改什么 / 为什么没落 / 依据哪份实测 / 什么条件下再看"。
遇到窗口、视图、生命周期类问题先去那里查，不要重新调研。

## 上游回拣候选（未应用）

E39（`v39.8.10`）已结束支持，官方修复想用只能单条回拣。候选的**上游原文**归档在 [`upstream/`](upstream/README.md)（18 条，2026-11-25 取自主线），移植排期、批次划分与构建/账目步骤见 [E39 回拣实施计划](2026-11-25-e39-backport-plan.md)。

动手前先看两条硬事实：

1. 18 条里 **3 条可直接 `git apply`**（#50688、#51900 整条；#51562 只有 spec 冲突），其余需手工移植；单条只有 2–130 行。
2. `#54311` / `#54090` 要改 `patches/chromium/*`，**必须重打 Chromium 补丁集**；其余只动 `shell/`，增量编译即可。

### 已移植并进入运行时（内核 tag `…+e39-batch1`）

| 补丁 | 上游 | 内容 | 验证 |
| --- | --- | --- | --- |
| [`0003-51200-hidden-view-drag-regions.patch`](0003-51200-hidden-view-drag-regions.patch) | #51200 `c74de25` | 隐藏的 `WebContentsView` 不再把 `-webkit-app-region: drag` 区域贡献给父窗口的命中测试（+7 行；E39 用 `GetVisible()`，上游用 `view()->GetVisible()`） | `WM_NCHITTEST`：改前隐藏视图返回 `HTCAPTION(2)`，改后 `HTCLIENT(1)`，可见时仍 `HTCAPTION(2)` |
| [`0004-50688-wrappable-deferred-destruction.patch`](0004-50688-wrappable-deferred-destruction.patch) | #50688 `3f8238b` | `Wrappable` 的 `SecondWeakCallback` 改为 posted task 延迟析构（整条 apply） | 改前泄漏 20 个 `WebContentsView` 后退出报 `Invoke in DisallowJavascriptExecutionScope`（退出码 `-2147483645`），改后干净退出 `0` |
| [`0005-51900-render-process-gone-ordering.patch`](0005-51900-render-process-gone-ordering.patch) | #51900 `571d6e9` | `render-process-gone` 改在进程死亡通知之后发出（整条 apply） | **未采用**：E39 上 5 种触发均不崩，E39 缺上游所说的 CHECK 路径（v42/43 启动数据重构引入的回归）。原文保留作参考 |
| [`0006-53031-detached-view-bounds.patch`](0006-53031-detached-view-bounds.patch) | #53031 `96f3996` | 视图不在 `Widget` 里时把尺寸直接 `Resize` 给 WebContents（+20 行） | `innerWidth×innerHeight`：从未 attach 时 `[0,0]` → `[400,300]`；叠加层"先 setBounds 后 addChildView"顺序下附着前也正确。缺口：`removeChildView` 后再 setBounds 仍 stale（E39 上不再触发 Layout，产品不依赖） |
| [`0007-49959-webcontents-clone.patch`](0007-49959-webcontents-clone.patch) | #49959 `76a03e1` | 新增 `webContents.clone()`（44 行；E39 用 `Handle::ToV8()`） | **已装配但当前无消费者**：克隆体**拿不到页面 preload**（官方 E44 同样如此）→ Ruffle 不可用；PPAPI 同进程第二个实例无法实例化 → 本品页面标签无适用场景。应用侧接入已撤销，补丁保留待上游支持或 Ruffle 改为免 preload 注入 |
| [`0008-frameless-resize-band-dpi.patch`](0008-frameless-resize-band-dpi.patch) | 自研（非上游） | 无边框窗口的缩放带按设备缩放比换算：`kResizeInsideBoundsSize`（DIP）→ 物理像素 | 真实缩放三档实测：**旧内核恒 4 px**（不随 DPI 变）、**新内核 100% 4 / 150% 7 / 200% 9 px**；100% 下新旧一致（改动是恒等）；冒烟 58 用例 / 0 失败 |

另：`#51562`（约束后缩水）**不采用**——真实症状只在 `frame:true + setMaximumSize` 组合，产品路径不触发，
且补丁依赖 E39 不存在的 `GetRestoredFrameBorderInsets()`。两条判定过程见
[batch1-recheck.md](../evidence/probes/2026-11-25-upstream-electron-probe/batch1-recheck.md)。

当前分支 `bao/e39-batch4`（`a5693f61ab` → `08dac9259e` → `5faf91f967` → `c244a99d9c` → `353fb66eb0`），构建产物 SHA-256 `0A7C92A9…0D7B1DE3F`，
已装配进 `app/.runtime/win-x64`（tag `bao-v142-265-ppapi-sandbox+win-ppapi-process-sandbox+e39-batch1`），
`runtime:check` 通过、冒烟 50 通过 / 0 失败。增量记录见 [2026-11-25-e39-backport-batch1](../reports/2026-11-25-e39-backport-batch1.md)。

旧内核整体备份在 `app/.runtime/win-x64-before-e39-batch1`（`5BB2274F…`），`runtime-manifest.json` 的 `fallbackTag` 亦指向它。回退只需换回目录并把 manifest 的 exe 哈希改回去。
`assemble-dist` → `runtime:prepare` → 更新清单。
