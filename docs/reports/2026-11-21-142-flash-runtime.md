# 2026-11-21 · Chromium 142 / Electron 39 上原生 PPAPI Flash 出帧报告

> 目的：验证 142 的 PPAPI 移植在**运行期**是否真的可用（编译通过 ≠ 能跑）。
> 环境：Chromium `142.0.7444.52` / Electron `v39.0.0` / Flash `29.0.0.171`（win64，`plugins\win64\pepflashplayer64.dll`）
> 树：`D:\electron-build-142\cr\src`，分支 `bao/142-linux`，基线 tag `bao-v142-ppapi-builds`
> 方法：`--register-pepper-plugins` 加载 Flash，被动探针（只监听生命周期，不注入 JS、不截图），GDI 抓屏留证
> 结论：**出帧**。见 §一。

---

## 一、结论

![FlxInvaders 在 Chromium 142 上](../../blog/assets/flx-invaders-on-chromium142.png)

FlxInvaders 的标题文字、5 行像素入侵者（蓝/青/绿/黄/红）、玩家飞船、地面掩体全部由 **Flash 29.0.0.171 在 Chromium 142.0.7444.52 内渲染**。

启动命令（与 140 的 `dist-140/run.bat` 完全同构）：

```bat
set ELECTRON_RUN_AS_NODE=
start "" electron.exe --no-sandbox --allow-command-line-plugins ^
  "--register-pepper-plugins=<dll>#Shockwave Flash#Shockwave Flash 29.0 r0#29.0.0.171;application/x-shockwave-flash#swf#spl" ^
  "<probe-dir>"
```

被动探针结果：

```
[ev] did-start-loading
[ev] did-finish-load
[ev] did-stop-loading
[ev] survived 30000ms
exit=0   elapsed=30.5s
```

**渲染进程未崩溃**，30 秒内稳定出帧。

---

## 二、根因：142 把 legacy IPC 的「发送端」删空了

编译期的最后一道墙是 `PpapiPluginProcessHost::RequestPluginChannel()` 里 `Send(msg)` 返回 `false`。追下去发现不是我们的移植写错，而是 142 上游**整个发送路径被删除**：

### 2.1 最直接的一处：`Send` 被换成 `return false`

```cpp
// ipc/ipc_message_pipe_reader.cc（Chromium 142 原样）
bool MessagePipeReader::Send(std::unique_ptr<Message> message) {
  return false;          // ← 140 里这里有 ~20 行完整实现
}
```

### 2.2 配套被删的三处

| 位置 | 142 的状态 |
| --- | --- |
| `ipc/ipc.mojom` 的 `Channel` 接口 | **没有 `Receive(Message)` 方法**，也没有 `feature kMojoIpcChannelReceive` |
| `ipc_channel_mojo.cc` 的 `ReadFromMessageAttachmentSet` | 整个函数删除 |
| `ipc_channel_mojo.cc` 的 `WriteToMessageAttachmentSet` | 整个函数删除 |

也就是说：**142 的 legacy IPC 通道只能收、不能发**（`ChannelMojo::OnMessageReceived` 作为死代码残留）。这比我此前对可行性文档里「144 会删掉 legacy IPC 发送能力」的判断**提前了两个版本**。

### 2.3 为什么恢复成本很低

三个关键设施在 142 里**完好**，所以不用 vendor 140 的整套 `ipc_message_utils.h`：

| 设施 | 142 状态 |
| --- | --- |
| `mojo::StructTraits<IPC::mojom::MessageDataView, IPC::MessageView>` typemap | ✅ `ipc/message_mojom_traits.{h,cc}` 在，`ipc/BUILD.gn` 的 `cpp_typemaps` 配置在 |
| `MessageAttachment::CreateFromMojoHandle` / `TakeMojoHandle` | ✅ 在 |
| `MessageAttachment::Type` 与 `mojo::native::SerializedHandleType` 的枚举 | ✅ **枚举项与顺序完全一致**（`MOJO_HANDLE, PLATFORM_FILE, WIN_HANDLE, MACH_PORT, FUCHSIA_HANDLE`），`static_cast` 即可 |
| `friend class ChannelMojo;` | ✅ 早已存在（所以能碰 `Message::attachment_set()`） |

---

## 三、恢复的 5 个文件（commit `a206e423469aa`）

| # | 文件 | 改动 |
| --- | --- | --- |
| 1 | `ipc/ipc.mojom` | 加回 `feature kMojoIpcChannelReceive` + `[UnlimitedSize, RuntimeFeature=...] Receive(Message message);` |
| 2 | `ipc/ipc_message_pipe_reader.h` | 声明 `void Receive(MessageView message) override;` |
| 3 | `ipc/ipc_message_pipe_reader.cc` | 恢复 `Send()`；新增 `Receive()`；补 `#pragma allow_unsafe_buffers`（142 的 `-Wunsafe-buffer-usage` 是 error） |
| 4 | `ipc/ipc_channel_mojo.h` | 声明两个静态序列化方法 |
| 5 | `ipc/ipc_channel_mojo.cc` | 实现 `ReadFromMessageAttachmentSet` / `WriteToMessageAttachmentSet` |

发送侧关键实现：

```cpp
bool MessagePipeReader::Send(std::unique_ptr<Message> message) {
  if (!message || !message->IsValid()) return false;
  std::optional<std::vector<mojo::native::SerializedHandlePtr>> handles;
  if (ChannelMojo::ReadFromMessageAttachmentSet(message.get(), &handles) != MOJO_RESULT_OK)
    return false;
  if (!sender_.is_bound()) return false;
  base::span<const uint8_t> bytes(
      static_cast<const uint8_t*>(message->data()), message->size());
  sender_->Receive(MessageView(bytes, std::move(handles)));
  return true;
}
```

