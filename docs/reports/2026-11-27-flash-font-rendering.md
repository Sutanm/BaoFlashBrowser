# Flash 中文文本渲染差异的根因与修复（Windows / Electron 39 + PPAPI 回移）

日期：2026-11-27
涉及内核补丁：[`0009-ppapi-flash-font-pipeline.patch`](../kernel/0009-ppapi-flash-font-pipeline.patch)
涉及应用改动：`app/src/main/browser-window.ts`（`createPageView` 的 `defaultFontFamily`）

---

## 1. 结论摘要

同一个 AS3 游戏、同一份 `pepflashplayer64.dll`（29.0.0.171，三份文件 SHA-256 完全相同），
在 Electron 11（Chromium 87）里中文是**微软雅黑、笔画锐利**，在 Electron 39 + PPAPI 回移
（Chromium 142）里变成**宋体观感、字身窄、笔画粗且发糊**。根因有三层，全部定位到具体代码：

| # | 根因 | 所在层 | 修法 |
| --- | --- | --- | --- |
| A | Flash 的**通用字族请求**（`face` 为空，占全部字体请求的 **80%**，15961/19852）由宿主用 WebPreferences 字体映射表解析；Electron 39 的 `font_defaults` 把该表填成**系统 UI 字体**（本机 `Noto Sans SC`，可变字体），而 Electron 11 填的是 Chromium 内置的 `Microsoft YaHei` | 应用层 | `webPreferences.defaultFontFamily` 显式对齐雅黑 |
| B | **插件进程从未初始化 Blink 的字体渲染样式**：`blink::WebFontRenderStyle::Set*()` 只由渲染进程的 `WebViewImpl` 调用，PPAPI 插件进程没有 WebView，全局量一直是默认值 → 插件进程里 Blink 绘制的字形走 Skia 默认样式而非用户的 ClearType 配置 | 内核（0009） | `LowerToken()` 前用 `gfx::GetFontRenderParams()` 初始化 |
| C | `PPB_Flash.PreloadFontWin` 的转发链在 M138 被删（`ppb_flash_thunk.cc` 改成空转），破坏了接口契约 | 内核（0009） | 按 M87 形状补回 `PreCacheFontForFlash` 链路 |

**A 是"宋体感"的主因**（换掉了字体族），**B 是"更黑更粗"的主因**（换掉了光栅化样式）。
C 实测对被观测的 SWF 无效（Flash 不调用该接口），属于完整性修复。

---

## 2. 现象与对照环境

| | 宿主 | Chromium | Flash dll |
| --- | --- | --- | --- |
| 新平台 | Electron 39.8.10（自编译内核，PPAPI 回移到 142） | 142.0.7444.265 | 29.0.0.171 |
| 老平台 | Electron 11.5.0 | 87.0.4280.141 | 29.0.0.171 |
| 对照组 | CefFlashBrowser | 84.0.4147.105 | 34.0.0.384 |

三份 dll 的 SHA-256 均为 `85A836F3…`。机器：Windows 11，150% DPI，12px 中文。

---

## 3. 被否证的假设（每条都有实测依据）

按排查顺序记录，避免后来人重走。

