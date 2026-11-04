# Phase 7 — JavaScript Automation API / Sandbox 执行计划

> 状态：Complete  
> 输入：Phase 4能力服务、Phase 5 Runtime生命周期、ADR-008/009/010

## 安全原则

用户脚本运行在专用、临时、`nodeIntegration:false`、`contextIsolation:true`的隔离renderer中。Electron 11实测`webPreferences.sandbox:true`与自定义preload组合会导致renderer崩溃，因此不宣称具备Chromium OS sandbox；可信preload位于isolated world，脚本main world只得到冻结`bao`桥。Host只通过结构化Capability Broker暴露`bao.*`。不得使用Node `vm`作为安全边界，不得向脚本暴露`require`、`process`、Electron、Node文件系统、任意IPC、原始WebContents或宿主对象。

## API域

```text
bao.input   click / move / drag / keyPress / typeText / scroll
bao.vision  find / exists / readNumber(视觉区域入口委托OCR语义)
bao.ocr     findText / readText / readNumber
bao.page    url / navigate / reload
bao.time    sleep / now
bao.log     debug / info / warn / error
bao.notify  show
```

JavaScript原生提供`for/continue/try/catch/function/array/object`，不编译为Workflow IR。每次`bao.*`调用仍经过同一Core operation/context/grant/budget。

## 批次

1. `P7-T01`：冻结API request/result协议、capability映射、serializable value边界和错误码。
2. `P7-T02`：实现Host Capability Broker；逐调用验证grant、payload、target ownership、deadline和rate/byte budget。
3. `P7-T03`：实现`bao.input/vision/ocr/page/time/log/notify`host ports和Core服务适配。
4. `P7-T04`：实现sandbox preload，仅暴露一个不可变`bao`代理；request ID与run token绑定。
5. `P7-T05`：实现专用sandbox renderer host；唯一partition、默认拒绝network/navigation/popup/download/permission。
6. `P7-T06`：实现script run lifecycle、cancel、timeout、console forwarding和资源barrier。
7. `P7-T07`：实现manifest permissions → install grant → run grant；脚本不能自我提权。
8. `P7-T08`：安全负向测试：Node/Electron/任意IPC/网络/跨run token/超预算/不可序列化值。
9. `P7-T09`：端到端API smoke和复杂JS控制流样例。
10. `P7-T10`：全量验证、安全审查文档和Phase 8集成门禁。

## 验收

- `require/process/electron`在脚本世界不可用。
- `window.bao`冻结且无法替换底层transport。
- 所有Host调用有明确capability；默认deny。
- sandbox无任意IPC channel名能力、无任意URL网络能力。
- cancel完成后sandbox window、IPC route、timer和pending broker request均释放。
- JavaScript API复用Core服务，不调用旧Workflow Step/Runtime switch。

## 完成记录

- 固定19个`bao.*`method、7项capability与typed request/result协议。
- Broker按token、webContents route、grant、plain structured payload、method schema、bytes/calls/concurrency/deadline验证，默认deny。
- manifest → install → run grant逐层只能收紧；grant set运行期不可变。
- `createJavaScriptAutomationHostPorts`把API映射到Core Action/Locator/能力服务，不调用旧Step Runtime。
- preload只暴露冻结`bao`，没有通用IPC方法；专用renderer使用唯一临时partition、CSP及network/navigation/popup/webview/download/permission拒绝。
- cancel/timeout销毁window、删除route并等待Broker pending calls；infinite loop由Host timeout终止。
- Electron 11的`sandbox:true + preload`崩溃已实测并记录；实际边界为`nodeIntegration:false + contextIsolation:true`，不虚假宣称OS sandbox。
- 完整验证：102 files / 648 tests；typecheck、lint、build和真实Electron sandbox smoke通过。
