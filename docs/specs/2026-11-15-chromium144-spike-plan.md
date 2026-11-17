# Chromium 144（Electron 40）Flash 移植 Spike 执行计划

> **状态更新（2026-11-15，D3 实测）：144 spike 阻断，建议改目标为 140**
>
> 在 144 上完成源码、同步、hooks、`gn gen`、vendor 与 20+ 项编译修复后，编译 `ppapi/proxy:ipc` 时触碰到硬阻断：
> **144 移除了整套 legacy IPC 消息框架**（`ipc_message_macros.h`、`ipc_message_utils.h`、`ipc_channel_handle.h`、
> `ipc_platform_file.h`、`ipc_sender.h` 全部不存在），PPAPI 的约 300 条 `IPC_MESSAGE_CONTROL*` 消息失去编译基础。
> 详见 [`2026-11-15-forward-version-feasibility.md`](2026-11-15-forward-version-feasibility.md) §1.7。
>
> | 目标 | 结论 |
> | --- | --- |
> | **140 / E38** | ✅ 新推荐目标：legacy IPC 完整保留，只需处理 5 个边缘头 |
> | 142 / E39 | ⚠️ 天花板：仅 `ChannelHandle` 被删 |
> | 144 / E40+ | ❌ 需复活 IPC 消息框架（2–3 个月+），不建议 |
>
> **144 已完成且可复用到 140 的资产**：本地源码树、gclient sync、hooks、`gn gen` 接线（`enable_ppapi`/NaCl 桩/`ui/surface`/
> media visibility/`content/*` 的 `if (enable_ppapi)` 块合并）、以及 20+ 项 ppapi 编译漂移修复（§4.1）。
> 到 140 只需要把 `git checkout 138 -- ppapi …` 那一步替换成 140 的对应文件，并去掉为数不多的 IPC 适配。


> 制定日期：2026-11-15
> 依据：[`2026-11-15-forward-version-feasibility.md`](2026-11-15-forward-version-feasibility.md) 的实测评估
> 目标版本：**Chromium 144.0.7559.60 / Electron v40.0.0 / Node v24.11.1**
> 时间盒：**15 个工作日**，硬止损点 **D10**
> 关联：[`2026-11-14-flash-port-ai-runbook.md`](2026-11-14-flash-port-ai-runbook.md)（138 的完整复现手册，本计划的编译手法全部复用）

---

## 0. 目标与验收

### 0.1 必须同时满足（缺一即失败）

| # | 判据 | 验证命令 |
| --- | --- | --- |
| V1 | `gn gen out/Testing` 成功 | `Done. Made N targets` |
| V2 | `autoninja -C out/Testing electron` 成功 | 生成 `out\Testing\electron.exe` |
| V3 | Flash 初始化成功 | `ppapi-trace.log` 出现 `OnLoadPlugin: init OK` |
| V4 | 出帧 | FlxInvaders 截图出现游戏画面（三态摘要 ＞1） |

### 0.2 非目标（本 spike 不做）

剪贴板、代理设置、外部跳转、全屏、LSO 限制等**外围功能**——这些是 Phase 2/3 的活，144 上同样后补。

### 0.3 为什么先做 144 而不是 140/142

| 选项 | 说明 |
| --- | --- |
| 140 / 142 | 更便宜，但**没有跨过 IPC 重构档**；做完 140 后仍要再面对 144 |
| **144** | 处在"legacy IPC 集中重构"（traits 改名、`Sender` 删除、`PlatformFileForTransit` 删除）的第一档；**跨过 144 = 148/150 只是同一套剧本 + 更多编译修复** |
| 150+ | 需重新下载源码 + 更多漂移，作为长期分支再议 |

---

## 1. 前置事实（已实测，不要再重新调研）

### 1.1 版本与依赖

- Electron v40.0.0 → Chromium **144.0.7559.60**，Node **v24.11.1**
- **144 的 Chromium 源码本地已有**（实测：`144.0.7559.60` 提交 `c5d4451293ea5` 在 `D:\git_cache\chromium.googlesource.com-chromium-src` 中，`DEPS`/`chrome/VERSION`/`base/BUILD.gn` 等 blob 均可读），**无需重新下载 Chromium 源码**。\n- 仍需联网的只有：**DEPS 第三方依赖**（v8/skia/pdfium/angle/node 等独立仓库）、**Node v24.11.1**、以及工具链版本变化时的 CIPD 包。

### 1.2 144 的删除面（需从 138 vendor）

