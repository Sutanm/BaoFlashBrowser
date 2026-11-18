# Chromium 140 / Electron 38 原生 PPAPI Flash 复活手册（AI 二次实现版）

> **目标读者**：另一个 AI 代理（或工程师），要从 138 的 PPAPI 代码出发，在 **Chromium 140 + Electron v38** 上把原生 Flash 重新跑起来，并输出一帧真实 SWF 画面。
> **本文性质**：可执行 runbook + 逐文件清单 + 错误字典。**每一步都有判定标准**；未通过不要进下一步。
> **实测状态（2026-11-17）**：✅ 已完成。Flash 29.0.0.171 在 Chromium 140 上完整渲染 `FlxInvaders.swf`（`interactiveFrames=3`，画面为真实游戏）。
> 背景：[`2026-11-15-forward-version-feasibility.md`](2026-11-15-forward-version-feasibility.md)（可行性/历程）、[`2026-11-14-flash-port-ai-runbook.md`](2026-11-14-flash-port-ai-runbook.md)（138 版手册）。

---

## 0. 给 AI 的硬约定（照做，别自行发挥）

1. **顺序执行**：§3→§13 是有依赖的，跳步会得到无法定位的链接/运行期错误。
2. **每条命令先看退出码**。Windows 上被强杀表现为 `[exit code: 1]` 但无错误输出，重跑即可。
3. **改文件前先读**：本文给的都是"精确字符串替换"，替换前先用 `Select-String`/`grep` 确认原文存在；替换后用同样的方式确认新内容。
4. **禁止按命令行正则批量杀进程**：`Get-CimInstance Win32_Process | Where CommandLine -match ... | Stop-Process` 会匹配到你自己的 shell。只按 PID 或按 `ExecutablePath` 精确匹配。
5. **并行度**：本机 32 GB 内存，`content/browser` 阶段 `-j 6` 是上限；默认并行度会 `LLVM ERROR: out of memory`。
6. **不要给 ppapi 子进程转发 `--enable-logging`**：140 的 `child_process_launcher_helper_win.cc:79` 有 `CHECK(!cmd_line->HasSwitch(kEnableLogging))`，会直接崩。
7. **不要放宽 `viz` 的 CHECK**（例如删掉 `transferable_resource.cc:42` 的 `CHECK(shared_image)`）——那是掩盖空指针，不是修复。
8. **Flash 版本**：默认用 **29.0.0.171**（项目自带 `plugins/win64/pepflashplayer64.dll`）。34.0.0.380 是魔改版，带 EOL 时间炸弹（"当前版本不再受支持"）。
9. 本文所有行号以 **Chromium 140.0.7339.41 / Electron v38.0.0** 为准；换版本后行号会漂，以函数名/唯一字符串为准。

---

## 1. 目标与分阶段验收

最终目标：Electron 单内核进程里，网页上的 `<embed type="application/x-shockwave-flash">` **创建实例并渲染帧**。

| 阶段 | 验收标志 | 验证方式 |
| --- | --- | --- |
| A 源码 | `src` = Chromium 140，`src/electron` = Electron v38 | `git describe --tags` / `cat electron/package.json` |
| B 构建开关 | `enable_ppapi=1`、`enable_plugins=true` | `gn args out/Testing --list=enable_ppapi`；`gen/ppapi/buildflags/buildflags.h` 里 `ENABLE_PPAPI() (1)` |
| C vendor | `ppapi/` 有 1470 个文件、`content/renderer/pepper/` 有 139 个 | `Get-ChildItem -Recurse -File \| Measure-Object` |
| D 编译 | `ninja -C out/Testing -j 6 electron` 退出码 0 | 退出码 + `out/Testing/electron.exe` 存在 |
| E exe 可跑 | `electron.exe --version` → `v38.0.0` | 直接运行 |
| F 插件注册 | 测试页 `navigator` 报告里 `pepperProcess=true` | §12 harness |
| G Flash 初始化 | 日志出现 `initialize_module returned 0` | §12 harness 的 `chrome.log` |
| H 出帧 | 截图出现**真实 SWF 内容**（不是白屏/不是 EOL 弹窗），`interactiveFrames >= 2` | §12 harness |

> 实测经验：G 之前的每个阶段几乎都会先崩一次（见 §13 错误字典）；`H` 的最后一公里是 **FlushAck**（§11），没有它只会出现"一帧纯白、digest 三次不变"。

---

## 2. 已验证组合与环境

| 项 | 值 |
| --- | --- |
| Chromium | `140.0.7339.41` |
| Electron | `v38.0.0`（源码在 `src/electron`） |
| Node | `v22.18.0` |
| OS | Windows 10/11 x64 |
| 编译器 | VS2022 BuildTools（`C:\BuildTools`），`DEPOT_TOOLS_WIN_TOOLCHAIN=0` |
| Python | 3.11 |
| 加速 | sccache（`cc_wrapper="D:/tools/sccache/sccache.exe"`，`SCCACHE_DIR=D:\sccache`） |
| Flash | `plugins/win64/pepflashplayer64.dll`（29.0.0.171） |
| 工作树 | `D:\electron-build-140\cr\src`（构建），`D:\electron-build\cr\src`（138 参考/vendor 源） |
| 磁盘 | 构建输出 `out/Testing` 约 10–12 GB；全量 tree 需要 ≥120 GB 空闲 |

