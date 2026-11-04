# Automation 2.0 JavaScript Sandbox Security Review

> 状态：Accepted — Phase 7/8 verification complete  
> 平台：Electron 11.5.0 / Chromium 87（项目锁定，不升级）

## 结论

JavaScript Automation不在main/preload/BrowserView页面或Node `vm`中运行。每次run创建唯一、非持久partition的隐藏renderer；用户代码位于main world，`nodeIntegration:false`、`contextIsolation:true`。可信preload位于isolated world，只通过`contextBridge`暴露冻结的`window.bao`。

Electron 11实测在本项目环境中启用`webPreferences.sandbox:true`并加载自定义preload会导致renderer进程崩溃。因此本实现没有Chromium OS sandbox，不能写成“完全沙箱”。安全边界依赖无Node main world、context isolation、专用session、CSP、navigation/network/permission/download拒绝和最小Capability Broker。将来若替换Electron内核，必须重新评估`sandbox:true`，不能在本项目直接升级Electron。

## 威胁模型与控制

| 威胁 | 控制 |
|---|---|
| `require/process/electron`访问 | page world `nodeIntegration:false`；Electron smoke确认均为`undefined` |
| 任意IPC | preload不暴露`ipcRenderer`或channel参数，只暴露固定`bao.*`方法 |
| 跨run调用 | 256-bit run token保存在preload闭包；main按`webContents.id + token`双重路由 |
| 自我提权 | manifest permissions ⊇ install grant ⊇ run grant；三层只能收紧 |
| 网络/数据外传 | CSP `connect-src/img/media/object/frame none`；唯一session的webRequest再次拒绝HTTP(S)/WS/file/FTP |
| navigation/popup/webview/download | `will-navigate/new-window/will-attach-webview/will-download`全部拒绝 |
| 权限API | session permission handler一律拒绝 |
| 非结构化Host对象 | Broker仅接收plain JSON-like value；拒绝cycle、prototype、NaN、函数、symbol、bigint和超深值 |
| DoS | source/result/request bytes、call/concurrency、per-call deadline、run timeout；timeout销毁renderer |
| 资源泄漏 | cancel/timeout删除IPC route、销毁window、abort并drain broker pending calls |
| 错误泄密 | response只有稳定code和message；不返回Host stack或对象 |

## Capability映射

| API | Capability |
|---|---|
| `bao.input.*` | `input` |
| `bao.vision.*` | `vision` |
| `bao.ocr.*` | `ocr` |
| `bao.page.url` | `page.read` |
| `bao.page.navigate/reload` | `page.navigate` |
| `bao.log.*` | `log` |
| `bao.notify.show` | `notify` |
| `bao.time.*` | 无权限，但受run/call/time budget |

Broker默认deny。未知method、错误token、未授权capability和错误payload都在调用Host port前拒绝。

## 验证证据

`probe:automation-js-sandbox`运行真实Electron renderer/preload/Host/Broker，验证：

- Node/Electron/任意IPC不可见；
- `bao`及子域被冻结，transport不可替换；
- CSP与session阻止网络；
- 未授权notify返回`PERMISSION_DENIED`；
- 原生function/array/for/continue/try-catch正常；
- infinite loop被Host timeout销毁并返回cancelled；
-正常API通过固定broker route返回。

## 残余风险

1. 没有Chromium OS sandbox；若Chromium 87 renderer本身被攻破，可能越过page-world边界。这是锁定Electron 11的已知平台风险。
2. 用户脚本仍可消耗CPU直到Host timeout销毁renderer；较短的Host hard timeout是必要策略。
3. `page.navigate`会对真实BrowserView产生外部网络效果，必须显式grant；sandbox自身仍无网络。
4. `input/notify/log`可能产生用户可见副作用，run UI必须展示grant范围。
5. Phase 8集成时必须保证脚本路径经过包根路径校验，不能让manifest entry读取任意文件。

任何新增`bao.*`方法都必须先进入protocol capability map、payload validator、grant UI和负向测试，不能通过通用`invoke(channel, payload)`绕过Broker。
