# 2026-11-18 · 140 移植缺陷定性实验报告

> 目的：用**实测数据**回答"140 移植还剩哪些缺陷"，避免凭代码猜测。
> 环境：Chromium `140.0.7339.41` / Electron `v38.0.0` / Flash `29.0.0.171`（win64）
> 方法：在 `ppapi/host/ppapi_host.cc` 等 3 个位置加**实验探针**（`[ppexp]`），把"没有宿主的 Flash 私有消息"直接打印成名字；再跑 3 个 SWF 对比。
> 探针位置：
> - `PpapiHost::HandleResourceCall()`：资源宿主缺失时打印 `resource host MISSING`
> - `PpapiHost::OnHostMsgResourceCreated()`：宿主创建失败时打印 `resource host creation FAILED`
> - `PpapiHost::OnMessageReceived()`：消息完全无人处理时打印 `UNHANDLED host message`
> - `PepperPluginInstanceImpl::SetFullscreen()` / `PepperFileIOHost::OnHostMsgOpen()`：记录全屏与文件 IO

---

## 一、实验矩阵

| # | 内容 | 文件 | 大小 | 结果 |
| --- | --- | --- | --- | --- |
| E0 | 对照组：Flixel 游戏 | `FlxInvaders.swf` | 68 KB | **0 条 `[ppexp]`**（完全不碰 Flash 私有 API） |
| E1 | 真实商业游戏（会存高分） | `Canabalt.swf` | 3.23 MB | 出预加载画面；**765 条 `[ppexp]`**；未产生 `.sol` |
| E2 | 视频样本 | `sample-swf-files-sample_1280x720.swf` | 4.71 MB | **视频正常播放**（截图有真实画面，三帧 digest 不同）；591 条 `[ppexp]` |

E1/E2 的 `[ppexp]` 计数**完全一致**（426/7/3/2/2/1），说明这批失败来自**内容启动时的共同动作**（Flash 的本地存储/设置初始化），而不是游戏逻辑特有。

---

## 二、E1/E2 的 `[ppexp]` 明细

| 消息 | 次数 | 含义 | 影响 |
| --- | --- | --- | --- |
| `FlashFile_CreateDir` | **426** | `PPB_Flash_File` 建目录 | **LSO / 本地存储初始化失败**，Flash 重试 426 次 |
| `FlashFile_OpenFile` | 7 | 打开文件 | 同上 |
| `FlashFile_QueryFile` | 3 | 查询文件 | 同上 |
| `FlashFile_GetDirContents` | 2 | 列目录 | 同上 |
| `FlashFile_Create` | 1 | 创建 Flash 文件资源 | 同上 |
| `Flash_Create` | 2 | `PPB_Flash` 单例创建 | `PPB_Flash` 的 9 条 API 全部不可用 |
| `Flash_SetInstanceAlwaysOnTop` | 1 | 置顶弹窗 | 无效果 |
| `PPBCore_ReleaseResource` | 323 | 资源释放通知 | 宿主侧资源是否泄漏待评估（138 相同） |
| `PPBGraphics3D_Resize` | 多次 | 3D 上下文尺寸变化 | **说明 Flash 确实创建了 3D 上下文**；该消息无人处理 |
| `PPBInstance_SetCursor` | 多次 | Flash 自定义光标 | **光标不生效**（138 相同） |

### 结论 1：**LSO（本地存档）确认不可用**

- 运行前 `%APPDATA%\Electron\Pepper Data\Shockwave Flash\WritableRoot\#SharedObjects` 下**最近 15 分钟无任何新 `.sol`**；
- 现存 `.sol` 全部来自更早的 Chromium 87 时代（如 `mole.61.com\...\summerFlv.sol`）；
- Flash 每次启动都会用 `PPB_Flash_File` 初始化可写根目录，失败后重试 426 次。

→ 修复点：给浏览器侧补 `PepperFlashFileHost`（`PpapiHostMsg_PPBFlashFile_*` 共 8 条），并接到 `ContentBrowserPepperHostFactory`。

### 结论 2：**`PPB_Flash` 单例消息确实在跑，但宿主全无**

`Flash_Create` ×2（RENDERER + BROWSER 各一次）+ `Flash_SetInstanceAlwaysOnTop` ×1，说明 Flash 主动使用这些 API；
它们没有宿主 → `GetProxyForURL`（同步）/`Navigate`/`IsRectTopmost`/`GetLocalTimeZoneOffset` 等全部拿不到结果。

### 结论 3：**视频其实是好的**（推翻此前判断）

- E2 截图是真实视频画面，三帧 digest 各不相同（`5def40dd5dc7 / 3b7fe249220f / 6b7addf1e764`）；
- 日志出现 `MojoVideoDecoderService` 创建/销毁，说明解码服务真的被用上了；
- 因此 `video_decoder_shim.cc` 里"跳过 `CopyVideoFrameToSharedImage`"只影响**特定（GPU/硬件解码）路径**，不影响常规视频播放。
  **缺陷等级从"视频黑屏"下调为"待观察的边角路径"。**

### 结论 4：**Flash 会创建 PPB_Graphics3D 上下文**

即使 2D 内容（Flixel 游戏）也会触发 `PPBGraphics3D_Resize`。我们的 `ColorBuffer::Attach/Detach` 是 no-op，
所以 3D 输出不可见；但 Flash 有明显的 2D 回退，所以 2D 内容仍正常渲染。
→ Stage3D 内容（Starling/Unity3D）目前**无法验证**（手头没有 Stage3D SWF），但按代码推断仍是黑屏。

### 结论 5：光标消息无人处理（`PPBInstance_SetCursor`）

Flash 想换鼠标指针（悬停在可点击元素上）时发送该消息，宿主没处理 → 光标始终是默认箭头。
138 完全相同（不是 140 回归）。

---

## 三、更新后的缺陷优先级

| 优先级 | 缺陷 | 证据强度 | 建议 |
| --- | --- | --- | --- |
| **P0** | `PPB_Flash_File`（LSO/存档/本地文件）无宿主 | 实测（426 次失败、无 `.sol`） | 补浏览器侧 host，工作量中等（1 个 host 文件 + 8 条消息 + 工厂注册） |
| **P0** | `PPB_Flash` 单例 9 条消息无宿主 | 实测（`Flash_Create`、`SetInstanceAlwaysOnTop`） | 同上，一个 `FlashHost`；重点是 `GetProxyForURL`、`Navigate` |
| **P1** | Stage3D（`PPB_Graphics3D` Attach/Detach no-op） | 代码 + 间接（Resize 消息） | 需要先拿到 Stage3D 测试 SWF 再动手 |
| **P2** | `PPBInstance_SetCursor` 无处理 | 实测 | 实现 cursor 消息处理（小） |
| **P2** | `PPB_Flash_Clipboard` / `Menu` / `Fullscreen` / `DRM` / `Print` | 代码（无宿主） | 按目标站点需要逐个补 |
| **P3** | 视频帧拷贝跳过 | 实测"能播" | 降级为观察项 |
| **P3** | `PPBCore_ReleaseResource` 未处理 | 实测（323 次） | 需确认是否泄漏（138 相同） |

---

## 四、仍未验证的项

1. **全屏**：`SetFullscreen` 探针一次都没触发（Canabalt/视频样本都没有全屏入口）。需要一个带全屏按钮的 SWF。
2. **代理**：`Flash_GetProxyForURL` 未出现（内容没有发起网络请求）。需要"Flash 发起 HTTP 请求"的样本 + 开/关代理对比。
3. **Stage3D**：没有 Stage3D SWF。
4. **WebSocket**：没有 WebSocket 样本（已知是桩，必定失败）。
5. **剪贴板/右键菜单/DRM/打印**：无样本。

> 建议下一批实验准备 5 个小 SWF（LSO 读写、全屏、代理请求、Stage3D、WebSocket），每个 10–20 行 AS3 即可——
> 这比继续读代码更快定性。

---

## 五、复现命令

```powershell
# 探针构建
$env:SCCACHE_SERVER_PORT='5123'   # sccache 默认端口 4226 落在 Windows 排除段
ninja -C out/Testing -j 6 electron

# 运行（Canabalt / 视频样本）
D:\electron-build\run-exp1.cmd
D:\electron-build\run-exp2.cmd

# 结果统计
Select-String -Path <out>\chrome.log -Pattern '\[ppexp\]' |
  ForEach-Object { if ($_.Line -match 'name=(\S+)') { $Matches[1] } } |
  Group-Object | Sort-Object Count -Descending
```

---

## 六、第二轮：自建 AS3 探针（2026-11-18 11:00–11:45）

自建探针工程见 [`tests/flash-probes/`](../../tests/flash-probes/README.md)（含 Flex SDK 编译链、`build.ps1`、WS 服务、页面模板）。
页面统一走 `http://127.0.0.1:8099/`（`file://` 会被 sandbox 限制 LSO/网络），结果直接以绿色文字画在 SWF 里，截图即证据。