**实测规模（2026-11-17）**：新增 **1662** 个文件（ppapi 1470 + pepper 宿主 203 + …）、手工修改 **63** 个文件、Flash 私有 PPAPI **51** 个文件 + 8 处接线；总耗时 **约 2.2 天 / 18–20 工时**。

`out/Testing/args.gn`（最终形态）：

```gn
import("//electron/build/args/testing.gn")
enable_plugins = true
symbol_level = 1
cc_wrapper = "D:/tools/sccache/sccache.exe"
```

---

## 3. 阶段 A：源码与工具链

1. 取 Chromium 140 源码 + `src/electron`（Electron v38），`gclient sync` 到可编译状态。
2. 确认 `buildtools/win/gn.exe`、`third_party/ninja/ninja.exe` 存在；没有就用 138 树里的二进制（版本兼容）或 `buildtools\win\gn.bat` 包装。
3. `build/vs_toolchain.py` 的必需文件清单里补 `('dbghelp.dll', True)`（Win 上缺它会 SyncToolchain 失败）。

**✅ 判定**：`gn --version` 与 `ninja --version` 都能输出。

---

## 4. 阶段 B：GN / 构建开关（把 PPAPI 重新编进去）

| 文件 | 改动 |
| --- | --- |
| `ppapi/buildflags/buildflags.gni` | `enable_ppapi = enable_plugins && !is_fuchsia`（需要 `import("//content/public/common/features.gni")`） |
| `build/config/nacl/config.gni`、`build/config/nacl/rules.gni` | 新建 NaCl stub（`is_nacl=false`） |
| `components/nacl/features.gni`、`components/nacl/toolchain.gni`、`components/nacl/target_cpu.gni`、`components/nacl/common/BUILD.gn` | 同上（这套目录在 140 里已被删，需最小化补回，供 `ppapi` 依赖判定） |
| `build/build_config.h` | `BUILDFLAG_INTERNAL_IS_NACL() (0)`；`IS_MINIMAL_TOOLCHAIN` 兼容定义（插在 ANDROID 块之后） |
| `build/config/unsafe_buffers_paths.txt` | 加 `-ppapi/` 豁免（PPAPI 代码是 138 的，写满了裸指针） |
| 所有 vendored 的 `.cc` | 个别文件需要 `#pragma allow_unsafe_buffers` / `allow_unsafe_libc_calls`（编译报错时逐个加） |

**✅ 判定**：`gn gen out/Testing --args='import("//electron/build/args/testing.gn") enable_plugins=true symbol_level=1'` 成功，且生成的 `gen/ppapi/buildflags/buildflags.h` 里 `ENABLE_PPAPI() (1)`。

---

## 5. 阶段 C：从 138 vendor（这是工程量最大的一步，但纯搬运）

把 138 树里的以下内容**整目录复制**到 140 树（同名覆盖前先备份）：

| 目录/文件 | 文件数（实测） | 说明 |
| --- | --- | --- |
| `ppapi/` | **1470** | 整个 PPAPI 实现（140 已全删） |
| `content/renderer/pepper/` | **139** | 渲染侧 pepper 宿主/插件实现 |
| `content/browser/renderer_host/pepper/` | **55** | 浏览器侧 pepper 宿主 |
| `content/ppapi_plugin/` | **9** | 插件进程入口/线程 |
| `content/common/pepper_plugin_list.{h,cc}`、`content/common/pepper_plugin.mojom` | 3 | 插件列表解析 + mojo |
| `content/browser/ppapi_plugin_process_host.{h,cc}`、`ppapi_plugin_sandboxed_process_launcher_delegate.*` | 4 | 插件进程宿主 |
| `ipc/` 的 legacy 部分 | 见 §7 | 消息框架 |

子模块/DEPS 噪声：`git status` 会显示 `third_party/{v8,ffmpeg,webrtc,...}` 变更，那是 DEPS 状态，**不要提交**。

**✅ 判定**：文件数量对得上（§1 阶段 C），且 `grep -r "kPpapiInProcess" content/public/common` 能命中。

---

## 6. 阶段 D：数据结构恢复（编译的前置）

| 文件 | 补什么 |
| --- | --- |
| `content/public/common/webplugininfo.h` | `WebPluginInfo::PluginType`（`PLUGIN_TYPE_PEPPER_IN_PROCESS` / `_OUT_OF_PROCESS` / `BROWSER_*`）、`pepper_permissions` |
| `content/public/common/content_plugin_info.{h,cc}` | `EntryPoints`（`initialize_module/get_interface/shutdown_module`）、`is_internal`、`is_out_of_process`、`permissions`、`ToWebPluginInfo()` |
| `content/public/common/content_switches.{h,cc}` | 7 个开关：`kPpapiInProcess`、`kPpapiPluginProcess`、`kPpapiPluginLauncher`、`kPpapiStartupDialog`、`kPpapiSubpixelRenderingSetting`、`kPpapiAntialiasedTextEnabled`、`kRegisterPepperPlugins` |
| `content/public/browser/content_browser_client.h` + `content/browser/pepper_browser_client_compat.cc` | 4 个钩子实现：`GetExternalBrowserPpapiHost`、`AllowPepperSocketAPI`、`IsPluginAllowedToCallRequestOSFileHandle`、`IsPluginAllowedToUseDevChannelAPIs`（**返回 true**：Electron 138 上这些也是 false，等于顺手比 138 更完整） |
| `content/public/renderer/content_renderer_client.h` + `content/renderer/pepper/pepper_client_compat.cc` | `IsExternalPepperPlugin`、`IsPluginAllowedToUseCameraDeviceAPI`（返回 true）+ 5 个 pepper 钩子默认实现 |