| 假设 | 否证依据 |
| --- | --- |
| 内核补丁改了渲染 | 26 个 patch 里只有 2 个碰 PPAPI（插件准入校验、Windows 沙箱），渲染路径零改动 |
| Flash dll 不同 | 三份 SHA-256 完全相同；实测模块路径指向项目内 29.0.0.171 |
| 沙箱 / Win32k 封锁 | `--no-sandbox` 启动后 `DisableWin32kSystemCalls` / `DisableNonSystemFonts` / `DisallowChildProcessCreation` 全 OFF，字体不变；老平台这三项其实也是 ON |
| DPI / 表面重采样 | `--force-device-scale-factor=1` 无效；两个 exe 的 manifest（`supportedOS`、`dpiAware`）完全相同 |
| locale / 次像素参数 | 插件进程参数逐项相同：`--lang=zh-CN`、`--ppapi-subpixel-rendering-setting=1`、`--ppapi-antialiased-text-enabled=1`、`--device-scale-factor=1.5` |
| UA 分发不同 SWF | 老平台 UA 套到新平台无效 |
| 版本通告（`--ppapi-flash-version`） | 把 `--register-pepper-plugins` 的版本串改成 34 无效；且该开关只存在于 `chrome/`，`content/` 层从不认识它，Electron 里一直是安慰剂 |
| `PPB_Flash` ABI 变化 | `ppapi/c/private/ppb_flash.h` 在 87 与 142 **逐字节相同** |
| host 字体接口未被调用 | 在 `PepperFlashFontFileHost`、`OnDrawGlyphs`、`PreCacheFontForFlash` 三处加日志，**零命中** → Flash 不走这几条 |
| Flash 走 GDI 建字体 | 在 `font_warmup_win.cc` 的 7 个 patch 函数入口加日志：全部 `err=0` 安装成功、`fontmgr=ok`，但 **`[gdi-call]` 零命中**——Flash 连 `CreateFontIndirectW`/`CompatibleDC` 都没调用 |
| M88 删除的 `PatchGdiFontEnumeration` 调用点是根因 | 补回该调用点、重编、实测字体不变；结合上一条，Flash 从不走这条路径，该调用点与本问题无关（未纳入 0009） |
| 服务端按版本发不同 SWF | Procmon 显示 SWF 为网络流式加载、不落盘；但 A 项（换字体族后观感恢复）证明文本走的是宿主接口，与 SWF 内容无关 |
| 老平台有 LCD 次像素 | **这条我最初判错了**：从一张被缩放的对比图量出"平均 \|R−B\|=44.9"，误判为 ClearType 彩边。1:1 原图复核后，老平台是灰度抗锯齿，那个数值是缩放插值造成的假象。已在结论中更正 |

---

## 4. 根因 A：通用字族被解析成 `Noto Sans SC`

在 `PpapiThread::CreateBrowserFont` 与 `PPFontDescToWebFontDesc` 加日志后，实测 19852 次字体请求：

| 请求 | 次数 | 解析结果 |
| --- | --- | --- |
| `face` 为空（通用字族） | **15961** | `Noto Sans SC` |
| `Tahoma` | 3301 | `Tahoma` |
| `Microsoft YaHei` | 440 | `Microsoft YaHei` |
| `Arial` | 139 | `Arial` |
| `SimHei` / `SimSun` | 6 / 5 | 原样 |

即：**具名请求全部正确，占 80% 的通用请求被解析成了 `Noto Sans SC`**。
`ppapi::Preferences` 的四个字体映射表各有 152 个脚本键（`prefs[std=152,sans=152,serif=152,fixed=152]`），
值来自渲染进程的 `WebPreferences`；而 Electron 39 的 `shell/browser/font_defaults.cc` 会用
**浏览器 locale 对应的系统字体**填充它，Electron 11 那一代表里是 Chromium 内置的 `Microsoft YaHei`。

`Noto Sans SC` 是**可变字体**（`NotoSansSC-VF.ttf`，也是那轮 Procmon 里被打开次数最多的字体文件，44 次），
12px 下默认实例偏细偏窄——这正是"字身窄、字距开"的来源。

**修法（应用层，不动内核）**：

```ts
// app/src/main/browser-window.ts —— createPageView()
defaultFontFamily: {
  standard: 'Microsoft YaHei',
  sansSerif: 'Microsoft YaHei'
}
```

`web_contents_preferences.cc` 会把它写进 `standard_font_family_map[kCommonScript]`，
与 `PPB_BrowserFont_Trusted` 的通用解析走同一张表，因此**这是 Flash 字体族的唯一正确开关**。

验证：改后同一位置的文字回到雅黑；把该项删掉，宋体观感立即复现。

---

## 5. 根因 B：插件进程没有字体渲染样式

`third_party/blink/renderer/core/exported/web_view_impl.cc` 的 `UpdateFontRenderingFromRendererPrefs()`
是**唯一**调用 `WebFontRenderStyle::Set*()` 的地方；它由渲染进程的 `WebViewImpl` 触发。
PPAPI 插件进程没有 WebView，于是 `g_use_skia_subpixel_rendering` / hinting / antialias 一直是默认值，
插件进程里所有 Blink 绘制的字形都走 Skia 默认样式。

**修法（内核 0009）**：在 `PpapiThread::OnLoadPlugin()` 里、`g_target_services->LowerToken()` **之前**
调用新增的 `SetupFontRenderStyle()`：

