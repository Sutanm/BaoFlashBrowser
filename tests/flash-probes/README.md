# Flash 测试 SWF：从哪来、怎么自己造

> 配套：[`2026-11-18-140-experiments.md`](2026-11-18-140-experiments.md)（第一轮 `[ppexp]` 探针结论）
> 本文记录**测试内容从哪里搞**，以及我们已经搭好的可复用工具链。

---

## 一、现成 SWF 的来源（按可用性排序）

| 来源 | 说明 | 链接 |
| --- | --- | --- |
| **Ruffle 测试套件** | 数千个**按特性命名**的小 SWF（`tests/tests/swfs/avm1/shared_object/*`、`avm2/...`），最省事 | <https://github.com/ruffle-rs/ruffle/tree/master/tests/tests/swfs> |
| **Flashpoint Archive** | 大量真实 Flash 游戏/动画（体积大，适合回归） | <https://flashpointarchive.org> |
| **Adobe Flash 示例/开源项目** | 各类 AS3 示例仓库（含 Stage3D、LSO 示例） | GitHub 搜索 `language:ActionScript` |
| **本机已有成品** | `Canabalt.swf`(3.2 MB)、`FlxInvaders.swf`(68 KB)、`sample_1280x720.swf`(4.7 MB，视频) | `.cache/cef-compare/game/`、`.packaging-worktrees/win64/tests/` |

**缺点**：现成 SWF 的行为是黑盒（不知道它到底调了哪个 API）。所以我们更推荐自己造。

---

## 二、自己造 SWF：本机已装好的两套工具链

### 方案 A（推荐）：Apache Flex SDK 4.16.1 + playerglobal 32

已安装在 `D:\tools\`：

| 组件 | 路径 |
| --- | --- |
| Flex SDK 4.16.1（含 `mxmlc`） | `D:\tools\flex-sdk\bin\mxmlc.bat` |
| playerglobal 32 | `D:\tools\flex-sdk\frameworks\libs\player\32.0\playerglobal.swc` |
| 依赖 | 本机 **JDK 1.8**（`C:\Program Files\Java\jdk-1.8`） |

编译一条命令：

```powershell
$flex='D:\tools\flex-sdk'; $player="$flex\frameworks\libs\player\32.0"
$env:JAVA_HOME='C:\Program Files\Java\jdk-1.8'
& cmd /c "`"$flex\bin\mxmlc.bat`" -target-player=32.0 -swf-version=32 `
  -static-link-runtime-shared-libraries=true `
  -compiler.external-library-path=`"$player`" -compiler.library-path=`"$player`" `
  -use-network=true -debug=false -output=`"out\MyProbe.swf`" `"MyProbe.as`""
```

> 注意：`playerglobal32_0.swc`（来自 `fpdownload.macromedia.com/get/flashplayer/updaters/32/`）**不含 `flash.net.WebSocket`**，
> 所以 WebSocket 相关探针无法静态引用该类；可用反射（`getDefinitionByName`）尝试，或换 AIR SDK 的完整 playerglobal。

### 方案 B（备选）：Haxe 4.3.7（免 Java、单文件 <12 MB）

已安装在 `D:\tools\haxe-4.3.7`：

```powershell
$env:HAXE_STD_PATH='D:\tools\haxe-4.3.7\std'
& 'D:\tools\haxe-4.3.7\haxe.exe' -main MyProbe -swf out\MyProbe.swf -swf-version 8
```

**限制（已实测）**：Haxe 的 SWF 目标是 **AVM1**，`graphics` 绘制与 `TextField` 在 Flash 29 里**不生效**（只出白屏），
只适合验证"能不能跑起来"，不适合做可视化断言。**做结果展示请用方案 A。**

---

## 三、我们已经造好的一套探针（`tests/flash-probes/`）