**⚠️ 关键坑（会让插件误走进程内路径并 DCHECK 崩溃）**：`ContentPluginInfo::ToWebPluginInfo()` 里，
138 的写法先按 pepper 设 `type`，后面又有一行把它覆盖成 `PLUGIN_TYPE_BROWSER_PLUGIN`。必须改成：

```cpp
if (is_internal) {
  info.type = WebPluginInfo::PLUGIN_TYPE_BROWSER_INTERNAL_PLUGIN;
} else {
  info.type = is_out_of_process ? WebPluginInfo::PLUGIN_TYPE_PEPPER_OUT_OF_PROCESS
                                : WebPluginInfo::PLUGIN_TYPE_PEPPER_IN_PROCESS;
}
```

**✅ 判定**：`content/public/common:common` 目标编译通过。

---

## 7. 阶段 E：legacy IPC 恢复（140 删得最彻底的一层）

140 删掉了 `IPC::MessageFilter` 与 routed 宏体系，但 `IPC::ChannelMojo`/`SyncChannel` 骨架还在。需要补回：

| 文件 | 补什么 |
| --- | --- |
| `ipc/message_filter.{h,cc}`、`ipc/ipc_logging.h`、`ipc/ipc_sync_message_filter.{h,cc}`、`ipc/struct_constructor_macros.h`、`ipc/ipc_test_sink.*` | 整体从 138 vendor |
| `ipc/ipc_message_macros.h` | 追加 138 的 `IPC_MESSAGE_ROUTED*` / `IPC_BEGIN_MESSAGE_MAP` 等宏块（约 15.6 KB，插在 `#endif  // IPC_IPC_MESSAGE_MACROS_H_` 之前） |
| `ipc/ipc_channel_proxy.{h,cc}` | `AddFilter/RemoveFilter/OnAddFilter`、`filters_/pending_filters_`、真实 `TryFilters`、生命周期通知 |
| `ipc/ipc_sync_channel.{h,cc}` | `CreateSyncMessageFilter()`（用 `sync_context()->shutdown_event()`） |

**✅ 判定**：`ipc` 目标编译通过；`content/common/pepper_plugin.mojom` 出现在 `content/common/BUILD.gn` 的 `mojo_bindings` 里。

---

## 8. 阶段 F：浏览器侧接线（插件进程能起来的关键）

按"消息从渲染进程到插件进程"的顺序补：

1. **`content/browser/plugin_service_impl.cc`**
   - `RegisterPlugins()` 里补 `ComputePepperPluginList(&plugins_);`（解析 `--register-pepper-plugins`）；
   - 补 `OpenChannelToPpapiPlugin` / `FindOrStartPpapiPluginProcess` / `FindPpapiPluginProcess` / `CountPpapiPluginProcessesForProfile`；
   - `GetRegisteredPluginInfo`：找不到时用 `GetPluginInfoByPath` + `MakePepperPluginInfo` 现场构造（Flash 是命令行插件，注册得晚）。
2. **`content/browser/ppapi_plugin_process_host.{h,cc}`**
   - `Send()` → `process_->GetHost()->Send(message)`；
   - `OnMessageReceived` 先给 `host_impl_->message_filter()`，再走 IPC 消息表；
   - `PROCESS_TYPE_PPAPI_PLUGIN_DEPRECATED`（140 枚举改名了，带 `_DEPRECATED` 后缀）；
   - `OnChannelConnected` 里加去重（`load_plugin_sent_`），否则 Flash 会被 `PpapiMsg_LoadPlugin` 加载两次 → 二次 `initialize_module` 崩溃（0xC0000409）。
3. **`content/browser/renderer_host/pepper/pepper_renderer_connection.cc`**
   - `OpenChannelToPpapiPluginCallback::GetPpapiChannelInfo()`：我们不再作为 legacy `BrowserMessageFilter` 运行，`PeerHandle()` 恒空 → 回退 `RenderProcessHost::FromID(...)->GetProcess().Handle()`，否则插件侧 `DCHECK(base::kNullProcessId != renderer_pid)` 崩。
4. **`content/browser/renderer_host/render_frame_host_impl_ppapi_support.{h,cc}`**（vendor 138）+ **`render_frame_host_impl_interface_binders.cc`**
   - 在 `SetUpMojoConnection()` 里注册：
     ```cpp
     associated_registry_->AddInterface<mojom::PepperHost>(base::BindRepeating(
         [](RenderFrameHostImpl* impl, mojo::PendingAssociatedReceiver<mojom::PepperHost> receiver) {
           impl->GetPpapiSupport().Bind(std::move(receiver));
         }, base::Unretained(this)));
     ```
   - 不注册 → 渲染进程的同步 `OpenChannelToPepperPlugin` **永远挂起**（这是我们最早的死锁）。
5. **`content/browser/renderer_host/render_process_host_impl.{h,cc}`**
   - 加 `pepper_renderer_connection_` 成员 + 访问器，构造参数 `(GetID().GetUnsafeValue(), PluginServiceImpl::GetInstance(), GetBrowserContext(), GetStoragePartition())`；
   - `OnMessageReceived` 开头把消息先给 `pepper_renderer_connection_->OnMessageReceived(msg)`。
