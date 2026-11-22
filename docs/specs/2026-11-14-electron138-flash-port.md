# Electron 37 / Chromium 138 单内核 Flash 移植历程

> 记录时间：2026-11-13 晚 ~ 2026-11-14
> 目标：不用双内核、不用 CEF，在**自建的 Electron**单内核上跑原生 PPAPI Flash
> 版本策略：138（Electron 37）优先；打不通再回退 132；打通后逐步上探
> 相关文档：[`2026-11-11-qax-chromium102-flash.md`](https://github.com/Sutanm/BaoFlashBrowser/blob/8973e6a/docs/specs/2026-11-11-qax-chromium102-flash.md)（前期调研与路线论证）

---

## 0. 结论摘要（截至 2026-11-14 22:15）

| 项 | 状态 |
| --- | --- |
| 138 源码获取 | ✅ 本地完整历史（1,866,841 提交，tag 到 149） |
| 138 构建（带 PPAPI） | ✅ `out\Testing\electron.exe` 299 MB，`v37.0.0` / `138.0.7204.35` |
| Flash DLL 加载 | ✅ `PPP_GetInterface` 调用成功 |
| Flash 初始化 | ✅ `PPP_InitializeModule` **成功**（`init OK`） |
| 方案选择 | **A**：移植 87 的 ppapi 代理 + 渲染/浏览器宿主（与厂商一致） |
| 当前阶段 | **Phase 1 完成，Flash 已出帧**（见 §6.5） |
| 出帧 | ✅ 已用 `FlxInvaders.swf` 验证渲染（2026-11-14 23:45） |

---

## 1. 时间线与关键事件

| 时间 | 事件 | 结果 |
| --- | --- | --- |
| 11-13 白天 | 确认 138 是 PPAPI 源码最后可用版本；Electron 37 = 138 | 决策基线 |
| 11-13 晚 | 下载 Chromium git 缓存（46 个对象，14.38 GB） | 多次限速、换 IP 续传 |
| 11-13 23:58 | aria2 直连/代理交替，最后 3 个 pack 完成 | 46/46 校验通过 |
| 11-14 00:09 | 校验全部对象 SHA 尺寸 | ✅ |
| 11-14 00:12 | 用本地 bare 仓库 clone 出 Chromium 工作树（517,621 文件，131 s） | ✅ |
| 11-14 00:15 | **事故**：清理进程的正则误杀 DSH 桌面端渲染进程 | 应用崩溃，构建资产无损 |
| 11-14 10:16 | 切到 138（Electron v37.0.0 + Chromium 138.0.7204.35） | 本地 checkout，零下载 |
| 11-14 10:30 | gclient sync 卡在本地 fetch 重打包 14 GB | 用 git `alternates` 解决 |
| 11-14 11:27 | DEPS 依赖同步完成（222 个依赖块） | ✅ |
| 11-14 11:44 | runhooks：dugite 内嵌 Git 下载被墙 | 手动下载 tarball + sha256 校验 |
| 11-14 11:51 | 二次 runhooks 因 patch 已应用失败 | `git am --abort` 清理 |
| 11-14 12:10 | ATL 缺失 → 安装 `Microsoft.VisualStudio.Component.VC.ATL` | ✅ |
| 11-14 12:20 | 缺 `LASTCHANGE` / `DAWN_VERSION` / `skia_commit_hash.h` / 内置 `rc.exe` | 手动补 hook |
| 11-14 14:22 | OOM（`LLVM ERROR: out of memory`） | 降到 `-j 12` |
| 11-14 14:58 | `gn.bat` 缺失导致 node `config.gypi` 失败 | 补 `gn.bat` 包装 |
| 11-14 15:08 | 首次构建成功 | `electron.exe` 297 MB |
| 11-14 15:09 | 发现二进制里**没有 PPAPI** | 根因：`enable_ppapi` 依赖 `enable_nacl`（ChromeOS 专属） |
| 11-14 15:18 | 改 `enable_ppapi` 后重编 | 34k 目标 |
| 11-14 17:27 | `PlatformThreadId` 强类型漂移（ppapi shared_impl） | 修复 |
| 11-14 18:44 | 带 PPAPI 的构建成功（299 MB） | ✅ |
| 11-14 19:01 | Flash 注册成功、ppapi 子进程启动后崩溃 `0x80000003` | 定位到 sandbox type |
| 11-14 19:09 | 修 `sandbox_type.cc`：Windows 上 `--type=ppapi` 返回 `kNoSandbox` | ✅ |
| 11-14 19:10 | Flash 加载成功但 `PPP_InitializeModule` 返回 **-2** | 缺 `PPB_Flash_*` 宿主接口 |
| 11-14 19:30 | 方案 B（进程内实现）写了一半后按用户要求改回 **A** | B 已回滚 |
| 11-14 19:51 | Phase 1 开始：合并 87 的 ppapi Flash 层 | 见 §6 |
| 11-14 21:41 | 首批漂移错误（`base/macros.h` 等） | 逐项修复 |
| 11-14 22:15 | 仍在编译（blink 段），0 错误 | 进行中 |

---

## 2. 源码获取：一次下载，终身增量

### 2.1 下载策略

- Chromium 官方 git 缓存以 **GCS 桶对象** 形式提供（46 个对象，14.38 GB）；
- 单连接被限速到 ~500 KB/s，用 aria2 **多连接**（`-x 16 -s 16 -j 7~9`）可到 3–7 MB/s；
- 限速是按**出口 IP 配额**的：换节点/换 IP 可重置，代理与直连交替最有效；
- 断点续传必须保留 `.aria2` 控制文件，不要删缓存目录。

### 2.2 组装与校验

```powershell
# 46 个对象与桶列表逐个比对尺寸，全部一致
ok=46 bad=0
```

### 2.3 关键技巧：git `alternates`

把下载好的 bare 仓库作为对象源，工作树通过 alternates 共享对象，**gclient 的 fetch 只更新引用、不搬 14 GB**：

```
D:\electron-build\cr\src\.git\objects\info\alternates
  → D:\git_cache\chromium.googlesource.com-chromium-src\objects
```

没有这一步时，`gclient sync` 会用本地传输重新打包 14 GB（`pack-objects` 吃 7 GB 内存、跑十几分钟）。

### 2.4 本地历史的价值

`D:\git_cache\chromium.googlesource.com-chromium-src` 是**完整历史镜像**：

| 事实 | 值 |
| --- | --- |
| 可达提交 | 1,866,841 |
| 本地可解析 tag | 到 `149.0.7827.95` |
| 138 / 140 提交对象 | 本地都有 |

→ 切版本只需 `git checkout <tag>`，**不需要重新下载 Chromium 源码**。

---

## 3. 构建阶段：4 道"注册门" + 4 个工具链坑

### 3.1 四道注册门（全部已修）

| # | 现象 | 根因 | 修复 |
| --- | --- | --- | --- |
| 1 | 二进制无 PPAPI 字符串 | `ppapi/buildflags/buildflags.gni`：`enable_ppapi = enable_plugins && enable_nacl && !is_fuchsia`，而 `enable_nacl = ... && target_os == "chromeos"` | 改为 `enable_ppapi = enable_plugins && !is_fuchsia` |
| 2 | `--register-pepper-plugins` 不生效 | `content/common/pepper_plugin_list.cc` 的 MIME 白名单只允许测试插件 | 白名单加入 `application/x-shockwave-flash`、`application/futuresplash` |
| 3 | 插件仍不注册 | `ComputePepperPluginList` 还需 `--allow-command-line-plugins` | 启动参数补上 |
| 4 | ppapi 子进程秒崩 `0x80000003` | `sandbox/policy/sandbox_type.cc` 的 `--type=ppapi` 映射被 `&& !BUILDFLAG(IS_WIN)` 排除，触发 `NOTREACHED` | Windows 分支返回 `Sandbox::kNoSandbox` |

### 3.2 四个工具链坑

| 坑 | 现象 | 修法 |
| --- | --- | --- |
| VS 检测失败 | `No supported Visual Studio can be found` | `vs2022_install=C:\BuildTools` |
| ATL 缺失 | `'atldef.h' file not found` | 安装 `Microsoft.VisualStudio.Component.VC.ATL` |
| 生成文件缺失 | `LASTCHANGE` / `DAWN_VERSION` / `gpu_lists_version.h` / `skia_commit_hash.h` | 手动执行 Chromium DEPS 里对应的 `lastchange.py` hook |
| 内置 `rc.exe` 缺失 | `Vulkan.res` 编译时 `FileNotFoundError` | 从 `gs://chromium-browser-clang/rc/<sha1>` 直下并校验 SHA1 |
| node `config.gypi` 失败 | `gn.bat` 不存在 | 在 `buildtools/win` 建 `gn.bat` 包装 `gn.exe` |

### 3.3 构建参数（当前）

```gn
import("//electron/build/args/testing.gn")
enable_plugins = true
symbol_level = 1
```

> 注意：**不要轻易改 `args.gn`**——每次改动都会触发一次大范围重编（30–40 分钟到 2 小时）。

---

## 4. 运行阶段实测

### 4.1 插件进程 trace（自建 trace 文件）

```text
main: enter
main: before ChildProcess
PpapiThread: ctor enter
main: run_loop
OnLoadPlugin: enter
OnLoadPlugin: library loaded
OnLoadPlugin: got get_interface      ← PPP_GetInterface 成功
OnLoadPlugin: calling initialize_module
OnLoadPlugin: init FAILED            ← 返回 -2
OnCreateChannel
```

### 4.2 Flash 请求的宿主接口（`GetBrowserInterface` 记录）

| 接口 | 结果 |
| --- | --- |
| `PPB_Core;1.0`、`PPB_AudioConfig;1.1`、`PPB_Audio;1.1`、`PPB_AudioInput(Dev);0.4` | OK |
| `PPB_BrowserFont_Trusted;1.0`、`PPB_Buffer(Dev);0.4`、`PPB_CharSet(Dev);0.4` | OK |
| `PPB_Crypto(Dev);0.1`、`PPB_CursorControl(Dev);0.4`、`PPB_FileChooser(Dev);0.6`、`PPB_FileChooserTrusted;0.6`、`PPB_FileRef;1.2` | OK |
| **`PPB_Flash_Clipboard;5.1 / 5.0 / 4.0`** | **NULL**（第一个缺失） |

### 4.3 结论

- 138 上 **CFG 没有复现** 102 的 fastfail（`PPP_GetInterface` 调用成功）；
- 卡点从"能加载"变成"缺 Flash 私有宿主层"，与 102/132 的病因一致；
- 138 的 `ppapi/` 里 **没有任何 flash 文件**（`c/private`、`proxy`、`thunk` 全空），但 `PERMISSION_FLASH` 位还在。

---

## 5. 方案选择：A vs B

| 维度 | A：移植 87 宿主层 | B：进程内本地实现 |
| --- | --- | --- |
| 代码量 | 50–80 文件，依赖 chrome/browser | 2 个新文件 |
| 版本升级成本 | 每个大版本都要跟 chrome API 漂移 | 基本不动 |
| 浏览器能力 | 原生（新标签/代理/打印/全屏/DRM） | 只能回退实现 |
| 安全语义 | 与 Chromium 原设计一致 | 插件进程内直接做 |
| 与厂商一致性 | 更接近（360/奇安信） | 自创路线 |

**决策：A。** 理由是"版本越高越好"的长期目标下，需要完整的浏览器能力（代理、全屏、跳转对游戏站点是刚需），且与厂商路径一致、参考资料多。B 已回滚。

---

## 6. Phase 1：ppapi 层移植

### 6.1 从 87 提取的文件

| 类别 | 文件 |
| --- | --- |
| 接口头 | `ppapi/c/private/ppb_flash*.h`（9 个）、`ppp_flash_browser_operations.h` |
| 代理 | `ppapi/proxy/flash_{clipboard,drm,file,font_file,fullscreen,menu,resource}.*`、`ppb_flash_message_loop_proxy.*`、`serialized_flash_menu.*` |
| thunk | `ppapi/thunk/*flash*`（19 个）、`interfaces_ppb_private_flash.h` |
| shared | `flash_clipboard_format_registry.*`、`ppb_flash_font_file_shared.h`、`ppp_flash_browser_operations_shared.*` |

### 6.2 合并/接线

| 文件 | 改动 |
| --- | --- |
| `ppapi/proxy/ppapi_messages.h` | 4 个 include、3 个 enum traits、`FlashSiteSettings` struct traits、**35 条** Flash IPC 消息 |
| `ppapi/proxy/serialized_structs.{h,cc}` | `PPBFlash_DrawGlyphs_Params` |
| `ppapi/proxy/ppapi_param_traits.{h,cc}` | `PPBFlash_DrawGlyphs_Params`、`SerializedFlashMenu` 的序列化 |
| `ppapi/shared_impl/singleton_resource_id.h` | 补回 `FLASH_CLIPBOARD/FILE/FULLSCREEN/FLASH_SINGLETON_ID` |
| `ppapi/thunk/resource_creation_api.h` + `ppapi/proxy/resource_creation_proxy.{h,cc}` | 补 `CreateFlash{DRM,FontFile,Menu,MessageLoop}` |
| `ppapi/proxy/interface_list.cc` | `PERMISSION_FLASH` 注册段 |
| 三个 `BUILD.gn` + `thunk.h` | 源文件与声明接线 |

### 6.3 87 → 138 漂移修复清单（11 项）

| 漂移 | 修法 |
| --- | --- |
| `base/macros.h` 已删除 | 移除 include |
| `DISALLOW_COPY_AND_ASSIGN` 已删除 | 改 `= delete` 拷贝构造/赋值 |
| `base/stl_util.h`、`base::size` 已删除 | 移除 include，改 `std::size` |
| `base/callback_forward.h` 改名 | `base/functional/callback_forward.h` |
| `FLASH_*_SINGLETON_ID` 不存在 | 补回 enum 值 |
| `ResourceCreationAPI` 缺 Flash 创建函数 | API + Proxy 补实现 |
| `PpapiGlobals::GetCmdLine()` 删除 | 直接读 `--ppapi-flash-args` 开关 |
| `PpapiGlobals::PreCacheFontForFlash()` 删除 | 空实现 |
| `NOTREACHED()` 变 noreturn | 删掉其后的 `return` |
| `PP_Flash_Menu` 未声明 | 补 `ppb_flash_menu.h` |
| 脚本插入的转义错误 | 修正 include 行 |

### 6.5 结果（2026-11-14 23:45，Phase 1 完成）

构建通过后重跑测试页，取得决定性结果：

```text
OnLoadPlugin: enter
OnLoadPlugin: library loaded
OnLoadPlugin: got get_interface
OnLoadPlugin: calling initialize_module
OnLoadPlugin: init OK          ← PPP_InitializeModule 成功
OnCreateChannel
```

Flash 请求的宿主接口（`ppapi-ifaces.log`）全部返回 OK：

| 接口 | 结果 |
| --- | --- |
| `PPB_Flash_Clipboard;5.1` | OK（此前为 NULL） |
| `PPB_Flash_File_FileRef;2` / `PPB_Flash_File_ModuleLocal;3` | OK |
| `PPB_Flash_FontFile;0.2` | OK |
| `PPB_FlashFullscreen;1.0` | OK（需补注册，见下） |
| `PPB_BrokerTrusted;0.3` | NULL（Flash 不需要） |

**渲染验证**：把测试页的 `button.swf` 换成 `FlxInvaders.swf`（68 KB 游戏），截图显示完整游戏画面（"WELCOME TO FLX INVADERS" + 彩色精灵阵列），三态截图摘要为 3。

**结论**：Chromium 138 + 自建 Electron 37 上，原生 PPAPI Flash **已经能加载、初始化并渲染帧**。

同时观测到的功能缺口（非阻塞）：

- `ppapi\host\ppapi_host.cc:249 Resource host creation failed.` —— Flash 私有宿主（剪贴板/文件/全屏等）在浏览器/渲染进程侧还不存在，相关 IPC 调用会返回错误；
- 因此**剪贴板、代理设置、导航、全屏、LSO 限制**等功能仍待 Phase 2/3 补齐；**渲染与动画已经可用**。

### 6.6 剩余预期（修正）

原计划"Phase 2/3 完成才能出帧"被实测推翻：**插件侧移植（Phase 1）已足以渲染**。
Phase 2/3 现在只影响**外围功能**（剪贴板/代理/导航/全屏/LSO），按需逐一补。
### 6.4 剩余预期

- `flash_*_resource.cc`（代理资源）可能还有 `base::Bind` → `BindRepeating/BindOnce`、`TrackedCallback` 等漂移；
- 编过之后 link `electron.exe` 即 Phase 1 完成，**验收标准是"接口非 NULL"**，不是出帧。

---

## 7. 后续计划

| 阶段 | 内容 | 预计 |
| --- | --- | --- |
| Phase 2 | 渲染进程宿主：`pepper_flash_{font_file,fullscreen,menu,renderer,drm}_host` + 宿主工厂 + Electron 渲染端接线 | 1–2 天 |
| Phase 3 | 浏览器进程宿主：`pepper_flash_browser_host`、剪贴板过滤器、DRM、`chrome_browser_pepper_host_factory`、`chrome/common/pepper_flash` + Electron 浏览器端接线 | 2–3 天 |
| Phase 4 | 出帧联调、全屏/代理/跳转/LSO 回归 | 0.5–1 天 |

风险最高的两处：

1. `PPB_FlashFullscreen` 依赖 `RenderWidget`/`WebPluginContainer`，与合成器耦合；
2. `PepperFlashBrowserHost` 依赖 Profile/代理/站点设置，需要改造为 Electron Session。

---

## 8. 复现指南

### 8.1 环境

```powershell
$env:DEPOT_TOOLS_WIN_TOOLCHAIN = '0'
$env:vs2022_install = 'C:\BuildTools'
$env:PATH = 'C:\Users\<user>\AppData\Local\Programs\Python\Python311;...\Scripts;D:\electron-build\cr\src\buildtools\win;' + $env:PATH
```

### 8.2 构建

```powershell
cd D:\electron-build\cr\src
gn gen out/Testing --args="import(`"//electron/build/args/testing.gn`") enable_plugins=true symbol_level=1"
autoninja -C out/Testing electron      # 内存紧张时加 -j 12
```

### 8.3 运行测试页（注意引号）

必须通过 `.cmd` 或正确引用的方式传入参数，PowerShell `Start-Process` 会把带 `#`/`;` 的值拼坏：