| 文件 | 用途 | 结果（Chromium 140 / Flash 29） |
| --- | --- | --- |
| `LsoRoundTrip.as` | `SharedObject` 读→自增→`flush()`，连跑两次验证**持久化** | ✅ 修复 FlashFile 宿主后：0→1、1→2，`RESULT=OK` |
| `LsoWrite.as` / `LsoRead.as` | 单次写入/读取（修复前的失败样本） | ❌ 修复前 `Error #2134` |
| `HttpProbe.as` | `URLLoader` 拉 `http://127.0.0.1:8099/probe.txt` | ✅ `COMPLETE bytes=20 BODY=BAO_FLASH_PROBE_OK` |
| `FullscreenProbe.as` | 点击后 `stage.displayState = FULL_SCREEN` | ❌ 请求被接受但 `displayState` 保持 `normal`，无 `FULL_SCREEN` 事件 |
| `Stage3DVisual.as` | 只清屏成红色，验证 3D 输出能上屏（**必须 `wmode="direct"`**） | ✅ 整屏红 = Stage3D 可用（软件驱动） |
| `Stage3DProbe.as` | `requestContext3D()` + `clear(red)` + `present()` | ❌ **Error #3702**（上下文创建失败） |
| `WebSocketProbe.as` | 反射 `flash.net.WebSocket` 连本地 WS | ⚠️ **Error #1065**（类不存在；Flash 29/34 的 DLL 里也搜不到 `WebSocket` 字样）→ 该特性对 29 不适用 |
| `NavigateProbe.as` | AS3 `navigateToURL` → 验证 `PPB_Flash::Navigate` | ✅ 修复 Flash 单例宿主后导航生效 |
| `ProbeBase.as` | 公共基类：黑底 + 绿色等宽文字输出 + `trace()` | — |

配套脚本：

| 文件 | 作用 |
| --- | --- |
| `build.ps1` | 用 Flex `mxmlc` 编译全部探针到 `out\` |
| `ws-server.cjs` | 极简 WebSocket 服务（8098，仅完成握手并发一条文本帧） |
| `probe.txt` | HTTP 探针的返回内容 |

**运行方式**（页面必须走 HTTP，不能用 `file://`，否则 LSO/网络行为会被 sandbox 限制）：

```powershell
# 1) 起本地站点：把 out\*.swf + 同名 .html 放在 D:\electron-build\probe-site
python -m http.server 8099 --bind 127.0.0.1     # 工作目录 = probe-site
node ws-server.cjs                              # 8098

# 2) 跑探针（harness 已支持 E19_URL）
set E19_URL=http://127.0.0.1:8099/Stage3DProbe.html
set E19_OUT=D:\electron-build\result-Stage3DProbe
electron.exe --allow-command-line-plugins "--register-pepper-plugins=<dll>#Shockwave Flash#Shockwave Flash 29.0 r0#29.0.0.171;application/x-shockwave-flash#swf#spl" --enable-logging --log-file=%E19_OUT%\chrome.log app140
```

截图里直接能读到 `RESULT=OK/FAIL`，不需要 OCR，也不需要 Flash 的 log 配置。

---

## 四、写新探针的模板

```actionscript
package {
  public class MyProbe extends ProbeBase {
    override protected function run():void {
      try {
        // ... 被测 API ...
        log("RESULT=OK");
      } catch (e:Error) {
        log("EXCEPTION " + e.errorID + " " + e.message);
        log("RESULT=FAIL");
      }
    }
  }
}
```

要点：

1. **继承 `ProbeBase`**（自带黑底 + 文字输出），在 `run()` 里做测试（`ADDED_TO_STAGE` 后 `stage` 才可用）。
2. **所有结论都 `log("RESULT=...")`**，截图即证据。
3. 需要点击的测试（全屏）：监听 `stage` 的 `CLICK`；自动化测试要用**真实鼠标事件**（`SendInput`/`mouse_event`），
   因为 `webContents.sendInputEvent` 不保证送到插件进程（实测无效）。
4. 需要网络/LSO 的测试：页面走 `http://127.0.0.1:8099/`，别用 `file://`。