| 路径 | 138 文件数 | 144 剩余 |
| --- | --- | --- |
| `ppapi/` | 1419 | 0 |
| `content/renderer/pepper/` | 137 | 0 |
| `content/ppapi_plugin/` | 9 | 0 |
| `content/browser/` ppapi 相关 | 66 | 0 |
| `content/common/` pepper 相关 | 7 | 0 |
| `content/public/common/content_plugin_info.h` | 存在 | **0**（需 vendor） |
| `content/public/browser/browser_ppapi_host.h` | 存在 | 0（需 vendor） |

### 1.3 144 仍然存在的"落脚点"（不用重写）

| 依托点 | 状态 |
| --- | --- |
| `third_party/blink/public/web/web_plugin.h`（+ container/params） | ✅ 存在 |
| `RenderFrameImpl::CreatePlugin` + `ContentRendererClient::OverrideCreatePlugin` | ✅ 存在 |
| `ipc/ipc_message.h` / `ipc_channel.h` / `ipc_channel_proxy.h` | ✅ 存在 |
| `ipc/param_traits.h`（traits 的新名字） | ✅ 存在 |
| `base/files/file.h` | ✅ 存在 |

### 1.4 144 特有的三处 IPC 漂移（本 spike 的主要工作量）

| 提交 | 变化 | ppapi 侧影响 |
| --- | --- | --- |
| `Rename several ipc_* files used by param_traits*` | `ipc_message_utils.h` → `ipc/param_traits.h` + `param_traits_macros.h` + `param_traits_{read,write}_macros.h` + `param_traits_utils.h` | 约 7 个文件改 include |
| `Remove class IPC::Sender` | `Send()` 并入 `IPC::Channel` / `IPC::ChannelProxy` | 约 8 个文件 + `Dispatcher` 继承结构调整 |
| `Remove IPC::PlatformFileForTransit` | 改用 `base::File` / `base::FileDescriptor` | **51 处 / 约 17 文件**（`serialized_handle`、`audio_*`、`file_io_resource`、`ppapi_param_traits` 等） |

---

## 2. 环境准备（D1）

### 2.1 sccache（已安装并验证）

```powershell
# 位置与版本
D:\tools\sccache\sccache.exe --version     # sccache 0.19.0

# 缓存目录与容量（server 已启动在 127.0.0.1:4226）
$env:SCCACHE_DIR        = 'D:\sccache'
$env:SCCACHE_CACHE_SIZE = '60G'
D:\tools\sccache\sccache.exe --start-server
D:\tools\sccache\sccache.exe --show-stats
```

实测验证（clang-cl 两次编译，第二次命中）：

```text
Compile requests      2
Cache hits            1
Cache misses          1
Cache hits rate   50.00 %
```

**在 144 的 `args.gn` 里启用**（新 `out` 目录，不影响 138 的构建）：

```gn
cc_wrapper = "D:/tools/sccache/sccache.exe"
```

> 注意事项：
> - 第一次全量仍是冷缓存（和不开一样慢），第二次起命中；
> - **改共享头文件（如 `ppapi_messages.h`）会让命中率骤降**——这是正常的，sccache 只省"未变化"的编译单元；
> - 若 link 阶段报 PDB 相关错误，先去掉 `cc_wrapper` 做对照，确认是 sccache 与 `/Fd` 的兼容问题。

### 2.2 复用 138 的已知工具链修复

直接照搬 runbook §2/§6 的四项：`python3.exe` 别名、VS `vs2022_install`、ATL 组件、`gn.bat` 包装、`rc.exe` 下载、`lastchange` 系列生成文件。

### 2.3 取 144 源码（本地，无需下载 Chromium）

144 的源码对象**已经在本地 git 缓存里**（实测：`144.0.7559.60` → 提交 `c5d4451293ea5`，
`DEPS` / `chrome/VERSION` / `base/BUILD.gn` / `web_plugin.h` 等 blob 均可读）。
所以这一步只是"从缓存 clone 一棵工作树"，**没有 14 GB 下载**：