```bat
"D:\electron-build\cr\src\out\Testing\electron.exe" ^
  --allow-command-line-plugins ^
  "--register-pepper-plugins=D:\path\pepflashplayer64.dll#Shockwave Flash#Shockwave Flash 34.0 r0#34.0.0.380;application/x-shockwave-flash#swf#spl" ^
  --enable-logging=stderr --v=1 ^
  "D:\java_workspace\BaoFlashBrowser\.cache\electron19\app"
```

### 8.4 调试开关（当前树里的临时补丁，正式提 PR 前应清理）

| 开关 | 位置 | 作用 |
| --- | --- | --- |
| `ppapi-trace.log` | `content/ppapi_plugin/ppapi_thread.cc` 等 | 插件进程生命周期 trace |
| `ppapi-ifaces.log` | `ppapi/proxy/plugin_dispatcher.cc` | Flash 请求的宿主接口清单 |
| `ppapi-child.log` | `content/browser/ppapi_plugin_process_host.cc` | 把日志开关转发给子进程 |
| `[ppdbg]` 日志 | `plugin_service_impl.cc`、`pepper_plugin_list.cc` | 注册流程与子进程退出码 |

---

## 9. 经验与坑

1. **不要用命令行正则批量杀进程**：`Get-CimInstance Win32_Process | Where CommandLine -match ... | Stop-Process` 会匹配到执行命令的 shell 自身；11-14 00:15 曾把 DSH 桌面端渲染进程一起杀掉。
2. **大文件下载用 aria2 多连接 + 换 IP**；单连接会被 Google 限到 ~500 KB/s。
3. **git `alternates` 是避免重复下载 14 GB 的关键**。
4. **GN 改动 = 大重编**：把 `enable_plugins`/`enable_ppapi` 这类开关一次定下来，之后只改源码。
5. **87 代码迁移的固定套路**：先批量替换已知漂移（§6.3），再按编译错误逐个修。
6. **PowerShell 的 `-replace` 插值陷阱**：单引号字符串里的 `` `n `` 不会换行，会写进源码造成 `extra tokens at end of #include directive`。
7. **Debug 构建下 `NOTREACHED()` 是 [[noreturn]]**，其后不能有 `return`。
8. **测试页参数必须用 `.cmd` 传**：`#`、`;`、空格在 PowerShell/Start-Process 里极易被拆坏。

---

## 10. 快速状态速查

| 问题 | 答案 |
| --- | --- |
| 138 能编出带 PPAPI 的 Electron 吗？ | 能（3 道注册门 + 1 个 buildflags 补丁） |
| Flash 能加载吗？ | 能，`PPP_GetInterface` 成功 |
| 为什么没有画面？ | `PPP_InitializeModule` 返回 -2，缺 `PPB_Flash_*` 宿主层 |
| 现在卡在哪？ | Phase 1 编译修复（ppapi 层） |
| 什么时候能出帧？ | Phase 2/3 宿主接上后，整体 4–7 天 |