| 探针 | 被测能力 | 结果 | 证据 |
| --- | --- | --- | --- |
| `LsoWrite` | `SharedObject.getLocal()` 写入 + `flush()` | ❌ | `Error #2134: Cannot create SharedObject`（配合 `FlashFile_CreateDir` ×444 失败） |
| `LsoRead` | 读回 | ❌ | 同样是 `Error #2134` |
| `HttpProbe` | `URLLoader` GET 本地 HTTP | ✅ | `COMPLETE bytes=20` / `BODY=BAO_FLASH_PROBE_OK` |
| `Stage3DProbe` | `requestContext3D()` → `clear(red)` → `present()` | ❌ | **`Error #3702`**（3D 上下文创建失败）——Stage3D 内容黑屏已定性 |
| `FullscreenProbe`（真实鼠标点击） | `stage.displayState = FULL_SCREEN` | ❌ | 首次（无 `allowfullscreen`）抛 `Error #2152`；加上 `allowfullscreen` 后**请求被接受但 `displayState` 仍为 `normal`**，也没有 `FULL_SCREEN` 事件；`[ppexp] SetFullscreen` 探针**未触发** → Flash 走的是私有 `PPB_Flash_Fullscreen`（无宿主），不是标准 `PPB_Fullscreen` |
| `WebSocketProbe` | `flash.net.WebSocket` | ⚠️ N/A | `Error #1065`（类不存在）；Flash 29/34 的 DLL 里也搜不到 `WebSocket` 字样 → **该播放器不暴露 WebSocket**，桩代码暂无实害；`XMLSocket`/`Socket`（TCP）宿主存在 |

### 结论修正

1. **Stage3D 确认不可用**（不再只是"代码推断"）：`Error #3702`。
2. **全屏确认不可用**，且**根因锁定为 Flash 私有全屏 API**（`PPB_Flash_Fullscreen`）无宿主 —— 标准 `PPB_Fullscreen` 在 renderer 里是有的，但 Flash 29 不走它。
3. **WebSocket 对 Flash 29 不适用**（类都不存在），所以此前列的 WebSocket 缺陷**降级**；`Socket`/`XMLSocket` 走浏览器侧 TCP 宿主，理论可用（未做联网验证）。
4. **HTTP/URLLoader 正常**，说明网络栈与代理链路（`URLLoader` 经我们自己的 network stack）是通的。

### 由此确定的下一批工作

| 优先级 | 工作 | 依据 |
| --- | --- | --- |
| **P0** | 补 `PPB_Flash_File` 宿主（LSO/存档/本地文件） | LSO `#2134` + 444 次 `CreateDir` 失败 |
| **P0** | 补 `PPB_Flash_Fullscreen` 宿主（游戏全屏） | 全屏请求被吞 |
| **P1** | 补 `PPB_Flash` 单例 9 条消息（`GetProxyForURL`/`Navigate` 等） | `Flash_Create` 失败 |
| **P1** | Stage3D：修 `ColorBuffer::Attach/Detach` | `#3702` |
| **P2** | `PPB_Flash_Clipboard` / `Menu` / `DRM` / `Print` | 代码层无宿主 |
| **P3** | `PPBInstance_SetCursor`（光标） | 实测消息被丢 |
---

## 七、修复 1 已完成：`PPB_Flash_File` 宿主（LSO 恢复可用）

**实现**（提交 `2aac068ba2e6c`）：

| 改动 | 说明 |
| --- | --- |
| 新增 `content/browser/renderer_host/pepper/pepper_flash_file_message_filter.{h,cc}` | 从 **Chromium M80** 的同名实现移植（git 历史里仍有源码），处理 7 条 `PpapiHostMsg_FlashFile_*` + 1 条创建消息 |
| 适配 140 | `base::Callback`→`RepeatingCallback`；`CreateSequencedTaskRunner({ThreadPool…})`→`base::ThreadPool::CreateSequencedTaskRunner`；`DeleteFile(path,recursive)`→`DeletePathRecursively`/`DeleteFile`；`FLAG_TEMPORARY`→`FLAG_WIN_TEMPORARY`(Win)；**去掉 `NOTREACHED()`**（Testing 构建致命）改为 `LOG(ERROR)` + fail-closed |
| `content_browser_pepper_host_factory.cc` | 处理 `PpapiHostMsg_FlashFile_Create`，用 `MessageFilterHost` 包装 |
| `content/browser/BUILD.gn` | 加入新源文件 |

**验证结果**

| 项 | 修复前 | 修复后 |
| --- | --- | --- |
| `LsoRoundTrip`（读→自增→flush，连跑两次） | `Error #2134` | 第 1 次 `count=0→1`；第 2 次 **`count=1→2`**，`flush=flushed`，`RESULT=OK` |
| 磁盘落盘 | 无 | `%APPDATA%\e19-ppapi-test\Pepper Data\Shockwave Flash\WritableRoot\#SharedObjects\<id>\127.0.0.1\LsoRoundTrip.swf\bao_probe.sol`（50 B） |
| `Canabalt.swf` 的 `FlashFile_*` 失败 | 426 次/实例 | **0 次** |
| `FlxInvaders` 回归 | — | `interactive=3`、无 `CHECK/FATAL` |

**数据目录**：`<userData>/Pepper Data/<plugin name>`（即 `%APPDATA%\e19-ppapi-test\Pepper Data\Shockwave Flash`），与 Chrome 的布局一致。

**剩余 `[ppexp]`（新优先级）**：`Flash_Create`×2、`Flash_SetInstanceAlwaysOnTop`×1（`PPB_Flash` 单例，下一个 P0）、339 条非 Flash 消息（`SetCursor`/`PPBCore_ReleaseResource`/`Graphics3D_Resize`）。
---

## 八、修复 2 已完成：`PPB_Flash_Fullscreen` 宿主（全屏恢复可用）

**根因**：Flash 29 的全屏走**私有** `PPB_Flash_Fullscreen`（消息发往**渲染进程**），
而不是标准 `PPB_Fullscreen`。140 移植里没有这个 host，`SetFullscreen` 请求被静默吞掉。

**实现**（提交 `31995f7b1ae7c`）：

| 改动 | 说明 |
| --- | --- |
| `pepper_plugin_instance.h` | 新增 `FlashSetFullscreen(bool, bool delay_report)`（M80 曾有，Flash 移除时一并删掉） |
| `pepper_plugin_instance_impl.{h,cc}` | 实现：已在目标状态返回 true，否则转调标准 `SetFullscreen()`（走 `container_->RequestFullscreen()`） |
| 新增 `pepper_flash_fullscreen_host.{h,cc}` | 从 M80 移植，处理 `PpapiHostMsg_FlashFullscreen_SetFullscreen` |
| `content_renderer_pepper_host_factory.cc` + `content/renderer/BUILD.gn` | 注册 `PpapiHostMsg_FlashFullscreen_Create` + 加入源文件 |

**A/B 验证（真实鼠标点击，Flash 29.0.0.171）**

| 条件 | 窗口尺寸 | `[ppexp]` |
| --- | --- | --- |
| **带 `allowfullscreen`**（修复后） | **1707×1067 @ (0,0)** = 屏幕尺寸 | `FlashSetFullscreen(1, delay=1)` → `SetFullscreen(1)` |
| 不带 `allowfullscreen`（对照） | 900×700 @ (403,159) 保持不变 | **没有任何** `FlashSetFullscreen` 调用（Flash 自己抛 `Error #2152`） |

→ 全屏确实由本次实现打通，而非其他因素。

**探针注意**：全屏测试必须 (1) `<embed allowfullscreen="true">`，(2) 用**真实鼠标事件**（`mouse_event`）点击，
`webContents.sendInputEvent` 不会送到插件进程；且 SWF 文件名要换（Chromium 会缓存 SWF）。
---

## 九、修复 3 已完成：`PPB_Flash` 单例宿主（渲染进程侧）

**实现**（提交 `b0bf0b28c235a`）：

| 消息 | 处理 | 结果 |
| --- | --- | --- |
| `Flash_SetInstanceAlwaysOnTop` | → `PepperPluginInstance::SetAlwaysOnTop` | ✅ |
| `Flash_Navigate` | → 新增 `PepperPluginInstance::Navigate`（`CreateWebURLRequest` + `LoadFrameRequest`，只放行 GET/POST，拒绝 `javascript:`） | ✅ 实测导航生效 |
| `Flash_IsRectTopmost` | → `PepperPluginInstance::IsRectTopmost` | ✅ |
| `Flash_InvokePrinting` | 记录日志 + 返回 PP_OK（打印未实现） | ⚠️ 空实现 |
| `Flash_GetProxyForURL` | 返回 `PP_ERROR_FAILED`（140 删除了 `RenderThread::ResolveProxy()`；Flash 的 HTTP 仍走 `PPB_URLLoader`，代理照常生效） | ⚠️ 降级 |
| `Flash_DrawGlyphs` | 未实现（M80 依赖 `PPB_ImageData_API::GetCanvas()`，本树无；Flash 常规文字走 Graphics2D） | ⚠️ 降级 |
| `Flash_UpdateActivity` / `GetLocalDataRestrictions` | 目标进程是 BROWSER，本次未覆盖 | ⚠️ 仍缺 |

