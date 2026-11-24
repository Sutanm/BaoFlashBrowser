# 冒烟样本

本地 PPAPI 验收用的可重复样本。均由本项目自编 AS3 生成，不是第三方产物。

| 文件 | 说明 |
| --- | --- |
| `flash.html` | 插件枚举 + SWF 装载 + JS↔Flash 变量桥探针。结果写入 `document.title`（`flash:loaded bridge`），供冒烟测试以外壳标签名读取。 |
| `probe.swf` | `probe.as` 的编译产物（SWF，2D Sprite，绘制品红块并通过 `ExternalInterface` 回调 `console.log`）。 |
| `probe.as` | SWF 源码。与 `D:\electron-build-142\flashprobe\as3\S3DChild.as` 同源。 |
| `keyprobe.html` | 插件**内部输入**探针页面：SWF 收到 `keydown` 后通过 `ExternalInterface` 回调把 `keyCode:charCode` 列表暴露给页面 JS。 |
| `keyprobe.swf` | `Keyprobe.as` 的编译产物，942 B。 |
| `Keyprobe.as` | 键盘输入探针源码。 |
| `keyprobe-config.xml` | 编译配置（Apache Flex 4.16.1，`target-player` 11.1）。 |

```text
probe.swf     SHA-256  236C48D58406BBE0C08E7F2EC6829EF4022D153E84B3D160816CFEF4A7AF981A
keyprobe.swf  SHA-256  3E9D93F9C8D6733020075472CBED1A85E3B60BC7C29F5A8C7F7D0E179AF0E6CA
```

## 重新编译 keyprobe.swf

本机 Flex SDK 在 `D:\tools\flex-sdk`（Apache Flex 4.16.1，Java 8）。`mxmlc.bat` 的参数顺序很挑，
**只能把源文件作为唯一位置参数、不传 `-output`**（否则报「默认自变量不能与其它选项交错在一起」），
并设置 `PLAYERGLOBAL_HOME`：

```powershell
cd app\tests\smoke\fixtures
$env:PLAYERGLOBAL_HOME = 'D:\tools\flex-sdk\frameworks\libs\player'
D:\tools\flex-sdk\bin\mxmlc.bat Keyprobe.as   # 产物即 keyprobe.swf
```

## 本地真实游戏样本（不入库）

真实站点的手工对照需要第三方游戏 SWF（例如 4399 的《狂扁小朋友》）。这类素材属于第三方
内容，**不随仓库分发**，由使用者自行准备，放在 `docs/` 下即可（根 `.gitignore` 已忽略
`docs/*.swf`）。

- 自动化验收一律用本目录的自编样本，不要依赖真实游戏；
- 手工对照时把 SWF 放到 `docs/`，再用 `file://` 或本地静态服务器打开即可。

## 运行前提

- 运行时目录（`app/.runtime/win-x64` 或打包产物）里存在 `pepflashplayer64.dll`（29.0.0.171）。
  主进程按 `BAO_FLASH_PLUGIN` → 用户导入 → `electron.exe` 同目录 → `resources` → 自动发现
  （本机已安装的 Flash）的顺序解析。
- 服务器以 `application/x-shockwave-flash` 返回 `.swf`，否则插件不会接管。

样本只验证「插件注册 + SWF 执行 + 变量桥」这一条链路。站点兼容规则、Stage3D 与全屏等
能力仍按 [142 真机报告 §10.16](../../../docs/reports/2026-11-21-142-flash-runtime.md) 的既有结论
和后续增量分别验收。