6. **`content/browser/browser_child_process_host_impl.{h,cc}`**
   - 补 `OnMessageReceived` override → `delegate_->OnMessageReceived(message)`（140 删了这个 override，子进程消息会被静默丢弃）；
   - `OnChannelConnected` 里补 `delegate_->OnChannelConnected(peer_pid)`（否则插件宿主的 `PpapiMsg_LoadPlugin` 永不发出）；
   - `GetCoordinatorClientProcessType()` 的 switch 补 `PROCESS_TYPE_PPAPI_PLUGIN/BROKER_DEPRECATED` → `PLUGIN`（否则浏览器进程 `NOTREACHED`）。
7. **`content/common/process_type.cc`**：`GetProcessTypeNameInEnglish()` 补 ppapi 两个 case（140 改成 `_DEPRECATED` 并删了 case）。
8. **子进程通道**：`content/browser/child_process_host_impl.cc` 的 `CreateChannelMojo()` + `InitChannel()`（`channel_->Connect()`）+ `Send/OnMessageReceived/OnChannelConnected` 转发；必要时核对 `ipc_channel_mojo.cc` 的 listener 链。
9. **进程分派**：`content/app/content_main.cc` 的 `IsSubprocess()` 加 `kPpapiPluginProcess`；`content/app/content_main_runner_impl.cc` 加 `extern int PpapiPluginMain(MainFunctionParams);` 并把它加进**两张** `kMainFunctions` 表。
10. **沙箱**：`sandbox/policy/sandbox_type.cc` 的 `SandboxTypeFromCommandLine()` 对未知 `--type` 是 `NOTREACHED()`；
    最省事的修法是在 `PpapiPluginProcessHost::Init()` 里给子进程追加 `--no-sandbox`（Windows 本来就不支持 ppapi 沙箱）。

**✅ 判定**：跑测试页时出现 `--type=ppapi` 子进程、且浏览器日志有 `ppapi launched pid=...`，无 `ppapi crashed`。

---

## 9. 阶段 G：渲染侧接线（Blink 到 pepper）

1. **`content/renderer/render_frame_impl.{h,cc}`**
   - `pepper_routing_id_`、`g_routing_id_frame_map`、`GetRoutingID()`、`FromRoutingId()`、`GetPepperHost()`、`PepperPluginCreated()` 与 7 个 pepper 钩子；
   - `content/public/renderer/render_frame.h` 加 `virtual int GetRoutingID() = 0;`；
   - **`Initialize()` 里必须 `new PepperBrowserConnection(this);`**（138 在此创建；漏了会得到 `module conn=0` 并崩在空指针）；
   - `GetPepperHost()` 里判断条件不要只看 `pending_associated_interface_provider_remote_`（它被首次使用后就被 move 走了）：
     ```cpp
     if (!pepper_host_remote_.is_bound()) {
       if (!remote_associated_interfaces_ && !pending_associated_interface_provider_remote_) return nullptr;
       GetRemoteAssociatedInterfaces()->GetInterface(&pepper_host_remote_);
     }
     ```
   - **`CreatePlugin()` 补 pepper 分支**（140 只调 `OverrideCreatePlugin`）：
     ```cpp
     const std::string mime_type = params.mime_type.Utf8();
     const ContentPluginInfo* info =
         PepperPluginRegistry::GetInstance()->GetInfoForMimeType(mime_type);
     if (info) {
       bool registered = false;
       scoped_refptr<PluginModule> module(PluginModule::Create(
           this, info->ToWebPluginInfo(), std::nullopt, &registered,
           GetTaskRunner(blink::TaskType::kNetworking)));
       if (registered && module) return new PepperWebPluginImpl(module.get(), params, this);
     }
     return nullptr;
     ```
2. **`content/renderer/pepper/pepper_plugin_registry.cc`**
   - 新增 `GetInfoForMimeType(const std::string&)`（按 MIME 在 `plugin_list_` 里找）；
   - `Initialize()` 里跳过"internal 且没有 `initialize_module`"的插件（Electron 的 PDF 内部插件会被误当 pepper 预加载 → `DCHECK entry_points.initialize_module != nullptr`）。
3. **`new PepperBrowserConnection(this)`** 见上；`pepper_browser_connection.cc` 的 `GetHost()` 做空保护。
4. **`content/renderer/BUILD.gn`**：`pepper_client_compat.cc`、`web_pepper_socket_stub.cc` 入源；`content/browser/BUILD.gn`：`pepper_browser_client_compat.cc` 入源。
5. **Blink 被删 API 的替代**
   - `WebFont`：从 138 vendor `public/platform/web_font.h` + `renderer/platform/exported/web_font.cc`，按 140 API 适配（见下）；
   - `WebPepperSocket`：vendor 两个头 + 写 `web_pepper_socket_stub.cc`（桩）；
   - `CancelCompositionForPepper`：no-op。
6. **`web_font.cc` 的 140 适配**（138 原版编译不过）：
   - 去掉 `RuntimeEnabledFeatures::PlainTextPainterEnabled()` 分支（140 已常开）；
   - `Font::DeprecatedDrawText/DeprecatedWidth` → `PlainTextPainter::Shared().DrawWithoutBidi / ComputeInlineSizeWithoutBidi`；
   - `OffsetForPosition`/`SelectionRectForText` 140 没有对应实现 → 用 `TextRun::SubRun` 前缀整形自己算；
   - `StringView`/`TextRun` 用 140 的 ctor（`base::span<const UChar>`），注意 `UNSAFE_BUFFERS`，否则 `-Wunsafe-buffer-usage` 报错。