**验证**

| 项 | 结果 |
| --- | --- |
| 新探针 `NavigateProbe`（AS3 `navigateToURL`） | chrome.log 出现真实请求 `GET /probe.txt?from=flash` → 全链路打通 |
| `Canabalt.swf` 的 `[ppexp]` | 从 **342 行**（`Flash_Create`×2 + `SetInstanceAlwaysOnTop`×1）降到 **`Flash_Create`×1**（只剩 BROWSER 侧那次）+ 341 条非 Flash 消息 |
| 回归 | `interactive=3`，无崩溃 |

**新增探针**：`tests/flash-probes/NavigateProbe.as`。
---

## 十、小件批量收尾（2026-11-18 12:30，提交 `c481fddadcc25`）

按"先把零散缺口关掉，再动 Stage3D 大工程"的原则，本轮补了两个 host：

| 组件 | 覆盖的消息 | 说明 |
| --- | --- | --- |
| **浏览器侧 `PepperFlashBrowserHost`**（新增） | `Flash_UpdateActivity` / `Flash_GetLocalTimeZoneOffset` / `Flash_GetLocalDataRestrictions` | UpdateActivity 做成 no-op（content 无 wake lock，仅影响省电）；时区用 `ppapi::PPGetLocalTimeZoneOffset`；LSO 限制回复"无限制"（content 无 CookieSettings）。同时在浏览器工厂注册 `PpapiHostMsg_Flash_Create` |
| **渲染侧 `PepperFlashFontFileHost`**（新增） | `FlashFontFile_Create` / `FlashFontFile_GetFontTable` | 用 `skia::DefaultFontMgr()->matchFamilyStyle()` + `SkTypeface::getTableSize/getTableData`（tag 按大端字节序），Flash 的嵌入字体（中文页游常见）现在能真正取到字体表 |

### 验证

| 项 | 结果 |
| --- | --- |
| `Canabalt.swf` 的 `[ppexp]` | 只剩 **337 条 non-Flash**（`SetCursor` / `PPBCore_ReleaseResource` / `Graphics3D_Resize`），**`Flash_*` 与 `FlashFile_*` 失败全部归零** |
| `FlxInvaders` 回归 | `interactive=3`，无 `CHECK/FATAL` |

### 仍未实现（附原因，避免重复踩坑）

| 项 | 为什么不算"小件" |
| --- | --- |
| `PPB_Flash_Clipboard` | 140 的 `ui::Clipboard` 读取改成了**异步回调 + `DataTransferEndpoint`**，移植需要把 PPAPI 的同步应答模型改成异步，属中等改造 |
| `PPB_Flash_Menu`（右键菜单） | 依赖 blink 的上下文菜单 API（M80 用 `WebPluginContainer::ShowContextMenu`，140 已变） |
| `PPB_Flash_DRM` | Windows 需要设备 ID/HMONITOR，依赖 `base::win` 与平台监控器枚举 |
| `PPB_Flash_Print` | Chrome 走 PDF 组件（`pdf::PepperPDFHost`），content 不带 |
| `PPBInstance_SetCursor`（光标） | 该消息在 **138/140 都没有任何宿主**，要先补 `InstanceMessageFilter` 的注册机制（`AddInstanceMessageFilter` 全树无人调用） |
---

## 十一、Stage3D 结论翻转（2026-11-18 12:45）：**能跑**，卡的是页面 `wmode`

### 实验过程

1. **先怀疑 GPU 管线**：查了 140 的 `gpu/`，确认 `CommmandBufferProxyImpl::SetDefaultFramebufferSharedImage` 及其 mojom **整体被删**
   （138 用它把 SharedImage 绑成默认帧缓冲）。按此推断要恢复 Stage3D 得改 GPU 服务，属 3–5 天工程。
2. **加 `[ppiface]` 探针**（`InterfaceList::GetInterfaceForPPB`）看 Flash 到底拿到了哪些接口：
   ```
   [ppiface] PPB request 'PPB_Graphics3D;1.0' found=1
   [ppiface] PPB request 'PPB_OpenGLES2;1.0' found=1
   ...
   ```
   → **接口是有的**，Flash 也真的请求了；但日志里**没有任何 `PPBGraphics3D_Create`**，说明 Flash 在更早的阶段就放弃了。
3. **换成 `wmode="direct"` 的测试页**：
   ```
   EVENT CONTEXT3D_CREATE
   cleared to RED
   driver=Software Hw_disabled=unavailable
   RESULT=OK
   ```
4. **视觉验证**（`Stage3DVisual` 探针：只清屏成红色，不画任何 2D 内容）→ 截图**整屏红色**，证明 3D 输出真的上屏了。

![Stage3D 红色清屏](D:\electron-build\result15-3dvisual\report-control.png)

### 结论

| 说法 | 修正后 |
| --- | --- |
| "Stage3D 不可用（`Error #3702`）" | ❌ **错误结论**。`#3702` 是因为测试页缺 `wmode="direct"`；加上后**上下文创建成功、内容可见** |
| "Stage3D 需要修 `ColorBuffer::Attach`" | 部分成立：Flash 报 `driver=Software`（`Hw_disabled=unavailable`），即**走软件渲染路径**，此时 `PPB_Graphics3D` 的 GPU 默认帧缓冲并不参与；`Attach` 的 no-op 只影响**硬件加速**那条路 |
| Stage3D 优先级 | 从 **P1 阻断** 降为 **P2 可选**：软件路径已可用（兼容性 OK，只是慢）；硬件路径要恢复被删的 GPU API |

### 复现要点（写进探针说明）

- Stage3D 测试页必须 `<embed wmode="direct">`，否则 `requestContext3D()` 直接抛 `Error #3702`。
- 验证输出要**只画 3D**（`Stage3DVisual`），因为 `ProbeBase` 的黑底会盖住 3D 层，看起来"黑屏"其实是文字挡住了。

### 对缺陷优先级的影响

Stage3D 移出 P1；后续若要硬件加速，工作项变成"恢复 `SetDefaultFramebufferSharedImage`（mojom + passthrough decoder + 客户端代理）"，
届时可用 `Stage3DProbe`（看 `driver=` 是否变成 `Direct3D11`）作为验收标准。
---

## 十二、硬件加速 Stage3D：GPU 链路已恢复（提交 `9360a4985ce09`）

### 做了什么

Chromium 删除 PPAPI 时，把"SharedImage 绑成命令缓冲默认帧缓冲"的整条链路一起删了。
本次按 138 实现自底向上恢复：

| 层 | 文件 | 内容 |
| --- | --- | --- |
| 服务端类 | `gpu/command_buffer/service/gles2_external_framebuffer.{h,cc}`（新增） | 直接移植 138（96 + 633 行，**140 编译零改动**） |
| mojom | `gpu/ipc/common/gpu_channel.mojom` | 新增 `SetDefaultFramebufferSharedImageParams` + deferred 分支 |
| 服务端 stub | `command_buffer_stub.{h,cc}`、`gles2_command_buffer_stub.{h,cc}` | 消息分发 + 转发解码器 |
| 解码器 | `gles2_cmd_decoder.h`（纯虚）、`gles2_cmd_decoder.cc`（validating）、`gles2_cmd_decoder_passthrough.{h,cc}`、`gles2_cmd_decoder_mock.h` | 附加共享图像后把 client 帧缓冲 0 重映射到 external FBO |
| 客户端 | `gpu/ipc/client/command_buffer_proxy_impl.{h,cc}` | `SetDefaultFramebufferSharedImage()` 走 deferred 消息 |
| PPAPI | `content/renderer/pepper/ppb_graphics_3d_impl.cc` | `ColorBuffer::Attach/Detach` 恢复真实调用 |

### 验证

| 项 | 结果 |
| --- | --- |
| 全量构建 | 0 错误 |
| FlxInvaders | `interactive=3`，无 `CHECK/FATAL`（digests `d7c7cbeaa6ed / b079ac785fa7 / dca0021d6959`） |
| Canabalt | `interactive=3`，无 `CHECK/FATAL`（digests `a98771c770a1 / d3502d611970 / 6c23dad10767`） |
| Stage3D（`wmode=direct`） | 上下文创建成功、红色清屏可见；**但 `driver=Software Hw_disabled=unavailable`** |

### 关键发现：Flash 根本没走到 PPAPI 3D

日志里 **完全没有 `PPBGraphics3D_Create` / `[ppdbg] G3D CreateRaw`**，说明 Flash 在调用 PPAPI
之前就自己判定"硬件不可用"，退回软件驱动：

- 已排除：接口缺失（`[ppiface]` 显示 `PPB_Graphics3D;1.0 found=1`、`PPB_OpenGLES2;1.0 found=1`）
- 已排除：机器无 GPU（日志显示 `Using angle GL implementation` + `CreateSharedImage[DXGISwapChain]`）
- 已排除：缺 `wmode=direct`（加上后上下文能建、能出图）

→ 所以恢复的 GPU 链路目前**尚未被 Flash 触发**。它是必要条件（Flash 真走硬件路径时才有地方画），
但不是充分条件；下一个要查的是 **Flash 自身的硬件可用性判定**（它到底在等什么信号）。

