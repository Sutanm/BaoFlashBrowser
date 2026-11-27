# 同一份 Pepper Flash 29 在 Chromium 87 / 自定义 142 上为何显示不同字体？

> **状态：已归档（2026-11-27 结案）。** 本文是问题未解决时的**过程稿**：结论停在"差异定位在两个宿主组合之间"，
> 并提出了若干待验证方向（GDI 字体枚举、版本通告、`_sans` 对照等）。这些方向后续被逐条实测否证，
> 真正的根因是**通用字族被 Electron 39 的字体默认表解析成 `Noto Sans SC`**，以及**插件进程从未初始化
> Blink 的字体渲染样式**。
>
> **现行结论以此为准：[`reports/2026-11-27-flash-font-rendering.md`](reports/2026-11-27-flash-font-rendering.md)。**
> 内核补丁：[`kernel/0009-ppapi-flash-font-pipeline.patch`](kernel/0009-ppapi-flash-font-pipeline.patch)。
>
> 正文保留原样，作为排查过程的记录（其中"补丁未改绘制代码"的判断成立；"需要先比对两份 SWF"的提议
> 经验证不必要——换掉字体族后观感即恢复，证明文本走宿主接口，与 SWF 内容无关）。

**结论：现有证据把差异定位在两个宿主组合之间，还没有定位到 Windows 字体枚举，也没有证明游戏按 Player 版本切换了字体。** 最值得先做的不是再改开关，而是在两个宿主里运行同一个离线 SWF，同时读出 Player 版本、显式请求雅黑、再测试 `_sans`。这一次对照就能把几条解释分开。

以下以提问中的实测为输入，未在两台宿主进程中采集调用栈或重跑游戏。严格的同 DLL 对照是 Electron 11 / 39；CEF 那一行标为 Player 34，应作外观参考，不并入 Player 29 的因果对照。若“三份哈希相同”也指 CEF 实载模块，请先核对该 PID 的实载路径、完整 SHA256 和文件版本；注册通告不是文件版本。

## 1. 是 Chromium 改了 GDI 字体枚举或 DPI 上下文吗？