```powershell
# 1) 从本地缓存 clone 出 144 工作树（--local 用硬链接，秒级完成、几乎不占额外磁盘）
git clone --local D:\git_cache\chromium.googlesource.com-chromium-src D:\electron-build-144\cr\src
git -C D:\electron-build-144\cr\src checkout -q 144.0.7559.60
git -C D:\electron-build-144\cr\src describe --tags      # 期望：144.0.7559.60

# 2) 校验目标版本的 blob 真的可读（防止不完整缓存）
foreach ($p in @('DEPS','chrome/VERSION','third_party/blink/public/web/web_plugin.h')) {
  git -C D:\electron-build-144\cr\src cat-file -e "144.0.7559.60:$p"; "  $p exit=$LASTEXITCODE"
}

# 3) 仍需联网的部分：gclient sync 拉 DEPS 依赖（几 GB，不是 14 GB）
$env:HTTP_PROXY='http://127.0.0.1:10808'; $env:HTTPS_PROXY=$env:HTTP_PROXY
$env:GIT_CACHE_PATH='D:\git_cache'; $env:DEPOT_TOOLS_WIN_TOOLCHAIN='0'
cmd /c "D:\depot_tools\gclient.bat sync --nohooks --jobs 8 -v > D:\electron-build-144\sync.log 2>&1"
```

> 需要联网的只有：**DEPS 第三方依赖**（v8 / skia / pdfium / angle / node 等独立仓库）、
> **Node v24.11.1**、以及工具链版本变化时的 CIPD 包。
> 本地缓存的 tag 覆盖到 **149**，所以 140 / 142 / 144 / 148 / 149 都能这样做；**150 才需要重新下载 Chromium**。

> **实测踩坑（2026-11-15）**：`git clone --local` 出来的仓库继承了缓存的 `maintenance.strategy=gc`，gclient sync 会触发 git maintenance run → epack --all，**重打包 14 GB 历史**（CPU 高、耗时十几分钟，不是下载）。
> 规避：clone 后立刻执行 git config maintenance.auto false、git config gc.auto 0，再跑 sync。

### 2.4 建树与切版本

```powershell
# 新工作区，避免污染 138
D:\electron-build-144\cr\
  src\           ← Chromium 144.0.7559.60
    electron\    ← Electron v40.0.0

gclient config --name "src/electron" --unmanaged https://github.com/electron/electron
git -C src/electron checkout v40.0.0
Select-String src/electron/DEPS -Pattern "chromium_version|node_version"
# 期望 chromium_version='144.0.7559.60'  node_version='v24.11.1'
```

**alternates**（复用 §5.2 的技巧）：把 144 的 bare 缓存对象目录写进 `src/.git/objects/info/alternates`。

✅ D1 判定：`git -C src describe --tags` 输出 144.0.7559.60（**本地完成，无 14 GB 下载**）；`gclient sync --nohooks` 完成且 `src/third_party/v8` 存在（这一步才用网络，约几 GB）。

---

## 3. Vendor（D2–D4）

### 3.1 从 138 拉取整套 PPAPI + pepper

```powershell
cd D:\electron-build-144\cr\src
$t = '138.0.7204.35'
git checkout $t -- `
  ppapi `
  content/renderer/pepper `
  content/ppapi_plugin `
  content/public/common/content_plugin_info.h `
  content/public/browser/browser_ppapi_host.h `
  content/common/pepper_plugin_list.cc content/common/pepper_plugin_list.h
# content/browser 的 ppapi 相关文件（66 个）按列表逐个 checkout：
git -C . ls-tree -r --name-only $t | Select-String '^content/browser/.*(ppapi|pepper)' |
  ForEach-Object { $p = ($_ -split ':')[-1]; git checkout $t -- $p }
```

### 3.2 恢复构建接线（清单）

| 文件 | 动作 |
| --- | --- |
| `ppapi/buildflags/buildflags.gni` | `enable_ppapi = enable_plugins && !is_fuchsia`（同 138） |
| `sandbox/policy/sandbox_type.cc` | `--type=ppapi` → Windows 返回 `Sandbox::kNoSandbox` |
| `content/common/pepper_plugin_list.cc` | MIME 白名单加 `application/x-shockwave-flash`、`application/futuresplash` |
| `content/public/common/content_switches.{h,cc}` | 恢复 `kRegisterPepperPlugins`、`kAllowCommandLinePlugins`、`kPpapiStartupDialog` 等 |
| `content/BUILD.gn`（及各子目录） | 恢复 `ppapi_plugin`、`renderer/pepper` 目标 |
| `ppapi/BUILD.gn` 及子目录 | 整体恢复（随 vendor 一起回来） |
| `content/renderer/render_frame_impl.cc` | `CreatePlugin` 中恢复 `PepperWebPluginImpl` 分支（144 里只剩 `OverrideCreatePlugin`） |
| `ppapi/shared_impl/ppapi_permissions.h` | `PERMISSION_FLASH` 位（随 vendor 回来） |