### 后续可能的排查方向

1. 给插件进程加 GPU 相关开关（Chrome 时代 Flash 的 3D 依赖进程级 GPU 能力通告）。
2. 抓 Flash 的 `%APPDATA%\...\settings.sol` / `mms.cfg`，确认 `EnableHardwareAcceleration` 是否为 0。
3. 用 `Context3DRenderMode.AUTO` 之外的手段无法强制硬件；Flash 决定后只暴露 `driverInfo`。
---

## 十三、硬件 Stage3D 的判定点：**138 和 140 完全一致**（决定性对照实验）

### 实验设计

把同一个 `Stage3DProbeDirect.html`（`wmode="direct"`）分别跑在：

- **140 构建**（本轮刚恢复 `SetDefaultFramebufferSharedImage` 全链路）
- **138 构建**（`SetDefaultFramebufferSharedImage` 从未被删，即"API 完整"的基准）

### 结果：两者输出一字不差

```
EVENT CONTEXT3D_CREATE
cleared to RED
driver=Software Hw_disabled=unavailable
RESULT=OK
```

且两边日志里**都没有 `PPBGraphics3D_Create` / `G3D CreateRaw`**。

### 结论（重要）

| 判断 | 状态 |
| --- | --- |
| 硬件 Stage3D 在 140 上"被我们改坏了" | ❌ 不成立 |
| 140 缺少 GPU 链路导致 | ❌ 不成立 —— 138 有完整 API 也一样是 Software |
| **硬件 Stage3D 在"Electron + PPAPI + Flash 29"这个组合里本来就不可用** | ✅ 成立（138/140 表现一致） |
| 软件驱动 Stage3D | ✅ 可用（`RESULT=OK`，画面可见） |

也就是说：本轮恢复的 GPU 链路价值在于**补齐与 138 的功能对等**（去掉一个潜在的 140 独有缺陷），
而不是让硬件 Stage3D 复活——那个开关在 Flash 侧，且与 Chromium 版本无关。

### 附带记录：138 构建的已知地雷（本轮又踩一次）

`--log-file=...` 会让 138 构建直接 FATAL：

```
FATAL:content/browser/child_process_launcher_helper_win.cc:80]
Check failed: !cmd_line->HasSwitch(switches::kLogFile)
```

跑 138 对照实验必须改用 `--enable-logging=stderr` 并重定向 stderr。

### 仍未知（但优先级已降为"可选"）

Flash 内部到底用什么信号判定 `Hw_disabled=unavailable`（它连 PPAPI 3D 创建都没试）。
要继续只能逆向 Flash 的判定逻辑或改 `settings.sol`/`mms.cfg`，投入产出比低；
对最终用户而言**软件驱动 Stage3D 已能满足兼容性需求**。
---

## 十四、【重要修正】本体项目 C87 是硬件 3D，我们的 138/140 都不是

> 本节**推翻了 §十三 的结论**。§十三 只对比了"我们的 138"和"我们的 140"，两者一致就误判成"组合固有限制"；
> 补上与 **本体项目（Electron 11 / Chromium 87）** 的对照后，结论完全反转。

### 三方对照（同一 SWF、同一 Flash 29.0.0.171、同一 `wmode="direct"` 页面）

| 运行时 | `driverInfo` | 结论 |
| --- | --- | --- |
| **本体项目：Electron 11.5 / Chromium 87** | **`driver=OpenGL`** | ✅ **硬件加速** |
| 我们的 138 移植（Chromium 138 / Electron 37） | `driver=Software Hw_disabled=unavailable` | ❌ 软件 |
| 我们的 140 移植（Chromium 140 / Electron 38） | `driver=Software Hw_disabled=unavailable` | ❌ 软件 |

→ **这是移植引入的缺失，不是平台固有限制。** 硬件 Stage3D 的优先级回到 **P1**。

### 已排除的原因（都做了实测）

| 假设 | 实验 | 结果 |
| --- | --- | --- |
| 沙箱挡住 GPU | 140 加 `--no-sandbox --disable-flash-sandbox` | 仍 Software |
| 缺 GPU 启动参数 | 140 加本体项目的 `--enable-gpu-rasterization --enable-zero-copy --ignore-gpu-blacklist --disable-gpu-process-crash-limit` | 仍 Software |
| Flash 设置被写脏（粘性关闭） | 把 `%APPDATA%\e19-ppapi-test` 整个挪走，全新 profile | 仍 Software |
| 页面没给 `wmode=direct` | 加 `[ppargs]` 探针打印传给插件的参数 | `wmode=direct` **确实传到了** |
| PPAPI 接口缺失 | `[ppiface]` 探针 | `PPB_Graphics3D;1.0 found=1`、`PPB_OpenGLES2;1.0 found=1` |
| 插件注册方式不同（`--register-pepper-plugins` vs `--ppapi-flash-path`） | 在 Electron 11 上用 `register-pepper-plugins`（JS appendSwitch） | **依然 `driver=OpenGL`** → 注册方式无关 |
| 插件进程命令行差异 | 抓两边的 `--type=ppapi` 命令行 | 基本一致；我们缺 `--ppapi-flash-args`（Chrome 给组件版 Flash 专用），从命令行补不进去（被过滤） |
| 插件进程自己加载 D3D/GL | 抓 C87 插件进程已加载模块 | **没有 d3d9/d3d11/opengl32/libEGL** → C87 的硬件 3D 是走 PPAPI 3D（GPU 进程干活），不是插件自建设备 |

### 下一步唯一的强线索

C87 上 Flash **确实走了 `PPB_Graphics3D`**（插件进程不加载任何 GL/D3D DLL，说明绘制发生在 GPU 进程），
而我们两边**根本没有 `PPBGraphics3D_Create`**（`[ppdbg] G3D CreateRaw` 从未触发）。

也就是说：**Flash 在调用 PPAPI 3D 之前的某个检测环节，在 Chromium 138/140 上得到了与 87 不同的结果。**
下一步要在插件侧（`ppapi/proxy/ppb_graphics_3d_proxy.cc`、`ppp_instance_proxy`）加全量日志，
确认 Flash 到底是没调用，还是调用了但在插件侧就被拒绝（不产生 IPC）。
---

## 十五、Stage3D 根因定位与修复（提交 `40d4e9a557e60`）

### 根因：`ppapi_preferences_builder.cc` 里三个硬编码的 false

```cpp
ppapi_prefs.is_3d_supported = false;                 // ← 上游删 Flash 时留下的残骸
ppapi_prefs.is_stage3d_supported = false;
ppapi_prefs.is_stage3d_baseline_supported = false;
```

因果链：

| # | 环节 | 位置 |
| --- | --- | --- |
| 1 | Flash 创建 `Context3D` 前先问"Stage3D 开了吗" | Flash 29 内部 |
| 2 | `PPB_Flash::GetSetting` 转发到 preferences | `ppapi/proxy/flash_resource.cc` |
| 3 | preferences 来源 | `content/renderer/pepper/ppapi_preferences_builder.cc` |
| 4 | 拿到 false → 判"浏览器未启用 Stage3D" → **根本不发 `PPBGraphics3D_Create`** | — |

**探针实证**（改前）：

```
[ppdbg] Flash GetSetting setting=3 (STAGE3DENABLED) prefs: 3d=0 stage3d=0 stage3d_baseline=0
[ppdbg] Flash GetSetting setting=1 (3DENABLED)     prefs: 3d=0 stage3d=0 stage3d_baseline=0
```

改后：`prefs: 3d=1 stage3d=1 stage3d_baseline=1`，随即出现 `[ppdbg] G3D CreateRaw`。

### 第二层：插件侧 GLES2 初始化失败

打开开关后 Flash 开始建 3D 上下文，但插件侧失败：

```
[g3d] GLES2Impl caps: bind_gen_res_chromium=0 share_group=1 ...   ← 服务端说 false，客户端当 true
[g3d] bind_generates_resource mismatch -> kFatalFailure
[g3d] Graphics3D::Init CreateGLES2Impl ok=0
```

`ppb_graphics_3d_shared.cc` 里 `bind_creates_resources` 是**硬编码 true**（138 时代服务端也上报 true，
所以没暴露）；140 的 passthrough 解码器上报 `bind_generates_resource_chromium=0`。
改为读取 `GetGpuControl()->GetGLCapabilities()`：

```
[g3d] Graphics3D::Init CreateGLES2Impl ok=1
[ppdbg] G3D DoSwapBuffers bound=1          ← 上下文真正成立并在交换
```

### 第三层（未完成）：3D 图层合成出来是白屏

`is_3d_supported=true` 会让 Flash 的**2D**渲染也切到 GPU 路径，而本移植里该路径合成为纯白（整屏白）。
当前取舍：**只放开 Stage3D 两个字段**，`is_3d_supported` 保持 false，2D 继续走已验证的软件路径。

