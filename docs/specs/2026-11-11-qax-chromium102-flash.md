# 高版本内核上的 PPAPI Flash：奇安信 102 与 360 极速 X 132 复核

> 复核日期：**2026-11-11**。对象：奇安信可信浏览器 1.1.46401.52（安装包内 `chrome.7zz` 解出的
> `Chrome-bin`，32 位）；追加对象：360 极速浏览器 X 23.1.1253.64（Chromium **132**，x64，见 §10）。
> 用途：判断「高版本内核 + 原生 Flash」是否能让项目放弃 `1.2.0` 的
> **双内核**计划或**自编译内核打补丁**计划。
>
> **一句话结论**：通道是真的、是原生 PPAPI（不是 Ruffle 仿真），但它由**厂商私有补丁**实现，
> 且 Windows 上**只加载注册表登记的系统 Flash**。它证明「102 分支能跑原生 Flash」，并给出一个
> 与 Electron 19 同分支（5005）的对照实现；**不能**证明我们「不需要补丁、不需要第二内核」。
>
> **追加（§8）**：进一步实测发现 102 的 content 层注册通道（`--register-pepper-plugins`）根本没被删，
> 恢复「注册层」可能不需要移植任何代码；见第 8 节。
>
> **追加（§10）**：360 极速浏览器 X 在 **Chromium 132 x64** 上同样跑原生 Flash，且
> `--register-pepper-plugins` 能加载我们自带的 DLL；同时发现 Electron 34（同为 132）把 pepper
> 编译掉了。「单内核」的天花板因此从 102 上调到 **Chromium 138**，补丁形态收缩为**一个构建开关**。
>
> 复现：`node tools/probe/host.cjs --only 67`（探针 `67-qax-flash-host`，缺 `BAO_QAX_EXE` 时自动跳过）。

## 1. 被测对象

| 项 | 值 |
| --- | --- |
| 产品版本 | `1.1.46401.52`（`chrome.dll` FileDescription：奇安信可信浏览器） |
| Chromium | `Chrome/102.0.5005.200`，revision `@548f2eb4ba9b68a2820a9c153c0346568de77618` |
| V8 | `10.2.154.26` |
| 分支标记（Linux ARM64 包内字符串） | `48f2eb4ba9b68a2820a9c153c0346568de77618-refs/branch-heads/5005@{#158}` |
| 位宽 | **x86**：`qaxbrowser.exe` 与 `chrome.dll` 的 PE machine 均为 i386，UA 带 `WOW64` |
| 体积 | `chrome.dll` 158.3 MB；`qaxbrowser.exe` 约 4 MB |
| 同分支旧包 | `1.1.45966.52`（同样 102.0.5005.200，行为一致） |
| 其他平台 | 仓库内另有 Linux ARM64 包（`qaxbrowser.elf` 178 MB），说明同一分支还维护 Linux |

包内还带 `ruffle.crx`、`ofd.crx`、`tiff.crx`、`ua.crx` 四个扩展（Ruffle 是它的兜底方案），
以及 `qaxrt.dll` / `qbsrv.exe` / `qaxbrowser_proxy.exe` / `zt_config` / `ukey_config` 等自有组件。

## 2. 实测结果（探针 67 输出）

| 观察项 | 结果 |
| --- | --- |
| `navigator.plugins` | 含 `Shockwave Flash`，`filename = pepflashplayer32_34_0_0_384.dll`，`description = Shockwave Flash 34.0 r0` |
| MIME | `application/x-shockwave-flash` = **true** |
| 插件进程 | `--type=ppapi`，父进程 = `qaxbrowser.exe`；CDP `SystemInfo` 报类型 `Pepper Plugin` |
| 该进程已加载模块 | `…\Chrome-bin\1.1.46401.52\chrome.dll` + `C:\WINDOWS\SysWOW64\Macromed\Flash\pepflashplayer32_34_0_0_384.dll` |
| 真实渲染 | 测试 SWF 在 before / hover / pressed 三态的截图摘要互不相同（真人可辨的蓝→品红） |
| 杀插件进程 | 插件进程消失、SWF 区域变黑（截图摘要变化）、页面 JS 仍执行 → 确为独立的 out-of-process 插件 |
| `--ppapi-flash-path=plugins/win32/pepflashplayer.dll` + `--ppapi-flash-version=34.0.0.330` | **无效**：插件列表仍是系统 `34.0.0.384`，加载的仍是 `SysWOW64` 那个 DLL |

## 3. 机制推断（字符串 + 注册表证据）

`chrome.dll` 内可检索到的相关字符串：

- `SOFTWARE\Macromedia\FlashPlayerPepper`（注册表键）、`pepflashplayer.dll`、`Pepper Plugin`、
  `Shockwave Flash`、`PpapiHost`、`pdf.mojom`；
- **检索不到** `ppapi-flash-path` / `ppapi-flash-version` 两个开关名（ASCII 与 UTF-16LE 都扫过）
  → 它没有走 Chromium 87 那套「命令行指定插件路径」的分支。

本机注册表与之吻合：

```
HKLM\SOFTWARE\Macromedia\FlashPlayerPepper
  Version = 34.0.0.384
  PlayerPath = C:\WINDOWS\system32\Macromed\Flash\pepflashplayer64_34_0_0_384.dll   (64 位视图)
HKLM\SOFTWARE\WOW6432Node\Macromedia\FlashPlayerPepper
  PlayerPath = C:\WINDOWS\SysWOW64\Macromed\Flash\pepflashplayer32_34_0_0_384.dll   (32 位视图，实际使用的那个)
```

Linux 包字符串里则是自带的路径：`libpepflashplayer.so` 与
`/opt/qianxin.com/qaxmultimedia/libflashplayer.so` —— **Linux 自带 Flash，Windows 依赖系统安装**。

解读：Chromium 102 的 PPAPI 宿主从未被删干净（内置 PDF 仍是 PPAPI 插件，`navigator.plugins`
里能看到 `internal-pdf-viewer`）。M88 移除的是 **Flash 的注册 / 加载 / 策略**这一层，而不是
PPAPI 本身。因此「在高版本内核上开出 Flash 通道」= 把「注册 Flash 插件 + 解析本机插件路径」
这一层补回来，并沿用既有的插件进程模型 —— 这是**量级远小于整体移植 PPAPI** 的补丁，
也解释了为什么一家浏览器厂商能长期维护它。

## 4. 对项目的意义

### 4.1 成立（这个发现确实有价值）