> 注意 `Pickle::size()` 返回的是 `header_size_ + payload_size`（**含 pickle 头**），所以 `Message(data, size)` 的对端重建是自洽的 —— 这一点我一度怀疑是线上格式损坏，实测排除。

---

## 四、完整链路验证（6 步全通）

```
[ppdbg] registered plugins: 3
[ppdbg]   plugin path=...\pepflashplayer64.dll oop=1 mimes=1     ← ① 插件注册（OOP）
[ppdbg] PepperHost registered on frame registry                   ← ② mojo binder 生效
[ppdbg] GetPlugins -> all=3 / send name=Shockwave Flash            ← ③ 插件列表下发渲染进程
[ppdbg] ChildProcessHostImpl::Send type=65969 ok=1                 ← ④ 浏览器→插件 IPC 通了（昨天是 0）
[ppdbg] CreateChannel send=1
[ppdbg] ChannelMojo::OnMessageReceived type=66238                  ← ⑤ 插件→浏览器回包
[ppdbg] OnRendererPluginChannelCreated                            ← ⑥ 插件建立到渲染进程的通道
```

`<embed>` 侧也确认：

```json
"embeds": [{"type":"application/x-shockwave-flash","w":"800","h":"600"}]
"mimeTypes": [..., "application/x-shockwave-flash -> Shockwave Flash"]
```

---

## 五、探针方法论：三个把人带偏的坑

这次排查最耗时的部分不是改代码，而是**测量手段本身在骗人**。

### 5.1 `ELECTRON_RUN_AS_NODE=1` 是环境级全局变量

本机 shell 里带着这个变量，electron 会以 **Node 模式**启动，把 Chromium 参数当非法参数：

```
electron.exe: bad option: --no-sandbox
```

表现是「进程秒退、无窗口、无日志」。**每次启动前必须 `Remove-Item Env:ELECTRON_RUN_AS_NODE`**（`run.bat` 里对应 `set ELECTRON_RUN_AS_NODE=`）。

### 5.2 含空格的插件名会被参数拆分

```
# 错误（PowerShell 不自动加引号，参数被空格切开）
--register-pepper-plugins=...dll#Shockwave Flash#...

# 现象
Unable to find Electron app at ...\Flash#Shockwave
```

必须走 `.bat` + `start "" "..."` 让 cmd 处理引号。

### 5.3 `executeJavaScript` + `capturePage` 会弄崩「主线程正忙」的渲染进程

第一版探针在 Flash 忙 62 次同步 IPC 时调用 `executeJavaScript`（5 s 超时）和 `capturePage`，结果：

```
[ev] render-process-gone {"reason":"crashed","exitCode":-36861}
[pixels] nonBlack=0 total=0
```

**看起来像 142 崩了，其实是被测手段打崩的。** 换成被动探针（只监听事件）后稳定跑满 30 s。

> 教训：**验证 PPAPI 这类「会长时间占用主线程」的插件时，探针必须是被动的**；要留证就用进程外抓屏（GDI `CopyFromScreen`），不要在页面里注入 JS。

---

## 六、尚未验证（下一步清单）

| # | 项 | 风险 | 判据 |
| --- | --- | --- | --- |
| 1 | **Stage3D** | 🔴 高：142 把 `alpha_size/depth_size/stencil_size/samples` 从 `ContextCreationAttribs` 移除，只保留 `gles{gpu_preference, fail_if_major_perf_caveat, lose_context_when_out_of_memory, context_type}`，这些属性改由默认帧缓冲 `SharedImage` 承载 | 3D 内容出画面 + swap 计数 200–350（140 的实测区间） |
| 2 | **JS ↔ Flash 脚本桥** | 🔴 高：`gin` 的 deprecated named-property interceptor 被 142 整条删除，我们从 140 移植回 ~110 行 | 4399 能识别 Flash；`ExternalInterface.call` 往返 |
| 3 | 同步 IPC 语义 | 🟡 中：全树 70 条 `IPC_SYNC_MESSAGE_*`（Stage3D wait token、JS 桥、全屏、MessageLoop 都走同步） | 无死锁、无卡顿 |
| 4 | 2D 细节 | 🟢 低：本报告已证 | 输入、URLLoader、Socket、视频、LSO、全屏、剪贴板 |
| 5 | `-16` 型回复 | 🟡 待查：被动探针里 `type=66656` 出现 62 次、`type=-16` 31 次（`0xFFFFFFF0` 不是合法消息类），但进程稳定 | 确认是正常轮询还是回程消息头被破坏 |

---

## 七、当前资产

| 项 | 值 |
| --- | --- |
| 分支 | `bao/142-linux` @ `a206e423469aa` |
| tag | `bao-v142-flash-renders`（本次） / `bao-v142-ppapi-builds` / `bao-v142-noppapi` |
| 产物 | `out/Testing/electron.exe` 302.5 MB |
| 探针 | `D:\electron-build-142\flashprobe\`（`main.js` 被动探针 + `run.bat` + `index.html` + SWF + DLL） |
| 证据 | `docs/blog/assets/flx-invaders-on-chromium142.png` |

## 八、下一步

1. Stage3D 验证（最高风险）
2. JS↔Flash 桥（4399）
3. 跑 140 的完整回归集
4. 全绿后打 `bao-v142-verified` + 出 dist