| 配置 | 2D 游戏 | Stage3D 上下文 | 3D 画面 |
| --- | --- | --- | --- |
| 三者全开 | ❌ 白屏 | ✅ 成立 | ❌ 白屏 |
| **只开 stage3d（当前）** | ✅ 正常（`interactive=3`） | ✅ 成立、`DoSwapBuffers` | ❌ 白屏（待修） |
| 三者全关（修复前） | ✅ 正常 | ❌ 不创建 | ❌ 无 |

### 回归验证（当前提交）

| 项 | 结果 |
| --- | --- |
| FlxInvaders | `interactive=3`，digests `20ddb3de13e7 / 7d5b33c1ca8c / c5f2e54f306a`，无 CHECK/FATAL |
| Canabalt | `interactive=3`，digests `c2ac836d6975 / b7f6aa423239 / ab7078846a64`，无 CHECK/FATAL |
| Stage3D | `CreateGLES2Impl` 不再失败，`DoSwapBuffers bound=1` |

### 下一步（白屏的排查方向）

`DoSwapBuffers` 已发生、服务端 attach 也成功（`AttachSharedImage ok=1 is_attached=1`），
但合成为空白 → 怀疑插件实例的 **3D 图层绑定/上屏链路**（`PPB_Instance::BindGraphics` →
`PepperPluginInstanceImpl` 的 texture layer）在 140 移植里缺失或未接上。
---

## 十六、白屏二分结论：**分支 B —— 合成器确实在消费，图是空的**

按"先二分、别先改代码"的顺序做的实验（`is_3d_supported` 三者全开复现白屏，逐层加探针）：

### 链路证据（全部实测，按时间顺序）

| 探针 | 输出 | 结论 |
| --- | --- | --- |
| `UpdateLayer` | `want3d=1 want2d=0 layer=set` | 走的是 3D texture layer 分支 |
| `WebPluginContainerImpl::SetCcLayer` | `layer=non-null element=1` | 容器已接管 cc layer |
| `CommitTransferableResource` | `mailbox=8D:EF:... texture_layer=set empty=0` | 资源已提交 |
| `PassCommittedTextureToTextureLayer` | `sync_has_data=1 size=1200x900` | 同步令牌有效、尺寸正确 |
| `cc::TextureLayer::SetTransferableResource` | `layer_tree_host=0` | 设置时尚未挂 host（**正常时序**，attach 发生在后续 commit） |
| `ShouldAccelerate` | 由 `0` 变 `1`（多次） | blink 认账，插件元素进入合成 |
| `WebPluginContainerImpl::Paint` | `layer=0 size=1200x900` 然后 `layer=1 size=1200x900` | 下一帧记录 ForeignLayer，尺寸正确 |
| `cc::TextureLayer::SetLayerTreeHost` | `host=1` ×2 | **层确实挂上了合成树** |
| `TextureLayerImpl::AppendQuads` | `resource_id=1 bounds=1200x900 opaque=1` ×2 | **合成器真的在画这一层** |
| `FinishedConsumingCommittedTexture` | 未触发 | 不属于"没消费"：单帧资源被 impl 持有、只在替换/销毁时归还 |

### GPU 侧（3D 路径）

```
[g3dfs] default_fb=2 attached=1 size=1200x900 color_fmt=32849 depth=1 stencil=1 fb_status=0x8cd5
```

- `0x8cd5` = `GL_FRAMEBUFFER_COMPLETE`
- 共享图像已附加、尺寸/深度/模板都正确

### 结论

**分支 B 成立，且更靠后一层**：合成链路（layer 入树 → 绘制 → 读取）全部打通，
画面白说明**被附加的 SharedImage 里没有 Flash 画的内容**。

即：`SetDefaultFramebufferSharedImage` 把 FBO 0 重映射到外部 FBO 这件事，
"服务端执行成功、FBO 完整"，但 Flash 的 GL 绘制**没有落进这个 FBO**。

### 下一步的三个具体怀疑点（下一轮按序验证）

1. **路由是否同一条**：Flash 的 GL 命令流走插件侧 `PpapiCommandBufferProxy` → 渲染进程 →
   GPU 服务的某个 route；`SetDefaultFramebufferSharedImage` 是渲染侧 `CommandBufferProxyImpl`
   发出的。若两者最终不是同一个 decoder 实例，attach 就白做了。
   验证：在 `SetDefaultFramebufferSharedImage` 与解码器 `DoDrawElements/DoClear` 里同时打
   `command_buffer_id`/`route_id` 对比。
2. **双缓冲错帧**：`ColorBuffer` 每帧 attach/detach，若 attach 的 mailbox 与 Flash 当帧绘制的
   缓冲不是同一个（`available_color_buffers_` 轮转），合成器拿到的就是"上一帧/未绘制"的图。
   验证：attach 时打印 mailbox，与 `CommitTransferableResource` 的 mailbox 逐帧比对。
3. **`origin` 翻转**：`PassCommittedTextureToTextureLayer` 里显式设置
   `kBottomLeft_GrSurfaceOrigin`；若 140 的 `SharedImage` 已经是 bottom-left，会双翻转 —— 
   但双翻转只会上下颠倒，不会全白，优先级最低。
---

## 十七、H1 排除、H2 证实（2026-11-18 17:00–17:25）

### H1（客户端 FBO 0 未映射到共享图像 FBO）：**已排除**

在 `DoBindFramebuffer` 里打印 client→service 映射，并与 attach 的 decoder 实例对比：

```
[g3dfb] attach          this=0x6e7c001f0000 client0 -> service2 offscreen=1
[g3dfb] DoBindFramebuffer this=0x6e7c001f0000 target=0x8d40 client=0 service=2
```

- **同一个 decoder 实例**（`this` 相同）
- `glBindFramebuffer(GL_FRAMEBUFFER, 0)` 被正确翻译成 service FBO 2（外部 SharedImage）
- 该 FBO 之前已验证 `fb_status=0x8cd5`（COMPLETE）

→ 别名映射是成立的，不是 H1。

### 新事实：Flash 第一帧**根本没画**进这块 FBO

在 attach 之后主动把外部 FBO 清成**绿色**，帧末（detach 前）回读：

| 帧 | 回读结果 | 含义 |
| --- | --- | --- |
| 第 1 次 detach | `center=0,255,0,255`（**绿**） | 绿色原样保留 → **Flash 没往这个 FBO 画任何东西** |
| 第 2 次 detach | `center=255,255,255,255`（**白**） | 后面某次绘制把整块刷成了白色 |

文字探针 `Stage3DProbeDirect` 与纯视觉探针 `Stage3DVisual`（只清红）**行为完全一致**，
说明这与 SWF 画了什么无关——不是"内容错了"，是"绘制没落到这里 / 被白色覆盖"。

### H2（ACK 断流只画一帧）：**证实**

```
DoSwapBuffers 次数: 1
attach 次数: 5
```

整场运行 `DoSwapBuffers` **只发生 1 次**（`bound=1`），而 attach/detach 走了 5 次。
即 Flash 渲染完第一帧后就不再继续（在等 ACK / 下一帧信号）。

### 附带观察

出现过 **两个不同的 decoder 实例**收到 attach（`0x5584…` 与 `0x6e7c…`），
说明进程里存在两个 3D 上下文，需要确认 Flash 的 Stage3D 实际画在哪个上。

### 下一轮顺序（已按因果排好）

1. **先修 H2**：给 `commit_pending_` → `ViewFlushedPaint()` → `SwapBuffersACK` 这条链加探针，
   确认 ACK 是否真的发出、Flash 是否收到。只有 swap ≥ 3 帧，双缓冲/白帧的观察才有意义。
2. 再复测绿色回读：若管线跑起来后回读变红 → 问题就是"单帧 + 时序"，随 H2 一起消失。
3. 若仍为白 → 再查两 decoder 归属与 Flash present 路径。
---

## 十八、逐条核验"路由"与"双缓冲错帧"（2026-11-18 17:25–18:00）

### 1. 路由同一条：**已验证成立**

给解码器加实例标识（`[g3did]`）、attach/swap/commit 三处打印 mailbox（`[g3dmx]`），按时间排序：

```
[g3did] decoder init this=0x2efc00310000 offscreen_attr=1
[g3dmx] attach this=0x2efc00310000 mailbox=CD:BF:...        ← 第一组上下文（只 attach/detach，无 swap）
[g3dmx] attach this=0x2efc00310000 mailbox=(detach)
[g3did] decoder init this=0x7874001eb000 offscreen_attr=1
[g3dmx] attach this=0x7874001eb000 mailbox=A8:ED:...
[g3dmx] swap  export  mailbox=A8:ED:...
[g3dmx] commit        mailbox=A8:ED:...
[g3dmx] attach this=0x7874001eb000 mailbox=(detach)
[g3dmx] attach this=0x7874001eb000 mailbox=1A:49:...
```

- **attach、swap export、commit 三者是同一个 decoder 实例（`0x7874001eb000`）、同一个 mailbox** → 路由一致
- 另有一组 decoder（`0x2efc…`）只 attach/detach、从不 swap → 那是 Flash 的一个内部探测上下文
- 附：`glBindFramebuffer(0)` 在这个 decoder 上被翻译成 service FBO 2（§十七）