### 3.3 87 的 Flash 私有层

把 138 上已完成的移植**整体复用**：`ppapi/c/private/ppb_flash*.h`、`ppapi/proxy/flash_*_resource`、`ppapi/thunk/*flash*`、`interfaces_ppb_private_flash.h`、`ppapi_messages.h` 的 35 条消息、`local_flash_host` 无需（我们走 A 方案）、`interface_list.cc` 注册段。

✅ D4 判定：`gn gen out/Testing` 通过（此时不要求能编译）。

---

## 4. 编译适配（D5–D11）

### 4.1 第一批：`ppapi_proxy` 目标（D5–D8）

```powershell
autoninja -C out/Testing obj/ppapi/proxy/ppapi_proxy.lib
```

按 §1.4 的三处漂移逐项改：

| 错误形态 | 修法 |
| --- | --- |
| `'ipc/ipc_message_utils.h' file not found` | 改成 `ipc/param_traits.h` +（按需）`param_traits_macros.h` |
| `'ipc/ipc_sender.h' file not found` / `IPC::Sender` 未定义 | `Dispatcher` 不再继承 `IPC::Sender`；`Send()` 直接调 `ChannelProxy`/`Channel` 的同名方法 |
| `IPC::PlatformFileForTransit` 未定义（51 处） | 换成 `base::File` / `base::FileDescriptor`；`SerializedHandle` 内部存储类型同步改 |
| `base::FileDescriptor` 序列化 traits 缺失 | 用 144 自带的 `base::File` traits（见 `ipc/param_traits*.h`） |

### 4.1.1 144 上已完成的漂移修复（实测，可复用到 140/142）

| 问题 | 修复 |
| --- | --- |
| `ppapi/buildflags.gni` 依赖已删的 NaCl 配置 | 去掉 import；`enable_plugins` 改从 `content/public/common/features.gni` 引入 |
| 144 无 `build/config/nacl/*`、`components/nacl/*` | 新建最小桩：`config.gni`（`is_nacl=false` 等）、`features.gni`（`enable_nacl=false`）、`common/BUILD.gn`（`ENABLE_NACL=0`） |
| `BUILDFLAG_INTERNAL_IS_NACL` / `IS_MINIMAL_TOOLCHAIN` 未定义 | `build/build_config.h` 补兼容定义（固定 0） |
| `//ui/surface` 删除 | 从 138 vendor `ui/surface`（TransportDIB，PPB_ImageData 跨进程共享内存） |
| `//media:shared_memory_support` 删除 | 改依赖 `//media/base`，并在 `media/base/BUILD.gn` 的 visibility 里放行 ppapi 目标 |
| `//ipc:test_support` 删除 | 去掉 ppapi 测试目标里的该依赖 |
| `content/child` visibility 不含 `ppapi_plugin` | 白名单补 `//content/ppapi_plugin/*` |
| `content_plugin_info.h` / `browser_ppapi_host.h` 删除 | 从 138 vendor |
| 5 个 BUILD.gn 的 `if (enable_ppapi)` 块 | 从 138 原样提取，按目标名合并进 144 |
| `memset` 触发 `-Wunsafe-buffer-usage-in-libc-call` | 给 22 个 ppapi 源文件加 `allow_unsafe_libc_calls` pragma |
| `ViewData()` 用 memset 构造 | 改成员初始化列表 |
| `ppb_trace_event_impl` 的 TraceLog / AddTraceEvent | 降级为 no-op（Perfetto 化） |
| `PPB_Gamepad` 的 `std::array` → memcpy | 改 `.data()` |
| `AudioBus::WrapMemory` span 签名 | `base::span<float>(reinterpret_cast<float*>(...), n)` + 补 `media/base/audio_sample_types.h` |
| `GLES2Implementation` 构造参数 7 → 5 | 去掉 `bind_creates_resources` / `support_client_side_arrays` |
| `vpn_provider_util.h` | 补 `<vector>`、字段加 `[[maybe_unused]]` |

### 4.2 第二批：`content/renderer/pepper` + 插件进程（D9–D11）

```powershell
autoninja -C out/Testing obj/content/renderer/renderer.lib
```

重点：

- `pepper_webplugin_impl.*`：144 的 `WebPlugin` 新增虚函数**都有默认实现**，一般不阻塞；报错则补空实现；
- `renderer_ppapi_host_impl.*`：`PpapiHost` 接口在 144 可能挪动，按编译错误补 include；
- `ppapi_plugin_main.cc` / `ppapi_thread.cc`：沙箱/命令行接口按 138 的方式恢复。