1. **可行性从猜测变成实证**：102 分支可以跑原生 PPAPI Flash，且走独立插件进程、能正常出帧与接收输入。
2. **分支对得上**：Electron 19 = Chromium 102 / V8 10.2 / Node 16.14.2
   （[Electron 19.0.0 发布说明](https://www.electronjs.org/blog/electron-19-0)），与奇安信的 5005 分支同源。
   「自编译 Electron 19 + 恢复 Flash 注册层」因此有了一个可对照的行为基准（同一分支、同一 Flash 版本）。
3. **补丁面积可估**：只剩注册/策略层，说明自编译路线的工程量主要是工具链与升级维护，而不是移植 PPAPI。

### 4.2 不成立（还不能因此去掉双内核或自打补丁）

| 障碍 | 说明 |
| --- | --- |
| 没有补丁源码 | 拿不到他们的 Chromium 私有改动；Electron 19 官方包里没有 Flash。想用 102 就必须自己打补丁，或用他们的二进制。（§8 追加实测后有修正：需要的是「插件注册入口」，102 的 content 层仍自带，可能连补丁都不用） |
| 不可嵌入 | 它是一个完整浏览器（32 位 + 自有防护/代理/企业配置），不是库，没有可调用的 API。要用只能当**外挂进程**（窗口嵌入或 CDP 投屏），那仍然是第二个进程/第二个引擎，只是换了所有者。 |
| 不认我们的 Flash | 探针已证 `--ppapi-flash-path` 被忽略，只认系统安装的中国版 Flash 34。项目「自带 PPAPI DLL、开箱即用/绿色」的承诺在它身上失效；而 Flash 已于 2020 停服，中国版还带更新服务与广告。 |
| 第三方依赖 | 许可与再分发、杀软互操作、随其升级漂移、32 位地址空间（现代页面容易 OOM）都不可控。 |
| 内核本身已停更 | Chromium 102 是 2022 年的分支，不再收安全更新。「高版本」只是相对 87。 |

## 5. 路线对比

| 路线 | 内核 | Flash 来源 | 补丁归属 | 主要成本 | 主要风险 |
| --- | --- | --- | --- | --- | --- |
| **A 自编译 Electron 19（单内核）** | 102，自建 | 我们自带的 `plugins/*`（沿用现有 `flash.ts`/`flash-version.ts` 语义） | 自己维护「Flash 注册层」补丁 | 一次性 Chromium/Electron 工具链；每次升级 rebase 补丁 | 构建与签名成本、补丁随版本漂移 |
| **B 外挂 Flash 宿主**（qaxbrowser 或自建 CEF） | 87 外壳 + 外挂引擎 | 系统 Flash（qax）或自带（CEF） | 无 | 帧传输/输入转发/音频通道集成 | 投屏无音频、延迟、窗口嵌入脆弱、依赖第三方安装 |
| **C 双内核**（现 `1.2.0` 计划） | 87 + 现代 Electron | 自带 | 无 | 两套运行时、标签迁移、会话/预加载共享 | 复杂度最高，长期维护两套 Electron |
| D Ruffle 优先（已在用） | 87 | Ruffle | 无 | 兼容性缺口（部分 AS2/老游戏） | 不能覆盖全部站点 |

建议：把 **A** 作为 `1.2.0` 的主线候选（它才是「一个内核」的唯一路径），**B** 只作为调试/应急
兼容模式（例如临时验证某站点在 102 上的行为），**C** 保留为回退。注意 A 与 C 的验收口径都依赖
现有 `62-dual-kernel` / `63-cef-compare` / `66-native-ppapi-frames` 的结论。

## 6. 下一步验证（按性价比排序）

1. **Electron 19 上的最小补丁 spike**：只验证「`webPreferences.plugins` + 插件注册」能否让
   `--type=ppapi` 进程起来并渲染测试 SWF。这是唯一能证明单内核可行的实验（半天~1 天）。
2. **站点兼容补丁在 102 上的回归**：`session-manager.ts` 的 SWFObject 重写 / CORS / `mms.cfg`
   在 qax 102 上是必需、仍然有效、还是已无意义 —— 直接决定 `1.2.0` 要不要保留它们。
   可用同一份 qax 副本跑对照，不必先自建内核。
3. **量化路线 B**：`Page.startScreencast` 在 qaxbrowser 上跑测试 SWF，记录帧率、输入延迟与音频缺口
   （投屏只有视频），据此判断它是否只能当应急模式。
4. **估算补丁面积**：取官方 `102.0.5005.x` 与 qax `chrome.dll` 做字符串/导入表差分，
   列出「他们比上游多出来的 Flash/插件相关符号」，作为自编译补丁的检查清单。

## 7. 证据与复现

- 探针：`tools/probe/probes/67-qax-flash-host.cjs`
  - `BAO_QAX_EXE=<安装目录>\Chrome-bin\qaxbrowser.exe node tools/probe/host.cjs --only 67 --json`
  - 未设环境变量时回落到 `.cache/qax-46401-win/payload/Chrome-bin/qaxbrowser.exe`，都没有则跳过（`ok` 视为 skip）。
  - 断言：`ppapi` 子进程存在、插件已注册、交互出帧、杀进程后 JS 存活；同时输出
    `flashPathHonored`（当前为 `false`，即不能替换 DLL）。
- 过程产物（不进 git，`.cache/` 已被忽略）：`.cache/qax-46401-win/` 下的
  `runtime.json`、`stock-*.png`、`external*.png`、`chrome.7zz`（安装包内原始 7z）与解出的 `payload/`。
- 本文件不记录任何安装包下载地址或账号信息；被测副本仅用于兼容性分析，不再分发。

## 8. 追加实测（同日深夜）：注册层到底删了什么、怎么补回来

> 本节回答「恢复 Flash 注册层」的具体做法。结论先说：**102 的 content 层没有删掉插件机制**，
> 删掉的是「Flash 专属入口 + Chrome 侧策略/资源」。所以恢复工程量远小于移植 PPAPI。

### 8.1 87 → 102 的删除面（`chromium/chromium` 目录 diff，tag `87.0.4280.141` vs `102.0.5005.200`）

| 层 | 仍在（102） | 已删（102 相对 87） |
| --- | --- | --- |
| content 注册 | `content/common/pepper_plugin_list.cc`（`--register-pepper-plugins` 解析仍在，且 `plugin.permissions = ppapi::PERMISSION_ALL_BITS`，注释原文 "Command-line plugins get full permissions"）、`content/browser/plugin_service_impl.cc`（`RegisterPepperPlugins()`）、`content/browser/ppapi_plugin_process_host.cc` | `--ppapi-flash-path` / `--ppapi-flash-version` 两个开关；`content/common/plugin_list.cc`（NPAPI/注册表枚举） |
| content 渲染 | `content/renderer/pepper/*` 全套（`pepper_webplugin_impl.cc`、`pepper_plugin_instance_impl.cc`、`plugin_module.cc` …），`RenderFrameImpl::CreatePlugin` 仍在 `#if BUILDFLAG(ENABLE_PLUGINS)` 内直接 `new PepperWebPluginImpl(...)` | — |
| chrome 策略 | `chrome_plugin_service_filter.cc`（195 行，Flash 分支已被摘掉）、`plugin_finder/plugin_metadata/plugin_installer/plugin_prefs/plugins_resource_service`（现主要服务 PDF） | `flash_permission_context`、`flash_temporary_permission_tracker`、`flash_download_interception`、`flash_deprecation_infobar_delegate`、`plugin_policy_handler`、`plugin_data_remover_helper`、`pdf_plugin_placeholder_observer` |
| chrome Flash 资源 | — | `chrome/browser/renderer_host/pepper/`：`pepper_flash_browser_host`、`pepper_flash_clipboard_message_filter`、`pepper_flash_drm_host`、`device_id_fetcher`；`chrome/renderer/pepper/`：`pepper_flash_renderer_host`、`pepper_flash_fullscreen_host`、`pepper_flash_menu_host`、`pepper_flash_font_file_host`、`pepper_flash_drm_renderer_host` |

构建开关 `ppapi/buildflags/buildflags.gni`（102）：

```
enable_plugins = !is_android && !is_ios && !is_chromecast && !is_fuchsia
```

即桌面端**默认编译 PPAPI**；`content/app/content_main_runner_impl.cc` 里 `--type=ppapi → PpapiPluginMain`
也在 `#if BUILDFLAG(ENABLE_PLUGINS)` 内。Electron 19 仍把 `webPreferences.plugins` 映射成
`prefs->enable_plugins`（`shell/browser/web_contents_preferences.cc`）。

### 8.2 三个实测（本机，2026-11-11 23:0x）

| 实验 | 结果 |
| --- | --- |
| Chromium 102（奇安信副本）加 `--register-pepper-plugins=<自带 pepflashplayer.dll>#Shockwave Flash Test#…#34.0.0.330;application/x-shockwave-flash#swf#spl` | **成功**：`navigator.plugins` 里多出 `Shockwave Flash Test / pepflashplayer.dll`，并拉起 `--type=ppapi` 子进程 → 102 的注册通道仍然可用 |
| Electron 11.5（Chromium 87）用同一条开关 + `plugins: true` | **成功**：插件列表出现 Shockwave Flash，三态截图摘要互不相同（真出帧） |
| Electron 19.0.0（Chromium 102.0.5005.61）用同一条开关（argv 与 `app.commandLine.appendSwitch` 都试过，含 `--no-sandbox`、`--ppapi-in-process`、Adobe 自带签名 DLL） | **失败**：插件注册被接受（`ppapi_plugin_process_host` 打印 `plugin process crashed`），`--type=ppapi` 子进程秒退，退出码 `0x80000003`（STATUS_BREAKPOINT，即 release 版 CHECK/NOTREACHED），页面无 Flash |

复现命令（过程产物都在 `.cache/`，不进 git）：

```powershell
# 102 上的注册开关（奇安信副本）
node .cache\qax-46401-win\check-register.cjs
# Electron 11 / Electron 19 对照组：同一份 app（.cache/electron19/app），只在 argv 上差一条开关
.cache\electron19\dist19\electron.exe "--register-pepper-plugins=<dll>#Shockwave Flash#Shockwave Flash 34.0 r0#34.0.0.384;application/x-shockwave-flash#swf#spl" .cache\electron19\app
```

注意：本机 shell 环境里有 `ELECTRON_RUN_AS_NODE=1`（会让 `electron.exe` 退化成 Node，`require('electron').app` 为 undefined），跑 Electron 实验前必须先清掉该变量。

### 8.3 因此，恢复注册层有三档做法
| 档 | 做法 | 改动量 | 状态 |
| --- | --- | --- | --- |
| **A 不碰源码** | `--register-pepper-plugins=<dll>#Shockwave Flash#…#<版本>;application/x-shockwave-flash#swf#spl` + `webPreferences.plugins=true`；插件拿 `PERMISSION_ALL_BITS`，不需要 Flash 权限表 | 0 行 | 102 可用（奇安信副本已证）；Electron 19 卡在子进程秒退，需查 `0x80000003` |
| **B 小补丁** | 把 87 的 `--ppapi-flash-path` / `--ppapi-flash-version` 两个开关及其解析分支补回 `content_switches.cc` + `pepper_plugin_list.cc`（87 的 `PluginList::GetPluginInfoArray` 有现成实现），让路径/版本走我们现有的 `flash.ts` 语义 | 数十行 | 与 A 等价，只是不用拼长串 |
| **C 功能补齐** | 补 `chrome/*/renderer_host/pepper/pepper_flash_*`（全屏、右键菜单、剪贴板、字体、DRM/DeviceID）与 `flash_permission_context` 策略 | 数百行 | Electron 本来就没有 `chrome/` 层，**默认不需要**；只有站点用到 Flash 全屏/菜单/剪贴板时才补——这正是奇安信比 Electron 多出来的部分 |

补充：Electron 45（Chromium 14x）的二进制里 `register-pepper-plugins / Pepper Plugin / ppapi_plugin`
全部消失，PPAPI 在 **138 → 140** 之间从上游彻底删除。所以「单内核 + 原生 Flash」的分支上限是
Chromium 138 左右，不是 102——102 只是奇安信当前发布的版本。

## 9. 未决问题

1. **许可边界**：只做兼容性对照，不打包、不分发、不要求用户安装 —— 需要产品侧确认这条边界。
2. **102 的安全寿命**：若走 A，是钉住 102（补丁稳定、安全停更）还是跟一个仍在维护的分支
   （补丁要重做）？这是 `1.2.0` 立项时必须先回答的问题。
3. **32 位对照的局限**：qax 只有 x86，不能代表 64 位内核上的行为差异（我们的主线是 x64 Electron）。
4. **Linux**：他们自带 `/opt/qianxin.com/qaxmultimedia/libflashplayer.so`，与项目 `plugins/linux64`
   的做法一致；若要评估 Linux 上的 102 单内核，可复用这份 Linux 包的字符串证据。

## 10. 追加：360 极速浏览器 X 23.1.1253.64（Chromium 132，x64）复核

> 复核日期：**2026-11-11 23:1x**。安装包 `360csex_23.1.1253.64.exe`（144.2 MB，PE x64）解出
> `Chrome-bin`；`chrome.7z` 449 MB，解出的 `chrome.dll` **216.9 MB / x64**，`360chromex.exe` 2.1 MB / x64。
> 复现脚本：`.cache/360csex-1253/check.cjs`、`check-modes.cjs`、`kill-check.cjs`。

### 10.1 结论先行

| 项 | 结果 |
| --- | --- |
| 内核 | `Chrome/132.0.6805.0`，V8 `13.2.152.30`，revision `@dc663f1f…`（x64） |
| 原生 Flash | **是**：`--type=ppapi` 子进程，加载 `C:\Windows\system32\Macromed\Flash\pepflashplayer64_34_0_0_384.dll`（系统安装的中国版 Flash 34 x64） |
| 页面表现 | `navigator.plugins` 有 `Shockwave Flash 34.0 r0`，测试 SWF 三态出帧；杀掉插件进程后 `flash=false`、画面变黑、JS 存活 |
| 自带 Flash | **没有**：payload 里没有任何 `pepflash*`，只有 NPAPI 插件（`np-mswmp/npaliedit/npAliSecCtrl/npcombrg/itruseuroll/pta`）与下载组件 |
| 二进制里的 Flash 痕迹 | `ppapi-flash-path`、`ppapi-plugin-launcher`、`PepperFlashBrowserHost`、`pepflashplayer`、`FlashPlayerPepper`、`FlashPlayerPlugin`、`flash_player`、`application/x-shockwave-flash` |
| 额外补丁 | `navigator.plugins` 里还能看到 Java / WMP / 支付宝等 **NPAPI** 插件 → 他们把 NPAPI 枚举也补回来了（上游 M92 已删） |

### 10.2 我们的 DLL 能不能塞进 132

| 方式 | 结果 |
| --- | --- |
| `--ppapi-flash-path=<自带 x64 Flash> --ppapi-flash-version=34.0.0.380 --allow-outdated-plugins` | **失败**：`flashMime=false`、无 ppapi 进程。该开关在他们 build 里不按 Chromium 87 的语义工作（用 Adobe 官方 DLL 同样失败） |
| `--register-pepper-plugins=<自带 x64 Flash>#Shockwave Flash Test#…#34.0.0.380;application/x-shockwave-flash#swf#spl` | **成功**：插件列表多出我们的条目，ppapi 进程加载的正是 `plugins/experimental/win64/pepflashplayer64_34_0_0_380.dll`，三态出帧正常（`interactiveFrames=3`） |

即：**132 的 content 层注册通道仍然可用**，可以绕过厂商的"系统插件发现"，直接注入任意 x64 Flash DLL。

### 10.3 修订：内核天花板与 Electron 构建开关

| Chromium | 源码含 pepper | Electron 官方二进制含 ppapi host | 第三方实测 |
| --- | --- | --- | --- |
| 87 | 是 | 是（Electron 11） | 项目现役 |
| 102 | 是 | 是（Electron 19，但 ppapi 子进程 `0x80000003` 秒退） | 奇安信可用 |
| 132 | 是（`enable_plugins` 默认 true） | **否**（Electron 34 的 `electron.exe` 里 `ppapi_plugin_process_host` / "ppapi plugin process" 字符串全无） | 360 可用 |
| 138 | 是 | 未测 | — |
| 140 | 否 | — | Electron 45 已无 |

三条推论：

1. 「单内核 + 原生 Flash」的上限不是 102，而是 **Chromium 138**（对应 Electron 37 一带）；132 已被 360 证明可用。
2. Electron 官方二进制在 132 上把 pepper **编译掉了**，所以换版本还不够：需要按 `enable_plugins=true` **重编**——
   这是一个构建开关，不是代码移植。360 显然也是这么做的（他们的 132 里 `ppapi-flash-path`/`PepperFlashBrowserHost` 都在）。
3. 重编后注册插件用 `--register-pepper-plugins` 即可（102 与 132 均实测有效，命令行插件拿 `PERMISSION_ALL_BITS`），
   **不需要**恢复 `--ppapi-flash-path`；Flash DLL 由我们自己带（360/奇安信都靠系统安装，这正是我们的差异点）。

### 10.4 对 1.2.0 的影响

- 路线 A（自编译单内核）的目标版本从 **Electron 19（102）上调到 Electron 34~37（Chromium 132~138）**，
  补丁形态收缩为「`enable_plugins=true` + 注册开关」，源码改动可能为 0。
- 需要验证的两件事：①用 Electron 34 源码按 `enable_plugins=true` 重编，确认 `--register-pepper-plugins` 能加载自带 DLL；
  ②在 132 上回归我们的站点兼容层（SWFObject 重写 / CORS / `mms.cfg`）是否仍必要、是否仍有效。
- 仍需注意：132 属于 2025 年初分支，安全更新周期有限；`mms.cfg` 与"advertised vs physical 版本"语义要继续保持。

### 10.5 仍未解决

- Electron 19（102）的 `--type=ppapi` 子进程为什么在启动瞬间 `0x80000003`（STATUS_BREAKPOINT）退出：
  360（132）与奇安信（102）都能起同一个插件进程，所以这是 **Electron 侧**的问题，值得单独定位；
  若解决，102 上连重编都不需要。

## 11. CFG 拦截的根因实验（2026-11-11 23:2x，Electron 19 vs 360/11）

> 现象：同一个 Flash DLL，360（132）与 Electron 11（87）都能渲染；Electron 19（102）在调用插件的
> `PPP_GetInterface` 时触发 `0xC0000409`，子码 `0xA`（`FAST_FAIL_GUARD_ICALL_CHECK_FAILURE`）。
> 本节只记录实测，结论见 11.2。

### 11.1 实验与结果

| 实验 | 结果 |
| --- | --- |
| Flash DLL 的 CFG 元数据（`plugins/win64/pepflashplayer64.dll`、`plugins/experimental/win64/…380.dll`、系统 Adobe 34.0.0.384） | 三者一致：`LoadConfig.GuardFlags = 0x100`（`CF_INSTRUMENTED`），但 **`GuardCFFunctionTable` 为空、`GuardCFFunctionCount = 0`**；`DllCharacteristics` 的 `GUARD_CF(0x4000)` 位**未置**。即“声明插桩、却没有函数表”的半插桩镜像 |
| 逐进程读取缓解策略（`GetProcessMitigationPolicy`，调试器在每个 `CREATE_PROCESS` 上读） | Electron 11 与 19 的 browser/gpu/renderer/ppapi 子进程全部是 `CFG enable=1, strict=0, exportSuppression=0`，两边没有差异 |
| 360 的 `chrome.dll` 自身 | `0x10500`（含 `CF_FUNCTION_TABLE_PRESENT`），GFIDS **230165** 条 → **“360 把 CFG 关了”不成立** |
| 把 DLL 的 `GuardFlags` 清零 | Electron 19 仍在同一位置崩；Electron 11 仍出帧 → 崩溃不由 DLL 声明的标志位决定 |
| 把 DLL 的 `GuardFlags` + check/dispatch 指针 + 表指针/计数全部清零 | 同上，Electron 19 仍崩 |
| 把 DLL 的 LoadConfig **目录项整个清零**（彻底变成遗留镜像） | Electron 19 仍失败 → 本机 CFG 没有对“未插桩镜像”生效整体豁免 |
| 手工给 DLL 补一张 GFIDS 表（列出 5 个 `PPP_*` 导出，已排序） | **Electron 19 的 CFG 崩溃消失**（`0xC0000409` 不再出现、pepper 进程存活），但 Flash 仍未初始化（页面显示“无法加载插件”）→ 目标是否登记确实决定崩不崩；只登记导出不足以让 Flash 跑起来 |

### 11.2 结论（当前证据能支持的部分）

1. 崩溃的判据是 **“间接调用目标是否在进程 CFG 位图里”**，与 DLL 是否声明 `CF_INSTRUMENTED`、
   以及进程的 strict/export-suppression 策略都无关（上表已逐项排除）。
2. 该 DLL 没有 GFIDS 表，所以它的导出**不会进入位图**；Electron 19 在 `PPP_GetInterface` 这个
   间接调用点做了 CFG 检查，于是失败。360 与 Electron 11 的同一路径能过，说明它们的调用点
   **没有做这次检查**（87 的 ppapi 宿主代码很可能没有 `/guard:cf` 插桩），而不是位图里有这条记录。
3. 因此“补回 `--ppapi-flash-path` / 版本开关”不可能修好它（与实测一致）；能修的是三选一：
   **a.** 宿主加载插件后用 `SetProcessValidCallTargets` 把镜像可执行段整体登记（保留 CFG，推荐）；
   **b.** 把插件宿主那段代码按 `/guard:cf-` 编译（等同 87/360 的行为，最省事但削弱缓解）；
   **c.** 给 DLL 补全 GFIDS（Flash 函数太多，不现实）。
4. 手工 5 条 GFIDS 只解决了“崩溃”，没有解决“加载”：Flash 初始化过程中还有其它间接调用，
   需要**整段**登记而不是只登记导出 —— 这正好指向方案 a。

## 12. 越过 CFG 之后的下一道门：Flash 宿主接口（2026-11-11 23:3x）

> 运行时把 5 个 `PPP_*` 导出登记为合法目标后，Electron 19 能进入 `PPP_InitializeModule`；
> 但 Flash 随即请求 `PPB_Flash_Clipboard` 5.1 / 5.0 / 4.0，三次都拿到 `NULL`，初始化返回 `-2`
> （`PP_ERROR_FAILED`）。说明剪贴板接口是**初始化依赖**，不是可选能力。

### 12.1 源码层面的缺口（87 vs 102/132，逐文件 HEAD 核对）

| 文件 / 组件 | 87 | 102 | 132 |
| --- | --- | --- | --- |
| `ppapi/c/private/ppb_flash*.h`（flash、clipboard、drm、file、font_file、fullscreen、menu、message_loop、print） | 有 | **无** | **无** |
| `ppapi/thunk/ppb_flash_*_api.h` + `ppapi/thunk/interfaces_ppb_private_flash.h` | 有 | **无** | **无** |
| `ppapi/proxy/interface_list.cc` 里的 `#include "ppapi/thunk/interfaces_ppb_private_flash.h"`（`PERMISSION_FLASH` 注册段） | 有 | **无**（只剩一处 `PERMISSION_FLASH` 残留） | **无** |
| `ppapi/proxy/ppb_flash_message_loop_proxy.*` | 有 | **无** | **无** |
| `content/renderer/pepper/ppb_flash_message_loop_impl.*` | 有 | **无** | **无** |
| `chrome/{browser,renderer}/…/pepper_flash_*`（clipboard filter、renderer host、fullscreen、menu、font、drm、file） | 有 | **无** | **无** |

二进制侧完全对应：Electron 11 的 `electron.exe` 里能搜到 `PPB_Flash_Clipboard / DRM / Fullscreen / Menu / File`，
Electron 19 一个都没有；360 的 `chrome.dll` 全都有（他们把这套整体搬回去了）。

### 12.2 为什么 Electron 11 能过、Electron 19 不能

87 的 `interface_list.cc` 仍把 `interfaces_ppb_private_flash.h` 编进来，`GetInterface("PPB_Flash_Clipboard;5.1")`
返回的是**代理接口指针**（真正的剪贴板操作再 IPC 到浏览器/chrome 层）。Electron 11 没有 `chrome/` 层，
所以“用剪贴板”本身会失败，但**初始化拿到的是非空指针**，于是 `PPP_InitializeModule` 能返回成功。
102/132 把这层注册整个删掉 → 指针为 `NULL` → 初始化 `-2`。

### 12.3 移植清单（按“先让初始化通过，再补功能”排序）

1. **恢复注册层（让 `GetInterface` 返回非空）**：把 87 的 `ppapi/c/private/ppb_flash*.h`、
   `ppapi/thunk/ppb_flash_*_api.h`、`interfaces_ppb_private_flash.h` 搬回，并在 `interface_list.cc` 里恢复 include。
   这一档就能越过剪贴板，代价是剪贴板操作本身仍然是空实现（对开关类小游戏通常够用）。
2. **补 renderer 侧资源宿主**：`ppb_flash_message_loop_impl` + `chrome/renderer/pepper/pepper_flash_*_host`
   （fullscreen / menu / font_file / renderer_host / drm）。Electron 可以用自己的
   `ContentRendererClient::CreatePepperHostFactory` 挂上去，不需要整个 `chrome/` 层。
3. **补 browser 侧宿主**：剪贴板（`pepper_flash_clipboard_message_filter`）、`pepper_flash_file_message_filter`、
   DRM/DeviceID。Electron 侧可以退化成“读系统剪贴板 / 返回错误”的最小实现。
4. **修残留函数指针**：DLL 卸载后宿主仍调用旧的 `PPP_GetInterface` 地址会 `0xC0000005`；
   在 `PluginModule::Unload()` 后把入口点指针清空（或加 `loaded_` 守卫），并在 `OnPluginCrashed` 路径禁用调用。

### 12.4 还没验证的

- 87 / 360 的调用点是否真的没做 CFG 检查（需要反汇编 `__guard_dispatch_icall` 序列）——现在不影响结论，
  因为我们已经有“登记目标”这条可复现的路。
- 越过剪贴板后 Flash 还会请求哪些接口：需要沿 `trace-runtime-exports.txt` 的 `GetInterface` 记录继续看，
  预期至少还有 `PPB_FlashFullscreen`（全屏）、`PPB_Flash_File`（存档）、`PPB_Flash_DeviceID`（DRM）。

## 13. 初始化边界与第一版移植清单（2026-11-11 23:4x）

实测（用户环境）：七个查询返回非空后 `PPP_InitializeModule` 返回 0；创建实例时 Flash 调用
`PPB_Flash;13.0::GetCommandLineArgs`，空表导致空指针执行。Electron 11 上同样观察到这次调用，
之后正常出三帧。

### 13.1 `PpapiThread::OnLoadPlugin` 的悬挂入口点（M102 现状）

M102 `content/ppapi_plugin/ppapi_thread.cc`（227 行起）：

```cpp
  base::ScopedNativeLibrary library;                 // 局部：失败时随函数返回卸载
  ...
  plugin_entry_points_.get_interface = ...;          // 先写成员
  plugin_entry_points_.initialize_module = ...;      // 先写成员
  ...
  int32_t init_error = plugin_entry_points_.initialize_module(...);
  if (init_error != PP_OK) {
    LOG(WARNING) << "InitModule failed with error " << init_error;
    return;                                          // library 卸载，成员指针悬空
  }
  library_ = std::move(library);                     // 只有成功才交给宿主
```

后果：`OnCreateChannel` 只检查 `plugin_entry_points_.get_interface` 非空，于是初始化失败后仍会
向已卸载的 DLL 调用，`0xC0000005`。**修法**：入口点先用局部 `ppapi::PpapiPluginEntryPoints` 保存，
`initialize_module` 成功后与 `library_ = std::move(library)` 一起提交；失败分支显式清零成员；
`OnCreateChannel` 再补一条 `library_.is_valid()` 检查。

### 13.2 七个接口的移植映射（87 的文件清单）

| 接口（Flash 请求的版本） | thunk（`ppapi/thunk/`） | 渲染进程资源（`ppapi/proxy/`） |
| --- | --- | --- |
| `PPB_Flash` 12.4 / 12.5 / 12.6 / **13.0** | `ppb_flash_thunk.cc` + `ppb_flash_functions_api.h` | `flash_resource.{h,cc}` |
| `PPB_Flash_Clipboard` 4.0 / 5.0 / **5.1** | `ppb_flash_clipboard_thunk.cc` + `_api.h` | `flash_clipboard_resource.{h,cc}` |
| `PPB_Flash_File_FileRef` | `ppb_flash_file_fileref_thunk.cc` | `flash_file_resource.{h,cc}` |
| `PPB_Flash_File_ModuleLocal` 3.0 | `ppb_flash_file_modulelocal_thunk.cc` | 同上 |
| `PPB_Flash_FontFile` 0.1 / 0.2 | `ppb_flash_font_file_thunk.cc` + `_api.h` | `flash_font_file_resource.{h,cc}` |
| `PPB_FlashFullscreen` | `ppb_flash_fullscreen_thunk.cc` + `_api.h` | `flash_fullscreen_resource.{h,cc}` |
| `PPB_Flash_Menu` 0.2 | `ppb_flash_menu_thunk.cc` + `_api.h` | `flash_menu_resource.{h,cc}` + `serialized_flash_menu.{h,cc}` |

再加上 `ppapi/c/private/ppb_flash*.h`、`ppapi/thunk/interfaces_ppb_private_flash.h`，以及
`ppapi/proxy/interface_list.cc` 里那一行 `#include`（`PERMISSION_FLASH`）。`PPB_Flash_DRM` /
`PPB_Flash_MessageLoop` / `PPB_Flash_Print` 暂不在第一版范围。

### 13.3 `GetCommandLineArgs` 的真实实现（不经过 IPC）

87 的 `ppapi/thunk/ppb_flash_thunk.cc`：

```cpp
PP_Var GetCommandLineArgs(PP_Module /* pp_module */) {
  ProxyAutoLock lock;
  return StringVar::StringToPPVar(PpapiGlobals::Get()->GetCmdLine());
}
```

值来自 `PluginGlobals::command_line_`，而它在 `PpapiThread` 构造函数里被设置成
**`--ppapi-flash-args` 开关的值**（默认空串）：

```cpp
plugin_globals_.set_command_line(
    command_line.GetSwitchValueASCII(switches::kPpapiFlashArgs));
```

`ppapi_globals.h` 里 `GetCmdLine()` 是纯虚函数（102/132 已删）。所以第一版需要补三处：
1. `content_switches` 恢复 `ppapi-flash-args`；
2. `PpapiGlobals::GetCmdLine()`（`PluginGlobals` 返回成员，`HostGlobals` 返回空串）+ 对应 setter；
3. `ppb_flash_thunk.cc` 的 `GetCommandLineArgs`（返回 `StringVar`，不能返回 `NULL`）。

这样 Flash 拿到的是**空字符串 Var**，不是空表，不会再空指针执行。

### 13.4 风险：资源代理会 IPC 到浏览器

`flash_*_resource.cc` 里的方法大多通过 `PpapiHostMsg_PPBFlash_*` 转发到浏览器宿主（87 在 `chrome/`）。
我们的宿主没有 chrome 层，直接搬会在“Flash 真去调用”时挂起或拿不到回复。第一版建议：
先只恢复**接口表与 thunk**（满足初始化），把真正会被调用的方法（`GetCommandLineArgs` 已是本地实现）
改成**本地返回错误**，再按 trace 结果逐个接真实实现。

### 13.5 360（132）的接口指纹 = 87，可作“已知可用”的参照

对三个二进制做同样字符串指纹扫描：

| 指纹 | Electron 11 (87) | Electron 19 (102) | 360 (132) |
| --- | --- | --- | --- |
| `PPB_Flash;13.0 / 12.6 / 12.5 / 12.4` | 有 | 无 | 有 |
| `PPB_Flash_Clipboard;5.1 / 5.0 / 4.0` | 有 | 无 | 有 |
| `PPB_Flash_FontFile;0.2 / 0.1` | 有 | 无 | 有 |
| `PPB_FlashFullscreen;1.0`、`PPB_Flash_Menu;0.2` | 有 | 无 | 有 |
| `PPB_Flash_DRM;1.1`、`PPB_Flash_MessageLoop;0.1`、`PPB_Flash_Print;1.0` | 有 | 无 | 有 |
| `PpapiHostMsg_PPBFlash`（代理消息名） | 有 | — | 有 |
| `ppapi-flash-args`（`GetCommandLineArgs` 的来源开关） | 有 | — | 有 |
| `PepperFlashBrowserHost`（chrome 层宿主） | 有 | — | 有 |

结论：360 的 132 **就是把这套 87 的 Flash 面（接口表 + 代理消息 + 开关 + 浏览器宿主）整体搬了过来**，
不是另一套设计。它的价值是“已知可用的参照”，不是“另一条路线”：
1. 我们列的七项接口清单与 360 的注册表完全一致（版本号也对得上）；
2. 这证明 87 的这套代码在 132 上能编译进去 → 目标内核可以上探到 132（Electron 34 + `enable_plugins=true`）；
3. 它的浏览器宿主在 `chrome/` 层，依赖 chrome 基础服务，不适合直接搬进 Electron——我们只需要接口表 +
   本地最小实现。**实现代码不要抄，抄“面”**。

## 14. 版本天花板（2026-11-12 网页核对，未做本地验证）

### 14.1 上限在哪

- **Chromium**：`M139` 是最后一个仍带通用 PPAPI 注册与子进程入口的分支，`M140` 删除。
- **Electron**：`Electron 37 = Chromium 138` 是最后一个「源码里还有 PPAPI」的官方大版本；
  `Electron 38 = Chromium 140`，永久不可能。
- 没有 Chromium 139 的 Electron 版本，所以 Electron 的天花板就停在 **37 / 138**。

| Electron | Chromium | PPAPI 源码 | 备注 |
| --- | --- | --- | --- |
| 33 | 130 | 有 | |
| 34 | 132 | 有 | 官方二进制已把 pepper 编译掉（实测无 ppapi host 字符串） |
| 35 | 134 | 有 | |
| 36 | 136 | 有 | |
| **37** | **138** | **有** | **最后可用**；`webPreferences.plugins → prefs->enable_plugins` 仍在 |
| 38 | 140 | 无 | 上游删除；且移除了 `plugin-crashed` 事件 |

### 14.2 “还能往上几个版本”

- 从 **102 / Electron 19** 算：+36 个 Chromium 里程碑，+18 个 Electron 大版本。
- 从 **132 / Electron 34**（360 已验证）算：**+6 个 Chromium 里程碑**（132→138），
  **+3 个 Electron 大版本**（34→35→36→37）。

### 14.3 三个必须同时满足的条件

1. **必须自己重编**：Electron 34 起官方二进制不带 pepper（`enable_plugins` 被关），
   37 的源码里 `webPreferences.plugins` 与 Chromium 138 的 `enable_plugins = !is_android && !is_ios && !is_castos`
   都还在，所以要按 `enable_plugins=true` 构建。
2. **`enable_ppapi` 还依赖 NaCl**：`enable_ppapi = enable_plugins && enable_nacl && !is_fuchsia`，
   Windows x64 默认满足，改 GN 时要一起确认。
3. **适配成本随距离增长**：87→102 是 15 个里程碑，87→138 是 51 个；API 漂移（`base::`、Mojo、`StringVar`、
   `ResourceHost` 签名等）是真实成本，而 102→138 的收益只是“内核新三年”。

### 14.4 建议路径

- 稳：**102（Electron 19）打通 → 直接跳 138（Electron 37）**，中间版本不爬（没有额外收益）。
- 若 138 的编译适配过痛：退回 **132（Electron 34）**，那是 360 已经验证过的点，但安全窗口不如 138。
- 132 与 138 之间不要逐个试：35/36 与 132 相比收益有限，徒增适配轮次。

### 14.5 132 与 138 的实际差距（网页核对）

**Chromium 138 自身新增**（[Chrome 138 发布说明](https://developer.chrome.google.cn/blog/new-in-chrome-138)）：
内置 AI 的 Translator / Language Detector / Summarizer API；CSS `abs()` / `sign()` / `progress()` /
`sibling-index()` / `sibling-count()`；Viewport Segments API（折叠屏）；`stretch` 尺寸关键字；
`Clear-Site-Data` 新增 `prefetchCache` / `prerenderCache`。

**132 → 138 只隔 6 个里程碑**（2025-01 → 2025-06），增量主要是安全修复 + 上面这些 API，对我们这种
Flash 浏览器产品几乎没有直接价值。**真正的跨越是 102 → 132**：2022 → 2025 的平台能力
（WebGPU、View Transitions、Popover、容器查询、`:has()`、WebCodecs、Speculation Rules、ES2023/2024）
以及 3 年安全补丁，都在这一段里。

**Electron 37 相对 36 的新东西**（[发布说明](https://www.electronjs.org/blog/electron-37-0)）：
`-electron-corner-smoothing`（CSS 圆角平滑）、`window.open` 的 `innerWidth`/`innerHeight`、
`webContents` 的 `before-mouse-event`、`ServiceWorkerMain.scriptURL`、菜单 `sublabel`、
`HIDDevice.collections`、`--no-experimental-global-navigator`、Linux X11 的 `screen.dipToScreenPoint` /
`screenToDipPoint`、菜单角色 `palette`/`header`（macOS）、`win.isContentProtected()`、
`--experimental-network-inspection`；栈为 Chromium 138 / V8 13.8 / Node 22.16。
破坏性变更：utility process 的 unhandledRejection 改为告警、`process.exit()` 同步杀进程、
WebUSB/WebSerial blocklist、`ProtocolResponse.session = null` 移除、Linux `IsVisibleOnAllWorkspaces()` 行为。

结论：**132 与 138 是“要不要多 5 个月补丁”的选择，不是“能力”的选择**。132 有 360 背书，138 更“新”；
按 132 先跑通、138 作为目标版本，是成本/收益最稳的组合。

### 14.6 CEF 预编译不能替代自建（2026-11-12 实测）

下载 `cef_binary_138.0.62+g6981a09+chromium-138.0.7204.310_windows64_minimal`（139 MB，
`libcef.dll` 228 MB，版本串一致），对 `libcef.dll` 做字符串指纹：

| 指纹 | CEF 138 | Electron 19 (102) |
| --- | --- | --- |
| `register-pepper-plugins`（开关名，content_switches 无条件编译） | 有 | 有 |
| `ppapi plugin process` / `PpapiPluginProcessHost` | **无** | 有 |
| `ppapi_host` / `ppapi/proxy` | **无** | 有（`ppapi/proxy` ×13） |
| `PPB_Flash_*` 全套 | 无 | 无（上游已删，需我们自己补） |

结论：**CEF 官方构建把 `enable_plugins` 关掉了**（只留下开关名，没有 PPAPI 宿主与代理），
所以预编译 CEF 既跑不了 Flash，也不能拿来做"全 CEF"路线——那同样需要按 `enable_plugins=true`
自建 CEF，依赖完全相同的 Chromium 源码。再加上"全 CEF"要把现有 Electron 应用（React 外壳、用户脚本、
密码库、自动化、OCR）全部重写到 C++，成本远高于"全 Electron"。

**因此：CEF 预编译只值一个结论——它不能替代自建；路线确定为 all-Electron。**
（CEF 的 minimal/client/standard 三个包共用同一个 `libcef.dll`，所以该结论对它们都成立。）

## 15. 构建基线与版本策略（2026-11-14 定稿）

### 15.1 决策

1. **先做 138（Electron 37）**：ppapi 原生在，零 backport，且是最后一条"干净基座"。
2. **138 打不通就回退 132（Electron 34）**：360 已在 132 上验证过原生 Flash，是已知可行点。
3. **138 打通后再逐步上探**；每上一个版本都要重新验证，且 140+ 需要额外做 ppapi 复活。

### 15.2 版本上限（本地源码实测，不依赖网页）

| 版本 | `content/ppapi_plugin/ppapi_plugin_main.cc` | `ppapi/` 整棵树 | 结论 |
| --- | --- | --- | --- |
| 138.0.7204.35 | 存在 | 存在 | ✅ 最后一条完整基座 |
| 139.0.7258.66 | 存在 | 存在 | ⚠️ 但 `content/renderer/pepper/pepper_webplugin_impl.cc` 已删；且无对应 Electron |
| 140.0.7339.41 | **不存在**（`git cat-file` 报 "exists on disk, but not in '140.0.7339.41'"） | **不存在**（含 `ppapi/buildflags`） | ❌ 需复活 |

同时 140 还删掉了 `native_client_sdk`（`enable_ppapi` 原本依赖 `enable_nacl`），GN 断言也要调整。

### 15.3 140+ 复活的可行性评估

- 删除规模：138→140 在 `ppapi` + `content/pepper` 路径上 **1621 个文件 / 27.3 万行**。
- **好消息**：Blink 的插件 API 在 140 仍然存在（`third_party/blink/public/web/web_plugin.h`、
  `web_plugin_container_impl.cc`、`html_plugin_element.cc`），`RenderFrameImpl::CreatePlugin` 的
  `#if ENABLE_PLUGINS` 钩子也还在（只剩给 PDF 用）。最难改的 Blink 接线没被删。
- 复活动作：把 138 的 `ppapi/`、`content/renderer/pepper/`、`ppapi_plugin_process_host`、
  `pepper_plugin_list`、相关 switches 用 `git checkout 138.0.7204.35 -- <paths>` 拿到 140 树上，
  再补 `content/BUILD.gn` 的 `enable_plugins` 段与 `ppapi/buildflags`。
- 成本估计：**1–3 周**编译适配，且**每升一个大版本要重做一次**（这正是厂商停在 132 的原因）。
- 138 相对 140 只差 2 个里程碑，**性价比低**；先 138，等真有需求再做复活实验。

### 15.4 源码缓存：一次下载，终身增量

`D:\git_cache\chromium.googlesource.com-chromium-src` 是 **Chromium 完整历史镜像**：

| 事实 | 值 |
| --- | --- |
| 可达提交数 | **1,866,841** |
| 本地可解析 tag | 一直到 **149.0.7827.95** |
| 138 / 140 的提交对象 | 本地都有（`git cat-file` 可解析、blob 可读） |

**切版本不需要重新下载 Chromium 源码**：`git checkout <tag>` 即可。会重新下的只有
各版本不同的 third_party DEPS、Node，以及工具链版本变化时的 clang/rust/sysroot。

### 15.5 当前构建资产（2026-11-14 00:30）

| 项 | 路径 / 版本 | 状态 |
| --- | --- | --- |
| Chromium 源码 | `D:\electron-build\cr\src` @ `03d59cf5ecf1d` = 132.0.6834.83 | ✅（切 138 只需本地 checkout） |
| Electron 源码 | `D:\electron-build\cr\src\electron` @ `v34.0.0`（v37 标签本地已有） | ✅ |
| git 缓存 | `D:\git_cache\chromium.googlesource.com-chromium-src`，14.38 GB，7 pack | ✅ |
| 工具链 | MSVC 19.44（VS2022 BuildTools 17.14）、SDK 10.0.26100、Python 3.11、depot_tools | ✅ |
| 磁盘 | D: ≈221 GB 空闲 | ✅ |
| 待办 | `gclient sync --nohooks` → `runhooks` → `gn gen --args="... enable_plugins=true ..."` → `ninja` | ⏳ |

### 15.6 运维注意

- **不要用命令行正则批量杀进程**：`Get-CimInstance Win32_Process | Where CommandLine -match ... | Stop-Process`
  会匹配到执行命令的 shell 自身，2026-11-14 00:15 曾把 DSH 桌面端渲染进程一起杀掉（
  `crash-2026-11-13T16-15-18-505Z-renderer.log`）。只按后台任务返回的精确 PID 终止。
- 下载大文件用 **aria2 多连接**（单连接被 Google 限到 ~500 KB/s，64 连接可到 50–70 MB/s）；
  被限速时换出口 IP 可重置配额。

## 16. 自建 Electron 37 / Chromium 138 里程碑（2026-11-14 实测）

### 16.1 结论

**138 能编出带 PPAPI 的 Windows 版 Electron，并且能加载原生 Flash DLL、调用 `PPP_GetInterface` 成功。**
当前卡在 `PPP_InitializeModule` 返回 `-2`——缺的是 Flash 私有宿主接口（`PPB_Flash_*`），与 102/132 的病因相同。

### 16.2 构建阶段踩到的四道"注册门"（全部已修）

| # | 现象 | 根因 | 处理 |
| --- | --- | --- | --- |
| 1 | 二进制里没有 PPAPI 字符串 | `ppapi/buildflags/buildflags.gni`：`enable_ppapi = enable_plugins && enable_nacl && !is_fuchsia`，而 `enable_nacl` 只在 ChromeOS 为 true | 改为 `enable_ppapi = enable_plugins && !is_fuchsia` |
| 2 | `--register-pepper-plugins` 不生效 | `content/common/pepper_plugin_list.cc` 的 MIME 白名单只允许测试插件 | 白名单加入 `application/x-shockwave-flash`、`application/futuresplash` |
| 3 | 插件仍不注册 | `ComputePepperPluginList` 需要额外开关 `--allow-command-line-plugins` | 启动时加上该开关 |
| 4 | ppapi 子进程秒崩 `0x80000003` | `sandbox/policy/sandbox_type.cc` 的 `--type=ppapi` 映射被 `&& !BUILDFLAG(IS_WIN)` 排除，`SandboxTypeFromCommandLine` 触发 NOTREACHED | Windows 分支返回 `Sandbox::kNoSandbox`（与"Ppapi sandbox on Windows is not supported"一致） |

另修了三个编译/工具链缺口（见 §15.6 之外的细节）：
`ppb_trace_event_impl.cc` 的 `base::PlatformThreadId` 强类型转换、ATL 组件安装、
`LASTCHANGE` / `DAWN_VERSION` / `gpu_lists_version.h` / `skia_commit_hash.h` / 内置 `rc.exe` 的 hook 补跑。

### 16.3 运行阶段实测（`out/Testing/electron.exe`，Chromium 138.0.7204.35）

插件进程日志（trace）：

```
OnLoadPlugin: enter
OnLoadPlugin: library loaded
OnLoadPlugin: got get_interface      <- PPP_GetInterface 调用成功，138 上没复现 CFG fastfail
OnLoadPlugin: calling initialize_module
OnLoadPlugin: init FAILED            <- PPP_InitializeModule 返回 -2
OnCreateChannel
```

Flash 请求的宿主接口（`GetBrowserInterface` 记录）：

| 接口 | 结果 |
| --- | --- |
| `PPB_Core;1.0`、`PPB_AudioConfig;1.1`、`PPB_Audio;1.1`、`PPB_AudioInput(Dev);0.4` | OK |
| `PPB_BrowserFont_Trusted;1.0`、`PPB_Buffer(Dev);0.4`、`PPB_CharSet(Dev);0.4` | OK |
| `PPB_Crypto(Dev);0.1`、`PPB_CursorControl(Dev);0.4`、`PPB_FileChooser(Dev);0.6`、`PPB_FileChooserTrusted;0.6`、`PPB_FileRef;1.2` | OK |
| **`PPB_Flash_Clipboard;5.1` / `5.0` / `4.0`** | **NULL** |

### 16.4 还缺什么

138 的 `ppapi/` 里 **完全没有任何 flash 文件**（`c/private`、`proxy`、`thunk` 均无），
所以需要从 87 分支移植整套 Flash 私有层（本地 git 缓存含 87 全历史，可 `git checkout 87.0.4280.x -- <paths>`）：

- `ppapi/c/private/ppb_flash*.h`
- `ppapi/proxy/flash_*_resource.*`、`ppapi/thunk/ppb_flash_*_api.*`、`interfaces_ppb_private_flash.h`
- `ppapi/proxy/interface_list.cc` 的注册（`PERMISSION_FLASH`）
- chrome 层宿主：`chrome/browser/renderer_host/pepper/pepper_flash_*`、`chrome/renderer/pepper/*`
- Electron 侧的注册入口（`AddPepperPlugins` 或等价物）

移植后重新跑本节的测试页，目标从 `init FAILED` 变成能创建实例并出帧。