### 2. 双缓冲错帧：**已验证不成立**

强制单缓冲后（`is_single_buffered_ = true`），同一个图像被反复 attach，不存在"A 画、B 导出"：

```
[g3dsb] forced single_buffer=1 (requested=0)
[g3dmx] attach mailbox=0D:06:A3:45:...
[g3dmx] swap export mailbox=0D:06:A3:45:...
[g3dmx] commit mailbox=0D:06:A3:45:...
[g3dmx] attach mailbox=(detach)
[g3dmx] attach mailbox=0D:06:A3:45:...      ← 同一块图像再次 attach
```

→ **导出/提交的 mailbox 就是刚 attach 的那块，没有错位**；单缓冲下画面依旧白，所以不是双缓冲错帧。

### 3. 这轮挖出的新线索（比上面两条更接近根因）

`GLES2ExternalFramebuffer::AttachSharedImage` 里有一个关键分叉：

```cpp
const bool can_attach_directly = !samples && !preserve;
if (can_attach_directly) { 直接把共享图像纹理挂到 FBO }
else {                     挂一块中间纹理（UpdateAttachment），再 glClear(0,0,0,0) }
```

而 `preserve` 来自 Flash 的 `buffer_preserved` 属性（`preserve_ = requested_attribs.buffer_preserved && !is_single_buffered_`）。

- 若 Flash 请求 `buffer_preserved=1`（之前的 attach 日志里确实出现过 `preserve=1`），
  所有绘制都落到**中间纹理**，最终要靠 `ResolveAndDetach()` 的 blit 搬回共享图像。
  这条 blit 路径就是白色/空白的高嫌疑点。
- 强制单缓冲时 `preserve_` 会变 false（走直挂路径），但画面仍白 → 说明还有第二个问题。

### 4. 另一个可直接观察的事实

单缓冲 + 直挂模式下，回读顺序是：

```
attach(A) → prev-image center = 0,0,0,255     （黑，初始）
swap/commit(A)
attach(A) → prev-image center = 255,255,255,255 （白）
```

即：**图像在交给合成器之后变成白色**。要么 Flash 在这期间往 FBO 0 刷了白（只画不换帧），
要么合成器把这块图像当渲染目标写过（可能性低）。

### 下一轮三件事（按信号强度排序）

1. 单缓冲 + 直挂模式下重做"attach 后清绿"实验：绿色保留 = Flash 没画；变白 = Flash 画了白。
2. 打印 `preserve/samples/can_attach_directly` 与实际路径，确认走的是哪条分支。
3. 若走中间纹理路径：查 `GLES2ExternalFramebuffer::ResolveAndDetach()` 的 blit（源/目标、是否被 clear 覆盖）。
---

## 十九、验证结果：preserve 分支排除，且 **Flash 完全没有发出绘制调用**

### 1. `preserve` 分支不是原因

给 `GLES2ExternalFramebuffer::AttachSharedImage` 打印分支判定：

```
[g3dpv] forced preserve=0 (requested buffer_preserved=1 single_buffer=0)
[g3dpv] AttachSharedImage samples=0 preserve=0 direct=1     ← 直挂共享图像纹理
[g3dpv] ResolveAndDetach active=0
```

- 直挂路径（`direct=1`，不经过中间纹理、不依赖 `ResolveAndDetach` 的 blit）**画面依旧白**
- 说明白屏不是"中间纹理 → blit"这条路径的问题

### 2. 直挂模式下，Flash 依然什么都没画（绿色保留实验）

```
attach → 清绿 → 帧末回读：center=0,255,0,255   （绿，原样保留）
```

绿色完整保留 ⇒ **Flash 没有往这块 FBO 写任何东西**（连一次 clear 都没有）。

### 3. 决定性证据：整场运行 **零次绘制调用**

同时给 `DoClear`、`DoDrawArrays`、`DoDrawElements` 加了实例级探针：

```
[g3ddraw] Clear this=0x3e9c001eb000 mask=0x4000 draw_fb=2   ← 清默认帧缓冲（白）
[g3ddraw] Clear this=0x3e9c001eb000 mask=0x4000 draw_fb=2
[g3ddraw] Clear this=0x3e9c001eb000 mask=0x4000 draw_fb=2
[g3ddraw] Clear this=0x3e9c001eb000 mask=0x4000 draw_fb=3   ← 清它自己的离屏 FBO
[g3ddraw] Clear this=0x3e9c001eb000 mask=0x4000 draw_fb=3
```

- **只有 `glClear`（白色），没有任何 `DrawArrays` / `DrawElements`**
- 所以白屏 = Flash 自己把默认帧缓冲清成了白色，它的 3D 内容**从未进入 GL 命令流**

### 结论（重要）

> `GetSetting(STAGE3DENABLED)=true` 只让 Flash **创建并绑定**了 `PPB_Graphics3D`
> （`CreateRaw` / `CreateGLES2Impl ok=1` / `DoSwapBuffers bound=1` / FBO 完整），
> 但它**没有把 Stage3D 的渲染切换到这个上下文**——整局只发 clear，不发 draw。

也就是说：我们修掉的是"闸门"（preferences）和"建链"（GLES2 初始化），
但 Flash 内部还有第二道判断决定"是否真的用 GPU 渲染"，那道判断目前仍然指向软件路径。

### 下一轮唯一该做的事

**抓 Flash 在 `Context3D` 创建之后发出的全部 PPAPI 调用**，看它还在等什么信号：

1. 在 `ppapi/host/ppapi_host.cc` 的未处理消息探针基础上，把 **所有** `PpapiHostMsg_*` 消息名打印出来（按首次出现去重）
2. 重点看有没有 `PPBGraphics3D_GetAttrib`、`PPBInstance_BindGraphics`、`PPBFlash_*Setting*` 之类的"二次确认"调用
3. 对照本体项目 C87：同样的探针在 C87 上无法加，但可以在 138 移植上跑同一套探针，看是否也零绘制（如果是 → 说明 C87 与我们差异不在这条链，需要另找）
---

## 二十、重大修正：硬件 Stage3D **已经激活**（`driver=OpenGL`），且 P1/P2 定位到"零绘制"的性质

### 1. 新工具：让 Flash 自己把结论发回来（HTTP 上报探针）

Flash 的 `Context3D.driverInfo` 在页面上会被 3D 图层盖住看不到。改用 `flash.net.URLLoader`
把结论 POST/GET 回本机 8099，再从 electron 日志里的 `rep?tag=...` 行读出来：

```
start  = requesting
driver = OpenGL        ← 硬件驱动！
ok     = cleared-red   ← clear(1,0,0,1)+present() 无异常
```

探针：`tests/flash-probes/Stage3DReport.as` + `probe-site/Stage3DReport.html`。

**结论：preferences 修复之后，Flash 的 Stage3D 已经走 `OpenGL`（硬件）驱动，不再是 Software。**

### 2. P1（解码器命令普查）结果：只有 BindBuffer

给 `DoCreateProgram / DoCreateShader / DoCompileShader / DoLinkProgram / DoUseProgram /
DoBindBuffer / DoVertexAttribPointer / DoGetProgramiv` 都加了命名普查（每条最多 4 次）：

```
[g3dc] BindBuffer this=0x31c4001f0000 a=34962   ×2
[g3dc] BindBuffer this=0x31c4001f0000 a=34963   ×2
```

- **没有任何 program/shader 命令到达解码器**
- 也没有 `VertexAttribPointer` / `GetProgramiv`

### 3. P2（客户端入口 + 错误）结果：全空

```
[g3dc2]  client DrawArrays / DrawElements : 0 条
[g3derr] client SetGLError               : 0 条
```

- 客户端**从未调用** `DrawArrays`/`DrawElements`
- 客户端**一个 GL 错误都没有**（不是被 validation 吞掉，是根本没走到）

### 4. 这三条证据拼起来 = 正好印证你说的"漏搬"

```
clear ✓  →  (无 program)  →  (无 draw)  →  present ✓   driver=OpenGL
```

Flash 走硬件驱动、clear/present 都成功，但**它的几何绘制根本不经过"默认帧缓冲"**。
这正是 87 的 **front-buffer 邮箱模型**：

- 87：插件 GL 把内容画进**自己的 FBO**（该 FBO 的颜色附件就是 front-buffer 的共享图像纹理），
  `SwapBuffers` 只负责 `TakeFrontBuffer` 把邮箱交出去；
- 我们恢复的（M68 之前）：把共享图像**附加成默认帧缓冲**，期待 Flash 直接画到 FB 0。

在 87 模型下"FB 0 上没有绘制"是**完全正常的**——因为内容在 Flash 自己的 FBO 里。
所以白屏的真实原因不是"Flash 不画"，而是**这套 front-buffer 机制没搬**：
我们既没有把共享图像纹理交给 Flash 当 FBO 附件，也没有 `TakeFrontBuffer/ReturnFrontBuffer` 通路。

### 5. 下一轮（方向已经明确，不再是猜）

按 87 的实现移植 front-buffer 机制：