7. **gin 迁移**：140 把 `gin::Wrappable` 迁到 cppgc → `message_channel`/`plugin_object` 改基类 `gin::DeprecatedWrappable<T>`、`gin::DeprecatedWrapperInfo`，并在 `gin/public/wrappable_pointer_tags.h` 加 `kPepperMessageChannel`/`kPepperPluginObject`。
8. **图形/视频适配**（两处 140 API 变更，属"降级"）：
   - `ppb_graphics_3d_impl.cc`：`ColorBuffer::Attach/Detach` 里的 `command_buffer->SetDefaultFramebufferSharedImage()` 在 140 已删 → no-op（Stage3D 不出图）；
   - `video_decoder_shim.cc`：`CopyVideoFrameToSharedImage` 在 140 改成收 `scoped_refptr<ClientSharedImage>` → 跳过拷贝（Flash 视频黑屏）。
9. **`pepper_graphics_2d_host.cc`**（从 138 vendor 后只需 2 处 140 适配）：
   - GPU 分支：`MakeGpu(mailbox,…)` → `Make(shared_image, source, sync_token)`，并且**必须在 move 之前留一份**（见 §10 的坑）；
   - 软件分支：`MakeSoftwareSharedImage(...)` → `Make(shared_image, source, sync_token)`。

**✅ 判定**：日志出现 `module=yes registered=1`（插件模块创建成功）。

---

## 10. 阶段 H：两个"一行级"但极关键的坑

### 10.1 `Make()` 收到空的 `ClientSharedImage`（渲染进程 FATAL）

现象：`components/viz/common/resources/transferable_resource.cc:42 CHECK(shared_image)`，栈顶是
`content::PepperGraphics2DHost::PrepareTransferableResource`。

根因：140 把 `MakeGpu(mailbox…)` 合并成 `Make(shared_image…)`，但 138 的代码里 `shared_image` 在这一行之前已经被
`std::move` 进 release callback：

```cpp
// 错：先 move 再传给 Make → 空指针
*release_callback = base::BindOnce(&ReleaseTextureCallback, ..., std::move(shared_image));
*transferable_resource = viz::TransferableResource::Make(shared_image, ...);

// 对：先留一份（等价于 138 里先取 mailbox）
scoped_refptr<gpu::ClientSharedImage> resource_image = shared_image;
*release_callback = base::BindOnce(&ReleaseTextureCallback, ..., std::move(shared_image));
*transferable_resource = viz::TransferableResource::Make(resource_image, ...);
```

> 判断技巧：`chrome.log` 里 `FATAL` 后面紧跟的 `base::debug::CollectStackTrace` 帧就是调用栈，**不用加探针**。

### 10.2 Flash 只画一帧白的（`FlushAck` 缺失）

现象：`interactiveFrames=1`、三次截图 digest 完全相同、位图均匀 `0xFFFFFFFF`；
但 URLLoader 收到了完整 SWF（`bytes_total == received == SWF 大小`）、`HandleInputEvent` 也有事件。

根因：140 删了 `WebLocalFrameClient::DidCommitAndDrawCompositorFrame`，于是
`RenderFrameImpl::DidCommitAndDrawCompositorFrame()`（138 里遍历 `active_pepper_instances_` 调 `ViewInitiatedPaint()`）
整段消失 → `PepperGraphics2DHost::ViewInitiatedPaint()` 不再被调用 → 不发 `PpapiPluginMsg_Graphics2D_FlushAck`
→ **Flash 画完第一帧（清屏白）就停住等 ack**。

**已采用的终态方案（方案 A，2026-11-18 落地并验证）**：把 ack 放到"帧被 display compositor 呈现之后"。

```cpp
// pepper_graphics_2d_host.cc
void PepperGraphics2DHost::RequestFlushAckAfterPresentation() {
  if (!need_flush_ack_) return;
  need_flush_ack_ = false;                    // 由本函数负责这次 ack
  flush_ack_fallback_timer_.Start(            // 兜底：不产生帧时也要 ack
      FROM_HERE, base::Milliseconds(250),
      base::BindOnce(&PepperGraphics2DHost::OnFlushAckPresentationTimeout,
                     weak_ptr_factory_.GetWeakPtr()));
  blink::WebFrameWidget* widget = nullptr;
  if (bound_instance_ && bound_instance_->render_frame())
    widget = bound_instance_->render_frame()->GetLocalRootWebFrameWidget();
  if (widget && widget->InsertVisualStateRequest(
                    base::BindOnce(&PepperGraphics2DHost::SendFlushAck,
                                   weak_ptr_factory_.GetWeakPtr())))
    return;                                   // 呈现后回调
  SendFlushAck();                             // 无合成器：立即 ack
}
```

**必踩的坑**：`WidgetBase::InsertVisualStateRequest()` 依赖 `widget_compositor_`，而它只在浏览器调用
`RenderWidgetHostImpl::InsertVisualStateCallback()` 时**懒绑定**（`render_widget_host_impl.cc:2107`）。
不绑定的话渲染进程侧恒返回 `false`，代码会静默退化到"立即 ack"。
因此要在 `RenderFrameHostImplPpapiSupport::DidCreateOutOfProcessPepperInstance()` 里先触发一次：

```cpp
if (auto* rwh = render_frame_host_->GetRenderWidgetHost())
  rwh->InsertVisualStateCallback(base::BindOnce([](bool) {}));
```