### 4.3 止损点（**D10 收盘时必须满足**）

> **`ppapi_proxy` 目标必须编译通过。**
> 否则停止 spike，产出"卡在哪一层、剩余工作量"的结论，不再投入。

如果 D10 通过，D11 继续 renderer 层；renderer 层若到 D12 中午仍无法编译，同样止损（记录错误分布）。

---

## 5. 链接与运行（D12–D13）

### 5.1 链接

```powershell
autoninja -C out/Testing electron
# 期望 out\Testing\electron.exe
```

### 5.2 注册门（同 138）

1. `--allow-command-line-plugins`
2. MIME 白名单（§3.2）
3. sandbox type（§3.2）
4. `--register-pepper-plugins`（用 `.cmd` 传参，见 runbook §8.3）

### 5.3 首次运行判定

```powershell
# trace 埋点需一并移植（ppapi_thread.cc / ppapi_plugin_main.cc 各一条）
Get-Content D:\electron-build-144\ppapi-trace.log
# 目标：OnLoadPlugin: init OK
```

✅ D13 判定：`init OK` 出现；`--type=ppapi` 子进程常驻。

---

## 6. 出帧与收尾（D14–D15）

1. 测试页 `button.swf` → 截图应为绿色按钮；
2. 换 `FlxInvaders.swf` → 截图应出现游戏画面；
3. 记录：三态截图摘要、ppapi 进程数、`ppapi-ifaces.log`；
4. 产出：**patch 集**（vendor 文件列表 + 所有修改）、更新 runbook/评估文档；
5. 用 sccache 统计报告提速效果（`sccache --show-stats`）。

✅ 最终判定：V1–V4 全部满足 → spike 成功；否则按 §4.3 止损记录。

---

## 7. 风险登记

| 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- |
| DEPS 依赖下载受限速 | 中 | 拖半天–1 天 | 复用 aria2 多连接 + 换 IP（Chromium 本体已是本地，不涉及 14 GB） |
| `ppapi_proxy` 编译爆炸（错误几百条） | 中 | 超时 | 先只编 `ppapi/proxy:proxy`，按错误分桶（include/type/API），一天一桶 |
| sccache 与 Chromium PDB 不兼容 | 中 | 无法用缓存 | 先关闭 `cc_wrapper` 做对照；必要时只用 sccache 编 `.obj`、link 不用 |
| Electron 40 的 Node v24 工具链要求变化 | 低 | 构建中断 | 沿用 138 的 VS/SDK 组合；必要时按 Electron 40 文档补组件 |
| 144 的 `base/` API 漂移（span/value/logging） | 中 | 编译错误 | 先跑一遍 `ppapi_proxy` 拿全量错误清单，再批量修 |
| 出帧后外围功能缺失被误判为失败 | 低 | 沟通成本 | 明确 V3/V4 不含剪贴板/代理/全屏 |

---

## 8. 交付物

1. `D:\electron-build-144\cr\src`（可重复构建的树）
2. `out\Testing\electron.exe` + 两张截图（button / FlxInvaders）
3. **patch 集**：`vendor.patch`（新增文件清单）+ `adapt-144.patch`（IPC 适配修改）
4. 文档更新：runbook 增加"144 段"、评估文档标注"已实测"
5. sccache 命中率报告

---

## 9. 复用清单（138 已有，直接搬）

| 资产 | 位置 |
| --- | --- |
| 87 Flash 私有层移植（14 项漂移修法） | runbook §10 |
| trace 埋点（`ppapi-trace.log` / `ppapi-ifaces.log`） | runbook §9.3 |
| 测试页与 `.cmd` 启动器 | `.cache/electron19/app`、`run-flash2.cmd` |
| aria2 下载脚本与 alternates 技巧 | runbook §4、§5.2 |
| 四道注册门补丁 | runbook §8 |

---

## 10. 预算

| 阶段 | 工作日 | 累计 |
| --- | --- | --- |
| 环境 + 源码下载 | 2 | D2 |
| vendor + gn gen | 2 | D4 |
| ppapi_proxy 适配 | 4 | D8 |
| renderer/插件进程适配 | 3 | D11 |
| 链接 + 注册门 + init | 2 | D13 |
| 出帧 + 收尾 + patch | 2 | D15 |

**硬止损**：D10（ppapi_proxy 未通过即停）。