1. `ppapi/proxy/ppb_graphics_3d_proxy.cc`：`DoSwapBuffers` 补 `gl->SwapBuffers(swap_id_++)` +
   `PpapiHostMsg_PPBGraphics3D_TakeFrontBuffer`
2. 渲染侧 `PPB_Graphics3D_Impl`：实现 `TakeFrontBuffer` / `ReturnFrontBuffer` /
   `mailboxes_to_reuse_`，`CommitTransferableResource` 改用 `TransferableResource::MakeGL`
3. 140 上游已无 `TakeFrontBuffer` 消息 → 需要按 87 补 IPC 定义 + 服务端处理
4. 验证：`Stage3DReport` 仍报 `driver=OpenGL`，且 `Stage3DVisual` 页面变红

> 附带确认：`[g3dcaps] bind_gen_res=0 max_tex_units=32 max_vertex_attribs=16 num_compressed=31
> gl_version=2.0 max_renderbuffer=16384`（`max_viewport=0x0` 待观察，可能也需要补齐）
---

## 二十一、P3 结果：Flash 侧链路正常，但"零绘制"其实是**探针自己的局限**

### 1. 新工具链：Flash 主动上报（HTTP）

`tests/flash-probes/Stage3DSteps.as`：逐步调用并把每步结果用 `URLLoader` 发回 `127.0.0.1:8099`，
从 electron 日志的 `rep?tag=...` 行读取。**这是目前唯一能看到 Flash 内部状态的通道**
（flashlog 在 PPAPI 下不产出）。

### 2. 逐步结果（auto = 硬件）

```
start        = mode=auto
driver       = OpenGL                      ← 硬件驱动
limits       = maxBackBuffer=16384x16384
bb           = ok                          ← configureBackBuffer
vb           = ok                          ← createVertexBuffer + upload
clear        = ok                          ← clear(0,0,0,1)
draw_noprog  = 2007:Error #2007            ← 我们故意不设 program，Flash 正常报错
present      = ok
readback     = 3692:Error #3692            ← drawToBitmapData 被 Flash 拒绝
```

强制软件模式对照：

```
driver       = Software Hw_disabled=explicit
limits       = maxBackBuffer=2048x2048
（其余步骤与 auto 完全一致）
```

### 3. 关键修正：**"零绘制"不能证明 Flash 内部 bail**

我们之前的探针**从来没有创建一个 `Program3D`**（需要 AGAL 字节码）。
Flash 的 Stage3D 只有在应用上传 program 之后才会编译着色器、才会发 `CreateProgram/CreateShader/
LinkProgram`，也才有东西可以 draw。

所以 decoder 只看到 clear + BindBuffer 是**必然结果**，不是异常：
- `configureBackBuffer` → 分配 FBO（BindBuffer 是顶点缓冲）✅
- 没有 program → 没有 draw ✅ 正常
- `present` 成功 ✅

同时这解释了 `drawToBitmapData` 的 `#3692`：没有有效 program/帧内容时 Flash 直接拒绝回读。

### 4. 白屏的新解释（下一步验证）

在没有 program 的情况下，Flash 的 `clear()` 落到：
- 它自己的离屏 FBO（`draw_fb=3`）
- 默认帧缓冲（`draw_fb=2`，但清的是白色舞台底色）

`present()` 在 140 里**没有实现路径**（`DoSwapBuffers` 只有声明、无实现，客户端也没有
`SwapBuffers` 命令），所以"清成红色再 present"这种最小用例看到白色是合理的。

**但对真实游戏（会往 FB 0 直接绘制）来说，我们"FB 0 直接映射共享图像"的方案可能本来就是对的** ——
这一点必须用**真正会 draw 的 SWF** 才能判定。

### 5. 下一轮（二选一，都需要"会画的 SWF"）

1. **写一个最小 AGAL 编码器**（4 条指令：`mov op,va0` / `mov oc,fc0`），让探针真正上传 Program3D 并
   `drawTriangles`，观察 decoder 是否出现 program/draw 命令、画面是否变红
2. **直接找一个公开的 Stage3D 示例 SWF**（Starling/Away3D demo）跑一遍，看是否出画面

拿到"会画的 SWF"之前，不要再动 front-buffer/swap 移植（Track-2）——当前证据不支持它是白屏主因。
---

## 二十二、真·Stage3D 绘制跑通到命令层：Flash 的硬件链路完全正常

### 1. 借用现成件（不自己写）

| 需要的东西 | 来源 | 说明 |
| --- | --- | --- |
| AGAL 汇编器 | **Adobe 官方 `AGALMiniAssembler.as`**（30 KB，BSD 许可） | 经 `api.github.com` 取回（`raw.githubusercontent.com` 被墙，`api.github.com` 可用），存于 `tests/flash-probes/vendor/com/adobe/utils/` |

### 2. 探针：`Stage3DDrawTri.as`（真正上传 Program3D + drawTriangles）

AGAL：顶点 `mov op, va0`、片元 `mov oc, fc0`；索引缓冲 + 三角形覆盖全屏。

AS3 逐级上报：

```
driver  = OpenGL          bb = ok        vb = ok        ib = ok
agal    = v=31B f=31B     program = uploaded
setup   = ok              clear = ok     draw = ok      present = ok
```

### 3. 解码器命令普查（这次有真绘制）

```
[g3dc] CreateProgram    this=0x1efc001f3000 a=3
[g3dc] CompileShader    ×2   (a=1, a=2)
[g3dc] LinkProgram      a=3
[g3dc] UseProgram       a=3 / a=0
[g3dc] DrawElements     a=3        ← 真的画了
```

**结论：Flash 的硬件 Stage3D 链路（建 program → 编译 → 链接 → 使用 → 绘制）在 140 上完全正常。**
之前的所有"零绘制"都是因为我们探针没上传 program —— 已彻底澄清。

### 4. 但画面仍是白：绘制没有落到"被提交的那张图"

帧末（detach 前）回读外部 FBO：

```
[g3dpx] frame-end center=0,0,0,255   corner=0,0,0,255     ← 黑
[g3dpx] frame-end center=255,255,255,255                  ← 白（Flash 舞台底色）
```

即：我们的 `DrawElements` 画进了 **Flash 自己的离屏 FBO**，而 `present()` 之后没有任何"合成到
FB 0"的动作 —— 因为 140 里**swap/present 通路不存在**：

```
gpu/command_buffer/client/…         : 无 SwapBuffers
gpu/command_buffer/service/…        : DoSwapBuffers 只有声明，无实现
gpu/command_buffer/common/…         : 无 kSwapBuffers 命令
```

### 5. 87 可抄的量（已量化）

```
gles2_cmd_decoder_passthrough_doers.cc          : 21 处
gles2_cmd_format_autogen.h                      : 28 处
gles2_cmd_decoder_passthrough_handlers_autogen.cc: 8 处
gles2_cmd_decoder_passthrough.cc / .h           : 6 / 2 处
gles2_cmd_ids_autogen.h                         : 2 处
gles2_cmd_helper_autogen.h                      : 6 处
gles2_interface_autogen.h                       : 2 处
gles2_command_buffer_stub.cc                    : 4 处
```

约 **10 个文件 / 80 行**，全部可从本地 `87.0.4280.0` tag 直接取（`git show`）。

### 下一轮

按 87 逐文件抄 swap 链：`gles2_interface_autogen` → `gles2_cmd_helper_autogen` →
`gles2_cmd_ids/format_autogen` → `handlers_autogen` → `doers` → stub 回调，
然后 `ppb_graphics_3d_proxy.cc` 里恢复 `gl->SwapBuffers(swap_id)`。
验收：`Stage3DDrawTri` 页面出现红色三角形（背景深蓝）。
---

## 二十三、绘制目标定位：Flash 画进**自己的 FBO 3**，present 不发任何 GL 命令

### 实测命令序列（`Stage3DDrawTri`，真实 program + drawTriangles）

```
[g3dseq] BindFramebuffer this=0x62c001f3000 target=0x8d40 fb=1     ← Flash 绑定自己的 FBO（client 1）
[g3dc]   DrawElements    this=0x62c001f3000 a=3 draw_fb=3          ← 画进 service FBO 3
（present() 之后：无 BindFramebuffer(0)、无 Copy/Blit、无 draw）
```

同一次运行里还探了 `CopyTexImage2D` / `CopySubTextureCHROMIUM` / `BlitFramebufferCHROMIUM`，
**全部 0 次**。

### 结论

1. Flash 的 Stage3D 把场景渲染到**自己的离屏 FBO**（service 3），这是它的"3D 图层"纹理；
2. `present()` 在 GL 层**什么也不发**；
3. 因此"合成到默认帧缓冲"这一步完全依赖 **浏览器侧的 swap/present 实现** ——
   而 140 里这套东西不存在（`SwapBuffers` 客户端 API、`kSwapBuffers` 命令、`DoSwapBuffers` 实现全被删）。

这与 §二十 的 87 分析完全一致：**87 的 `gl->SwapBuffers(swap_id)` 就是触发"把 back buffer 变成
front buffer 邮箱"的那一步**，缺了它，Flash 画得再对也上不了屏。