另需 `flush_ack_owed_` 保证"呈现回调"与"兜底定时器"只发一次 ack，并让 `HasPendingFlush()` 包含它。
实测：FlxInvaders 每帧 56 次 ack 全部走呈现回调、0 次兜底；button.swf 像素与"立即 ack"版本一致。

下面是**最早的临时做法**（仅作参考，已被上面替代）：

```cpp
if (need_flush_ack_) {
  SendFlushAck();
  need_flush_ack_ = false;
}
```

终态方案（详见可行性文档 §1.14.11）：A = `WebFrameWidget::InsertVisualStateRequest()`（呈现后回调，推荐，需 false/超时兜底）；
B = 16ms 定时器；C = 把 138 的 `WidgetBase → WebFrameWidgetImpl → WebLocalFrameClient → RenderFrameImpl` 链补回（约 20 行/5 文件，2 个在 blink core）。

**✅ 判定**：`interactiveFrames >= 2` 且截图中出现 SWF 的真实内容。

---

## 11. 阶段 I：Flash 私有 PPAPI（`initialize_module` 从 -2 变 0 的关键）

140 把 **Flash 专用的 PPAPI 接口**整套删了，Flash 会因此在 `PPP_InitializeModule` 里直接返回 `PP_ERROR_FAILED (-2)`。
需要从 138 vendor **51 个文件**并补 8 处接线：

**文件（51）**
- `ppapi/c/private/`：`ppb_flash.h`、`ppb_flash_clipboard.h`、`ppb_flash_file.h`、`ppb_flash_font_file.h`、`ppb_flash_fullscreen.h`、`ppb_flash_menu.h`、`ppb_flash_message_loop.h`、`ppb_flash_print.h`、`ppb_flash_drm.h`、`ppp_flash_browser_operations.h`
- `ppapi/proxy/`：`flash_{clipboard,drm,file,font_file,fullscreen,menu}_resource.{h,cc}`、`flash_resource.{h,cc}`、`ppb_flash_message_loop_proxy.{h,cc}`、`serialized_flash_menu.{h,cc}`
- `ppapi/shared_impl/`：`flash_clipboard_format_registry.{h,cc}`、`ppb_flash_font_file_shared.h`、`ppp_flash_browser_operations_shared.h`
- `ppapi/thunk/`：`interfaces_ppb_private_flash.h` + 10 个 `*_thunk.cc` + 8 个 `*_api.h`

**接线（8 处）**

| 位置 | 改动 |
| --- | --- |
| `ppapi/{proxy,thunk,shared_impl}/BUILD.gn` | 加 20 条源文件 |
| `ppapi/shared_impl/singleton_resource_id.h` | 加 `FLASH_CLIPBOARD/FLASH_FILE/FLASH_FULLSCREEN/FLASH_SINGLETON_ID` |
| `ppapi/thunk/resource_creation_api.h` + `ppapi/proxy/resource_creation_proxy.{h,cc}` | 加 `CreateFlashDRM/FontFile/Menu/MessageLoop` |
| `ppapi/shared_impl/resource.h` | `FOR_ALL_PPAPI_RESOURCE_APIS` 里加 8 个 Flash API getter（否则 `AsPPB_Flash_*_API` 的 `override` 编译不过） |
| `ppapi/shared_impl/api_id.h` | 加 `API_ID_PPB_FLASH_MESSAGELOOP` |
| `ppapi/thunk/thunk.h` | `#include "ppapi/thunk/interfaces_ppb_private_flash.h"` |
| `ppapi/proxy/interface_list.{h,cc}` | **整文件换成 138 版**（含 Flash 的 `PROXIED_IFACE` 注册；这是 Flash 能拿到 `PPB_Flash*` 的前提） |
| `ppapi/proxy/ppapi_messages.h`、`serialized_structs.{h,cc}`、`ppapi_param_traits.{h,cc}` | 换成 138 版（含 Flash IPC 消息与序列化） |
| `ppapi/proxy/ppb_instance_proxy.cc` + `content/renderer/pepper/pepper_plugin_instance_impl.cc` | 补 Flash singleton 分支（`FlashResource` / `FlashClipboardResource` / `FlashFileResource` / `FlashFullscreenResource`） |
| `content/renderer/pepper/pepper_in_process_resource_creation.{h,cc}` | 补 4 个 Flash 虚函数实现（`return 0`） |

**调试判据**：`ppapi/proxy/interface_list.cc` 的 `GetInterfaceForPPB()` 加一行日志，Flash 初始化时会依次请求接口；
若日志出现 `PPB interface MISSING: PPB_Flash_Clipboard` 之类的记录，就是本阶段漏了文件。

---

## 12. 阶段 J：验证 harness（可复用）

测试 app 目录只需两个文件：

```html
<!-- button.html -->
<!doctype html><style>body{margin:0}embed{display:block}</style>
<embed type="application/x-shockwave-flash" src="button.swf" width="550" height="420">
```

`main.js`（Electron）：创建 900×700 `BrowserWindow`（`webPreferences: { plugins: true, sandbox: false }`），
`loadFile('button.html')`，等 1.8s 后 `executeJavaScript` 收集 `navigator.plugins` /
`navigator.mimeTypes['application/x-shockwave-flash']` / `document.querySelectorAll('embed').length`，
再截图三次（初始 / mouseMove / mouseDown+mouseUp）并计算 `frameDigests`（sha256 前 12 位），
最后把 `report-control.json` 写到 `E19_OUT`：字段 `flashMime`、`embeds`、`frameDigests`、`interactiveFrames`、
`processes`（来自 `app.getAppMetrics()`）、`pepperProcess`。

