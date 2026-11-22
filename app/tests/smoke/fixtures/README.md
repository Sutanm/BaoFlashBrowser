# 冒烟样本

本地 PPAPI 验收用的可重复样本。均由本项目自编 AS3 生成，不是第三方产物。

| 文件 | 说明 |
| --- | --- |
| `flash.html` | 插件枚举 + SWF 装载 + JS↔Flash 变量桥探针。结果写入 `document.title`（`flash:loaded bridge`），供冒烟测试以外壳标签名读取。 |
| `probe.swf` | `probe.as` 的编译产物（SWF，2D Sprite，绘制品红块并通过 `ExternalInterface` 回调 `console.log`）。 |
| `probe.as` | SWF 源码。与 `D:\electron-build-142\flashprobe\as3\S3DChild.as` 同源。 |

```text
probe.swf  SHA-256  236C48D58406BBE0C08E7F2EC6829EF4022D153E84B3D160816CFEF4A7AF981A
```

## 运行前提

- 运行时目录（`app/.runtime/win-x64` 或打包产物）里存在 `pepflashplayer64.dll`（29.0.0.171）。
  主进程按 `BAO_FLASH_PLUGIN` → `electron.exe` 同目录 → `resources` 的顺序解析。
- 服务器以 `application/x-shockwave-flash` 返回 `.swf`，否则插件不会接管。

样本只验证「插件注册 + SWF 执行 + 变量桥」这一条链路。站点兼容规则、Stage3D 与全屏等
能力仍按 [142 真机报告 §10.16](../../../docs/reports/2026-11-21-142-flash-runtime.md) 的既有结论
和后续增量分别验收。