### 下一轮：照 87 抄（文件与量已列在 §二十二）

顺序建议：
1. `gles2_cmd_ids_autogen.h` + `gles2_cmd_format_autogen.h`（命令定义）
2. `gles2_cmd_helper_autogen.h` + `gles2_interface_autogen.h`（客户端 API）
3. `gles2_implementation.cc/.h`（`SwapBuffers` 实现）
4. `gles2_cmd_decoder_passthrough_handlers_autogen.cc` + `doers.cc`（解码器侧）
5. `gles2_command_buffer_stub.cc`（swap 回调 → 客户端通知）
6. `ppapi/proxy/ppb_graphics_3d_proxy.cc`：`DoSwapBuffers` 里补 `gl->SwapBuffers(swap_id_++)`

验收标准：`Stage3DDrawTri.html` 出现**深蓝背景 + 红色三角形**（当前整屏白）。
---

## 二十四、Swap 链已按 87 抄回（提交 `1a23dc419e828`）

### 抄了哪些（全部 `git show 87.0.4280.0:<path>` 取原文，未自创）

| 层 | 文件 | 内容 |
| --- | --- | --- |
| 命令 ID | `gles2_cmd_ids_autogen.h` | `OP(SwapBuffers) /* 594 */` |
| 命令结构 | `gles2_cmd_format_autogen.h` | `struct SwapBuffers`（header / swap_id_0 / swap_id_1 / flags，16B，含 4 条 static_assert） |
| 客户端 helper | `gles2_cmd_helper_autogen.h` | `SwapBuffers(swap_id, flags)` |
| 客户端实现 | `gles2_implementation.{h,cc}` | `GLES2Implementation::SwapBuffers()`（照 87，去掉 token 排队） |
| 解码器 passthrough | `..._handlers_autogen.cc` / `..._doers.cc` | `HandleSwapBuffers` / `DoSwapBuffers` |
| 解码器 validating | `gles2_cmd_decoder_autogen.h` | `HandleSwapBuffers`（分发表要求，无副作用） |
| PPAPI | `ppb_graphics_3d_proxy.{h,cc}` | `swap_id_` + `gl->SwapBuffers(swap_id_++)` |

### 验证

- 构建通过；解码器确认收到 swap（`GLES2DecoderPassthroughImpl::DoSwapBuffers` 的 VLOG）
- **2D 回归无问题**：FlxInvaders `interactive=3` digests `3bff0228b584/ff634578e649/c3e2ad17e1fb`；
  Canabalt `interactive=3` digests `843ba05b1b26/c5e1e125c1af/fea605c67aad`，均无 CHECK/FATAL
- Stage3D（`Stage3DDrawTri`）：AS3 全链路 ok（driver=OpenGL … draw=ok … present=ok）

### 仍然白屏 —— 新的关键观察

在 swap 已可用的前提下重跑命令序列探针，解码器只看到：

```
[g3dseq] Clear draw_fb=2  ×3      ← 我们的共享图像 FBO
[g3dseq] Clear draw_fb=3  ×2      ← Flash 自己的离屏 FBO
```

**没有 program/shader/draw 命令到达这个解码器**，而 AS3 侧 `program uploaded`、`draw=ok` 都成立。
即：这一轮的 Stage3D 绘制**不在我们观测到的这个命令缓冲里执行**（进程里存在两个 decoder 实例）。

### 下一轮

1. 给两个 decoder 实例做**独立计数**（不要用全局 static），确认 Flash 的 3D 命令究竟落在哪个实例；
2. 若落在另一个实例，确认它拿到的是哪个 SharedImage（邮箱必须与 renderer commit 的一致）；
3. 之后再决定是否补 87 的 `EmulatedColorBuffer` front/back 双缓冲语义。
---

## 二十五、✅ Stage3D 真正出画面了（提交 `738b0b15e79c5`）

### 两处"140 删了、恢复时漏了"的部件

| # | 部件 | 症状 | 修复 |
| --- | --- | --- | --- |
| 1 | **3D SwapBuffersACK 的触发点** | 整场只有 **1 次** `DoSwapBuffers`，Flash `present()` 后永远等不到 ACK，渲染循环停摆（`ENTER_FRAME` 不推进），画面全白 | 140 删掉了 `WebLocalFrameClient::DidCommitAndDrawCompositorFrame`（它原是 `ViewInitiatedPaint()` 的唯一调用点）。新增 `RequestSwapAckAfterPresentation()`：commit 之后用 `WebFrameWidget::InsertVisualStateRequest()`（与 2D FlushAck 同一套"呈现后回包"机制）回调里发 ACK |
| 2 | **GPU 进程崩溃** | `FATAL gles2_external_framebuffer.cc:310 DCHECK failed: fbo_ == 0u (2 vs 0)` → `The GPU process has crashed 1 time(s)` | 138 的 `Destroy()` 会显式销毁 `external_default_framebuffer_`，140 移植漏了；照 138 补上销毁与 `IsEmulatedFramebufferBound()` 判空 |

### 验证（Flash 29.0.0.171 / Chromium 140）

修好之后的实测：

```
DoSwapBuffers 次数: 336          ← 渲染循环跑起来了
AS3: loop = 5 frames drawn      ← ENTER_FRAME 正常推进
解码器命令序列:
  BindFramebuffer fb=1
  DoDrawElements/DrawElements v=3 draw_fb=3
  BindFramebuffer fb=0          ← 合成回默认帧缓冲
```

画面：

- `Stage3DDrawTri`（真 Program3D + 每帧 clear/draw/present）→ **整屏红色三角形**
- `Stage3DVisual`（只 clear 红）→ **整屏红**

### 2D 回归

| 项 | 结果 |
| --- | --- |
| FlxInvaders | `interactive=3`，digests `eb1385667005 / 6fda809f6a7d / 97b90b4a68ab`，无 CHECK/FATAL |
| Canabalt | `interactive=3`，digests `1443341587cb / 42c43866a601 / fea605c67aad`，无 CHECK/FATAL |

### 至此 140 移植的功能面

| 能力 | 状态 |
| --- | --- |
| 2D 渲染 / 输入 / 视频 / LSO / 全屏 / navigateToURL / 嵌入字体 | ✅ |
| **Stage3D 硬件加速（OpenGL 驱动）** | ✅ **首次打通** |
| 剪贴板 / 右键菜单 / DRM / 打印 / 光标 | ⚠️ 未实现（已登记） |
---

## 二十六、与 87 实测对比：**Stage3D 已达功能与性能对等**（提交 `b04ebf8fc2512`）

用同一套探针（`Stage3DDrawTri`：AGAL 上传真 Program3D + 每帧 clear/draw/present）分别跑
**本体项目 Electron 11 / Chromium 87** 与 **我们的 Chromium 140 移植**。

### 数据

| 指标 | 87（Electron 11） | 140（本移植） | 差异 |
| --- | --- | --- | --- |
| `Context3D.driverInfo` | `OpenGL` | `OpenGL` | 一致 |
| bb / vb / ib / AGAL / program / setup / clear / draw / present | 全 ok | 全 ok | 一致 |
| Context3D 就绪 | 10 ms | 14 ms | +4 ms（一次性） |
| 首帧 present | 19 ms | 32 ms | +13 ms（一次性） |
| 150 帧耗时 | 6239 ms | 6208 ms | −31 ms（0.5%，噪声级） |
| 稳态帧间隔 | ≈41.6 ms | ≈41.4 ms | 一致（受测试环境刷新率限制） |
| 画面 | 红色三角形 | 红色三角形 | 一致 |
| 文字 + 3D 同页（`Stage3DProbeDirect`） | `driver=OpenGL / RESULT=OK`，6 行文字 | 完全相同 | 一致 |

### 另外：2D-GPU 路径也已对齐（提交 `b04ebf8fc2512`）

87 的 `is_3d_supported` 为 true（2D 也走 GPU）。我们此前因为"2D-GPU 白屏"把它留成 false，
现在查明那个白屏与 2D 无关 —— 根因就是 3D SwapBuffersACK 断流 + GPU 进程崩溃，
两处修好后 2D-GPU 正常。于是三个字段全部与 87 一致：

| 项 | 结果 |
| --- | --- |
| FlxInvaders（2D-GPU） | `interactive=3`，画面正常，无 CHECK/FATAL |
| Canabalt（2D-GPU） | `interactive=3`，画面正常，无 CHECK/FATAL |
| Stage3DDrawTri | 217 次 swap、红三角、无崩溃 |

### 仍然存在的机制差异（不影响显示效果）

| 项 | 87 | 我们 |
| --- | --- | --- |
| front buffer | stub/解码器侧 `TakeFrontBuffer` 邮箱 + back→front 拷贝 | FB 0 直接绑定共享图像（省掉拷贝），swap 命令保留但 doer 只做记录 |
| `gl->SwapBuffers` | 有（解码器 swap 回调链依赖） | 已照 87 补回命令链，doer 简化为 no-op（因无需拷贝） |

结论：**显示效果与帧率与 87 完全一致**；机制上是等价简化，不是缺失。