启动脚本（**照抄，注意 `#` 与 `;`**）：

```bat
set ELECTRON_RUN_AS_NODE=
set E19_OUT=D:\electron-build\run1
set E19_MODE=control
"D:\electron-build-140\cr\src\out\Testing\electron.exe" ^
  --allow-command-line-plugins ^
  "--register-pepper-plugins=D:\...\pepflashplayer64.dll#Shockwave Flash#Shockwave Flash 29.0 r0#29.0.0.171;application/x-shockwave-flash#swf#spl" ^
  --enable-logging --log-file=D:\electron-build\run1\chrome.log --v=1 ^
  "D:\electron-build\app140"
```

**判定表**

| 字段 | 期望 |
| --- | --- |
| `pepperProcess` | `true` |
| `interactiveFrames` | `>= 2`（Flash 29 + FlxInvaders 实测 = 3） |
| `frameDigests` | 至少两个不同值 |
| 截图 | 出现 SWF 真实内容（不是白屏、不是 "当前版本不再受支持"） |
| `chrome.log` | 有 `initialize_module returned 0`、无 `ppapi crashed`、无 `CHECK failed` |

**已知陷阱**
- `--log-file` 在 138 树里会让测试挂起；140 树正常。
- 不要给 ppapi 子进程转发 `--enable-logging`（§0.6）。
- `mm.cfg`（`%APPDATA%\Macromedia\Flash Player\mm.cfg`）保持
  `SuppressDebuggerExceptionDialogs=1 / ErrorReportingEnable=0 / TraceOutputFileEnable=0 / DisableProductDownload=1`；
  想看 Flash 自己的日志再打开 `ErrorReportingEnable=1`，但那会改变行为，测完记得还原。

---

## 13. 错误字典（现象 → 根因 → 修法）

| # | 现象 | 根因 | 修法 |
| --- | --- | --- | --- |
| 1 | `electron.exe: bad option: --type=ppapi` | 140 的 `content_main.cc` `IsSubprocess()` 不认 ppapi | 加 `type == switches::kPpapiPluginProcess` |
| 2 | 插件子进程 `STATUS_BREAKPOINT (0x80000003)` | `SandboxTypeFromCommandLine()` 对 `--type=ppapi` 走 `NOTREACHED()` | `PpapiPluginProcessHost::Init()` 给子进程追加 `--no-sandbox` |
| 3 | 浏览器进程 `FATAL ... GetCoordinatorClientProcessType NOTREACHED` | 进程类型 switch 缺 ppapi | 补 `PROCESS_TYPE_PPAPI_PLUGIN/BROKER_DEPRECATED → PLUGIN` |
| 4 | 插件进程 `DCHECK entry_points.initialize_module != nullptr` | `PepperPluginRegistry::Initialize()` 把 Electron 的 PDF 内部插件当 pepper 预加载 | 跳过 `is_internal && !initialize_module` 的插件 |
| 5 | 渲染侧 `registry info=no`（找不到 Flash） | `--register-pepper-plugins` 没传给渲染进程 | `PropagateBrowserCommandLineToRenderer` 补 `kRegisterPepperPlugins` |
| 6 | `module conn=0` 后崩溃 | `RenderFrameImpl::Initialize()` 里没有 `new PepperBrowserConnection(this)` | 补上（138 原位置） |
| 7 | `GetPepperHost: no associated interface provider` | 只看 `pending_associated_interface_provider_remote_`，但它已被消费 | 同时检查 `remote_associated_interfaces_` |
| 8 | 渲染进程卡死在同步 `OpenChannelToPepperPlugin` | 帧的 associated registry 里没有 `mojom::PepperHost` | `SetUpMojoConnection()` 里注册并 `GetPpapiSupport().Bind(...)` |
| 9 | 浏览器收不到插件消息（`module=no` 后再崩） | `BrowserChildProcessHostImpl::OnMessageReceived` override 被 140 删了 | 补 override 转发给 `delegate_` |
| 10 | 插件收不到 `PpapiMsg_LoadPlugin` | `OnChannelConnected` 没有转发给 delegate | 补 `delegate_->OnChannelConnected(peer_pid)` |
| 11 | 插件侧 `DCHECK renderer_pid != kNullProcessId` | `GetPpapiChannelInfo` 的 `PeerHandle()` 在非 filter 场景恒空 | 回退 `RenderProcessHost::FromID(...)->GetProcess().Handle()` |
| 12 | 插件二次 `initialize_module` 后 `0xC0000409` | 重复 `OnChannelConnected` → 重复 LoadPlugin | 浏览器侧 `load_plugin_sent_` 去重 + 插件侧 `OnLoadPlugin` 已加载则忽略 |
| 13 | `initialize_module returned -2` | 缺 Flash 私有 PPAPI（51 文件/8 处接线） | 见 §11 |
| 14 | `transferable_resource.cc:42 CHECK(shared_image)` | `Make` 前 `shared_image` 已被 move | 先 `resource_image = shared_image` 再 move（§10.1） |
| 15 | 出帧但全白、digest 三次一样 | 缺 `Graphics2D FlushAck`（140 删了帧级回调） | 见 §10.2 |
| 16 | 3D 内容黑屏 | `SetDefaultFramebufferSharedImage` 被 140 删 | 降级为 no-op（功能债，不影响 2D） |
| 17 | Flash 视频黑屏 | `CopyVideoFrameToSharedImage` 140 改收 `ClientSharedImage` | 跳过拷贝（功能债） |
| 18 | `gin::Wrappable` 编不过（`operator new` deleted） | 140 迁到 cppgc | 改 `gin::DeprecatedWrappable` + `DeprecatedWrapperInfo` |
| 19 | `-Wunsafe-buffer-usage` 一片红 | PPAPI 是 138 代码 | `unsafe_buffers_paths.txt` 加 `-ppapi/`，必要时文件级 `#pragma allow_unsafe_buffers` |
| 20 | `LLVM ERROR: out of memory` | 并行度过高 | `-j 6` |
| 21 | `lld-link: failed to write output './electron.exe': permission denied` | 上次测试的 electron.exe 还活着 | 按 `ExecutablePath` 精确杀进程后重链 |
| 22 | `child_process_launcher_helper_win.cc:79 Check failed: !cmd_line->HasSwitch(kEnableLogging)` | 你把 `--enable-logging` 转发给了子进程 | 别转发（§0.6） |
| 23 | `only virtual member functions can be marked 'override'`（Flash resource） | `FOR_ALL_PPAPI_RESOURCE_APIS` 里没有 Flash API | 见 §11 的 `resource.h` 改动 |
| 24 | `PPBFlash_DrawGlyphs_Params` 链接未定义 | `serialized_structs.cc` 的符号没被链进来 | 把 ctor/dtor 改成头文件内 inline |
| 25 | 编译报 Chromium lint（raw_ptr / 内联虚函数） | 140 的 lint 更严 | 虚函数定义移出类、成员用 `raw_ptr`、成员放在 `WeakPtrFactory` 之前 |

