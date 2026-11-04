# Phase 4 — Vision / OCR / Input / Capture 解耦计划

> 状态：Complete  
> 输入：Phase 3 Complete、ADR-004/007/009/010

## 批次

1. `P4-T01`：Image/Text result绑定FrameGeometry，删除Driver `lastFrame`。
2. `P4-T02`：提取BrowserViewCaptureService与operation-scoped Frame cache。
3. `P4-T03`：提取VisionService，provider只消费Frame。
4. `P4-T04`：提取TextRecognitionService/TextRecognizer adapter，移除OCR对Driver类型反向依赖。
5. `P4-T05`：提取InputService与Browser Adapter，集中CDP lease和按键/鼠标释放。
6. `P4-T06`：Service/Driver变为兼容facade，工作台/助手复用CaptureService。
7. `P4-T07`：OCR benchmark harness与数据集manifest；比较baseline/small/tiny。
8. `P4-T08`：全量/Electron验证和职责搜索。

## 验收

- Driver无`lastFrame`、不自行实现bitmap→logical投影。
- OCR engine不导入`browserview-driver.ts`。
- Image/Text在兼容Context内共享CaptureFrame。
- Capture、Vision、Text、Input、Browser通过明确port协作。
- OCR单请求有deadline，hang触发restart，不永久阻塞queue。
- 未经benchmark不切换默认OCR。

## 完成记录

- `P4-T01`：Image/Text match绑定`CaptureFrameGeometry`，Driver删除`lastFrame`。
- `P4-T02`：`BrowserViewCaptureService`统一截图、归一化和operation-scoped frame cache。
- `P4-T03`：`AutomationVisionService`只消费Frame与provider port。
- `P4-T04`：`AutomationTextRecognitionService`分离TextLocator、ReadText、ReadNumber；Paddle不再导入Driver。
- `P4-T05`：`BrowserViewInputService`集中CDP lease、鼠标/键盘和drag release。
- `P4-T06`：旧Driver成为兼容facade；工作台与页面助手经同一Service创建Driver，共享能力实现。
- `P4-T07`：增加provider-neutral benchmark harness与corpus manifest；v6候选二进制尚未接入，默认provider保持baseline。
- `P4-T08`：typecheck、lint、614项测试、build及两个Electron探针通过。