没有查到能直接解释这个组合的上游变更。这里不是两代官方 Flash 宿主之间的连续升级：[Chrome 88 已移除 Flash](https://www.chromium.org/flash-roadmap/)。142 上实际需要比较的是**回移后的实现与 87 实现**，包括它们调用的宿主服务。补丁未改绘制代码，不能证明字体请求、宿主返回值和最终绘制表面相同。

**一个比 PPAPI 进程模块列表更直接的检查点：** 在可核查的 [87.0.4280.144 源码镜像](https://code.qt.io/cgit/qt/qtwebengine-chromium.git/plain/chromium/chrome/VERSION?h=87-based)中（与 Electron 11.5.0 的 87.0.4280.141 为相邻构建，不能代替本地分支），Windows 上有两条与 Flash 相关的 renderer 端路径：

- [PepperFlashFontFileHost](https://code.qt.io/cgit/qt/qtwebengine-chromium.git/plain/chromium/chrome/renderer/pepper/pepper_flash_font_file_host.cc?h=87-based) 用 `matchFamilyStyle` 按 `description.face`、字重、斜体找字面并提供字体表；Windows 分支的这次匹配不传字符集或目标汉字。可在两个宿主对照请求名、实际匹配字面和取表是否成功。
- [PepperFlashRendererHost::OnDrawGlyphs](https://code.qt.io/cgit/qt/qtwebengine-chromium.git/plain/chromium/chrome/renderer/pepper/pepper_flash_renderer_host.cc?h=87-based) 是另一次按名字找字面，收到的是插件提供的 glyph ID 和 advance，不是待选字的 Unicode 字符串。若请求经过这里，要对照取表与绘制两处的实际字面；不能只在最后把宋体替换成雅黑，因为不同字面的相同 glyph ID 未必表示同一个字。Chromium 也有[实际 Flash 文本经该 IPC 绘制的修复记录](https://chromium.googlesource.com/chromium/src/+/df69a28d5b46c2d9a25a14b9fc427a26ecf9f55f)。

这说明**只监控插件进程会漏掉合法的选字路径**，不说明皮卡堂一定调用了它们。先确认渲染该行文字时是否命中，再决定是否追 GDI。

| 应区分的层次 | 怎么判断 |
|---|---|
| 游戏请求了什么 | 优先确认两个游戏实际载入的主 SWF、字库/子 SWF、FlashVars、嵌入参数相同。能观察文本对象时，读目标字符的 `getTextFormat(i,i+1).font`、`embedFonts`，不要只看 `defaultTextFormat`。格式是请求名，不是最终物理字体。 |
| 进程能枚举什么 | [微软文档](https://learn.microsoft.com/en-us/windows/win32/intl/using-international-fonts-and-text)明确区分字体名和字符集过滤。比较同类 HDC、相同 `lfFaceName`、`lfCharSet` 下的完整结果，保留原始拼写和顺序；不要把空字体名的系统枚举等同于游戏筛选后的结果。系统 UI 字体也不是所有 `TextField` 的默认字体。 |
| 实际选中了什么 | 若调用栈走 GDI，记录 `CreateFontIndirectW` 的请求，在同一 HDC 选入字体后读 `GetTextFaceW`；这是基础字面，不能单独证明缺字回退后的每个汉字来自该字体。若走 DirectWrite，则看匹配出的 font face / glyph run，而不是继续盯 GDI。记录调用方 PID、线程、栈；不要只监视 `--type=ppapi`。 |
| DPI、语言改变了什么 | 在实际处理请求的线程读 `GetThreadDpiAwarenessContext`、`GetThreadLocale` / `GetThreadUILanguage`，并记 DC 的类型、`LOGPIXELSY`、请求字号。相同 manifest 或 `--lang` 不等于上述运行值相同。DPI 首先改变尺寸/取整，不会仅凭一个缩放因子就证明系统少枚举了雅黑。 |
| 为什么彩边消失 | 这是光栅化/合成问题，不是字体族的指纹。[微软的抗锯齿说明](https://learn.microsoft.com/en-us/windows/win32/api/dwrite_1/ne-dwrite_1-dwrite_text_antialias_mode)指出 ClearType 的 RGB 覆盖不适合透明中间位图，而灰度覆盖可以正常合成。它是可测假设，不是已证实的新宿主路径。固定 `wmode`、背景、缩放、Stage 质量和截图方式，比较原始像素，不比较被查看器重采样过的图。 |

`msimg32` 的出现只能说明模块加载过，不能把 `AlphaBlend` 归因到这个文本框；没有该模块也不能证明没有 alpha 合成。DXVA2、UI Automation 同理。两边都加载 DWrite/GDI 也不能判定哪一个画了目标文字。已有 `--no-sandbox` 对照没有改变外观，不建议为此长期关沙箱。

## 2. 有相同的 SimSun 回退案例吗？

没找到同时满足「同一份 Pepper 29、自定义 Chromium 142、相对 87 回退、已定位根因」的公开案例。有一个更具诊断价值的[历史 Flash 报告](https://blog.csdn.net/weixin_33754913/article/details/92522419)：作者观察到 Chrome 内与独立播放器对 `SimSun` / `宋体` 的处理不同。它支持把英文名和本地化名分别列入对照，不足以证明这次也是别名问题。

另一个容易混淆的线索是 `kSimplifiedHanFonts`：这个名字确实见于 [Blink 的 Windows 字体回退代码](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/platform/fonts/win/font_fallback_win.cc)。[Electron 的 SimSun 历史 issue](https://github.com/electron/electron/issues/18193)也讨论了网页 sans-serif 的 CJK 回退。这些不是 Adobe DLL 对目标 `TextField` 执行到该表的证据。即便二进制里确有候选字体字符串，仍需确认是哪个模块、哪条路径实际选择了它。不要据此先改浏览器 CSS 或系统字体替换表。

## 3. `--ppapi-flash-version` 能覆盖 `Capabilities.version` 吗？

**没有找到受支持的官方覆盖途径。** [Electron 11.5.0 的注册实现](https://github.com/electron/electron/blob/v11.5.0/shell/app/electron_content_client.cc#L98-L149)把路径和版本分开处理：版本串用于构造插件描述和 `plugin.version`。这段代码并不设置 AVM2 的版本属性。[AS3 文档](https://airsdk.dev/reference/actionscript/3.0/flash/system/Capabilities.html#version)定义 `Capabilities.version` 为正在运行的 Player 平台与版本（Windows 形如 `WIN 29,0,0,171`）。这里给出的是预期格式，不是对本机的读数。

本项目的[注册代码](../app/src/main/plugins.ts#L55-L59)确实传入描述串和版本串；[上方注释](../app/src/main/plugins.ts#L19-L30)称“通告 34 就切到雅黑”。这与这次「改 34 后重启仍是宋体」的实测不符，应视为待证假设，而不是已验证机制。外层页面仍可能根据浏览器插件描述选择不同 SWF 或参数，那是**加载器分支**，不是覆写 Player 属性。仅改通告后字体不变，也不能替代在 SWF 内读版本。本次未修改程序逻辑。

## 建议的第一轮对照（无需改游戏）

使用同一个离线探针 SWF、同一 HTML 容器、同一块显示器。每边冷启动，先比 87 与 142；若要验证旧开关的语义，再只在 87 里切换通告 29/34。用可见文本输出结果，避免发行版 Player 未开启 `trace` 日志造成误判。

1. 打印 `Capabilities.version`、`Capabilities.language`，以及 `Font.enumerateFonts(true)` 中 `fontType == FontType.DEVICE` 的四个目标别名（`Microsoft YaHei` / `微软雅黑` / `SimSun` / `宋体`），保持原始拼写；若要比较集合，另存完整清单。Flash 未列出别名不等于 Windows 没有那份字体。
2. 做五行 `TextField`：上述四个名字各一行，加 `_sans`；均设 `embedFonts=false`，相同字号、字重、坐标取整、`antiAliasType`，先设 `defaultTextFormat` 再赋值 `text`。每行写同一串 `皮卡堂 汉字骨直 ABC il1 0123`，标签放在字段外。保存 `textWidth` 和无缩放 PNG。可加一行**确已嵌入且覆盖测试字形**的字体，作为不依赖 device-font 选择的参照。
3. 按结果决定下一步，而不是用截图反推 DLL 内部实现：

| 观察到的结果 | 下一步 |
|---|---|
| 两边 `Capabilities.version` 相同 | 排除“该属性值不同”这一分支条件；仍可检查加载器或游戏的其他输入。若仅游戏不同而离线探针一致，先比游戏资源和目标字符格式。 |
| 显式雅黑两边都像雅黑，仅 `_sans` 不同 | 优先查通用族解析、字体偏好及实际字符回退；“142 完全拿不到雅黑”已不是好解释。 |
| 同宿主中英文名表现不同，或仅 142 显式雅黑失败 | 带着该请求名查字体接口返回、字符集和物理字面；这是验证枚举/别名假设的最短路径。 |
| 显式字体与度量相符，甚至嵌入字体也只在 142 丢彩边 | 优先查文本光栅目标、透明度和后续缩放。相同度量本身不证明字体相同，也不要把彩边直接译为 AS3 的 `advanced`。 |
| 只改 87 通告，离线 SWF 内部版本确实改变 | 保留完整日志与实载模块哈希，再追该构建的宿主接口；先证明可重复，仍需独立证明游戏读取了版本并用它选字体。 |

下面是可直接放进 AS3 文档类构造函数的探针主体（导入 `flash.text.*` 和 `flash.system.Capabilities`）。首行及标签仅用于识别结果，不参与度量；用白底、至少 650×240 的舞台显示。

```actionscript
var info:TextField = new TextField();
info.width = 650; info.height = 42; info.multiline = true; info.wordWrap = true;
var seen:Array = [];
var names:Array = ["Microsoft YaHei", "微软雅黑", "SimSun", "宋体", "_sans"];
for each (var f:Font in Font.enumerateFonts(true)) {
    if (f.fontType == FontType.DEVICE && names.indexOf(f.fontName) >= 0)
        seen.push(f.fontName);
}
info.text = Capabilities.version + " / " + Capabilities.language + "\n枚举命中: " + seen.join(", ");
addChild(info);
for (var i:int = 0; i < names.length; i++) {
    var t:TextField = new TextField();
    t.x = 220; t.y = 48 + i * 34; t.width = 420; t.height = 32;
    t.embedFonts = false; t.antiAliasType = AntiAliasType.NORMAL;
    t.defaultTextFormat = new TextFormat(names[i], 18, 0x000000, false);
    t.text = "皮卡堂 汉字骨直 ABC il1 0123"; addChild(t);
    var label:TextField = new TextField();
    label.y = t.y; label.width = 215; label.height = 30;
    label.text = names[i] + "  w=" + t.textWidth; addChild(label);
}
```

最有价值的回传材料不是整个模块列表，而是**两组 SWF 内版本、五行请求名/宽度/原始截图，以及第一处不同的字体请求或返回值**。