---

## 14. 已知功能债（不影响 2D Flash 出帧）

| 项 | 140 的删除 | 当前处理 | 建议 |
| --- | --- | --- | --- |
| Stage3D 默认帧缓冲 | `CommandBufferProxyImpl::SetDefaultFramebufferSharedImage` | `Attach/Detach` no-op | 用 140 的 `SharedImageInterface` 重写绑定 |
| 视频帧拷贝 | `CopyVideoFrameToSharedImage` 改收 `ClientSharedImage` | 跳过拷贝 | 让 shim 持有 `ClientSharedImage` 并用 `VideoFrame` 作为源 |
| `PPB_WebSocket` | Blink `WebPepperSocket` 删除 | 桩（Connect 直接失败） | 用 `network::mojom::WebSocket` 自建，或移植 138 的 blink 实现 |
| `PPB_BrowserFont_Trusted` | Blink `WebFont` 删除 | **已用 138 原生 `web_font.cc` 恢复**（真实度量+绘制） | — |
| `CancelCompositionForPepper` | Blink 删除 | no-op | 低优先级（仅影响 IME） |
| 4 个策略钩子 | 基类默认 false（138 也是 false） | 已改为 true | 比 138 更完整 |

---

## 15. 命令速查

```powershell
$src = 'D:\electron-build-140\cr\src'
$py  = 'C:\Users\95470\AppData\Local\Programs\Python\Python311'
$env:PATH = "$py;$py\Scripts;$src\buildtools\win;D:\tools\sccache;" + $env:PATH
$env:DEPOT_TOOLS_WIN_TOOLCHAIN='0'; $env:vs2022_install='C:\BuildTools'
$env:SCCACHE_DIR='D:\sccache'; $env:SCCACHE_CACHE_SIZE='60G'
cd $src

# 生成（改了 BUILD.gn 才需要）
& "$src\buildtools\win\gn.exe" gen out/Testing --args='import("//electron/build/args/testing.gn") enable_plugins=true symbol_level=1 cc_wrapper="D:/tools/sccache/sccache.exe"'

# 编译（content/browser 阶段必须 -j 6）
& "$src\third_party\ninja\ninja.exe" -C out/Testing -j 6 electron

# 单文件快验（比全量快一个数量级）
& "$src\third_party\ninja\ninja.exe" -C out/Testing -j 2 obj/content/renderer/renderer/render_frame_impl.obj

# 运行测试（见 §12）
cmd /c D:\electron-build\run-flash-140.cmd
```

---

## 16. 复现清单（照着勾）

- [ ] §3 工具链可用（gn/ninja/vs_toolchain）
- [ ] §4 `enable_ppapi=1`、`ENABLE_PPAPI() (1)`
- [ ] §5 140 文件数对得上（ppapi 1470 / renderer pepper 139 / browser pepper 55 / ppapi_plugin 9）
- [ ] §6 数据结构恢复 + `ToWebPluginInfo` 类型修正
- [ ] §7 IPC legacy 恢复（含 routed 宏）
- [ ] §8 浏览器侧 10 处接线（含 3 处进程类型 / interface binder / RPH connection）
- [ ] §9 渲染侧接线（含 `CreatePlugin` pepper 分支、`PepperBrowserConnection`、WebFont）
- [ ] §10 两个一行级坑（`Make` 顺序、`FlushAck`）
- [ ] §11 Flash 私有 PPAPI 51 文件 + 8 处接线
- [ ] §12 harness 跑通：`pepperProcess=true`、`initialize_module returned 0`
- [ ] §12 出帧：`interactiveFrames>=2` 且截图是真实 SWF
- [ ] 用 **Flash 29.0.0.171** 验证（34 魔改版有 EOL 时间炸弹）