```cpp
gfx::FontRenderParams params =
    gfx::GetFontRenderParams(gfx::FontRenderParamsQuery(), nullptr);
// hinting / autohint / bitmaps / antialias / subpixel 逐项灌进 WebFontRenderStyle
```

必须在 `LowerToken()` 之前执行：`GetFontRenderParams()` 底层走 `SystemParametersInfo`，
沙箱降权后读不到。

### 量化对比（12px 中文正文，同一位置）

| 指标 | 修复前 | 修复后 | 老平台（Chromium 87） |
| --- | --- | --- | --- |
| 墨量（Σ255−L） | 1 373 584 | 655 478 | 588 587 |
| 半调边缘像素 | 8564 | 2438 | 2540 |
| 笔画宽度均值 | 1.96 px | ≈1.6 px | 1.63 px |

修复后与老平台基本持平；"像描边一样、加粗一点点"的观感随之消失。

---

## 6. 关于 LCD（次像素）文本：试过，刻意不开

Chromium 在 Windows 上通过 `WebFontRendering::SetLCDTextEnabled()` 与
`skia::LegacyDisplayGlobals::SetCachedParams(几何, 对比度, gamma)` 控制 LCD，而不是 `WebFontRenderStyle`。
曾按渲染进程的做法把这两者一起打开，并让 `DrawTextAt` 在处理"不透明"图时使用系统 RGB 几何：

- 结果：12px 汉字 1px 笔画被拆到 R/G/B 三个通道，放大后是**彩边 + 断笔**，观感明显劣于灰度，用户判定"变差了"
- 处理：整段回退，只保留 `WebFontRenderStyle` 初始化（灰度、笔画合并）

结论：**本产品 12px 中文场景下 LCD 不可取**。这条记录写在 0009 的代码注释里，避免以后有人再"顺手打开"。

---

## 7. 遗留与后续

1. **`defaultFontFamily` 目前是常量**。用户此前提出"希望能自己决定 Flash 读什么字体、fallback 到什么字体"，
   下一步可做成设置项（写入 `webPreferences.defaultFontFamily` 即可，不需要再动内核）。
2. **`face` 为空的请求里，serif/monospace 未被显式指定**，当前沿用平台默认。若出现"某处字变宋体"的反馈，
   优先怀疑 SWF 显式请求了 `_serif`，而不是回归。
3. **`Noto Sans SC` 的来源未追到最终一行代码**：已确认它来自 WebPreferences 字体映射表，
   但 `font_defaults.cc` 里 `kFontDefaults` 表与本机系统 UI 字体的具体关系未逐行核对。
   影响：换一台机器（未装 Noto Sans SC / 系统 UI 字体不同）时默认值可能不同——这也是第 1 条要做成显式配置的原因。
4. `0009` 的 C 项（`PreCacheFontForFlash`）对当前 SWF 无效，保留作为接口完整性修复；
   若将来出现"某些 SWF 字体表拿不到"的问题，这是第一个该复查的点。

---

## 8. 复现与验证速查

**内核**（`D:\electron-build-142\cr\src`）：

```bash
git apply D:\java_workspace\BaoFlashBrowserNext\docs\kernel\0009-ppapi-flash-font-pipeline.patch
DEPOT_TOOLS_WIN_TOOLCHAIN=0 ./third_party/ninja/ninja.exe -C out/Rel electron
```

**应用**：`npm run build`（`defaultFontFamily` 在主进程，必须重新构建产物）。

**观察点**：同一段游戏内文字与 Electron 11 并排，1:1 截图（不要缩放，缩放会破坏亚像素信息，
我自己就在这点上误判过一次）。

---

## 9. 证据文件

- 内核补丁：[`docs/kernel/0009-ppapi-flash-font-pipeline.patch`](../kernel/0009-ppapi-flash-font-pipeline.patch)
- 内核补丁索引：[`docs/kernel/README.md`](../kernel/README.md)
- 用户侧既有记录：[`docs/flash-device-fonts-win.md`](../flash-device-fonts-win.md)（早于本次定位，结论已被本文件覆盖）
- 日志与截图：`D:\tmp\font-*.log`（`font-bf.log` 含 19852 次字体请求的完整分布；`font-trace.log` 含 GDI patch 零命中证据）
- 图像测量脚本：`D:\tmp\imgtool\`（`png.js` 自写 PNG 解码、`imports.js` PE 导入表解析）
