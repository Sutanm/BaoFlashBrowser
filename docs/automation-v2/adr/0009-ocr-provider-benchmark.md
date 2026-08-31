# ADR-009：OCR provider通过benchmark选择

> 状态：Accepted  
> 日期：2026-08-30

## Context

当前PaddleOCR-json + PP-OCRv3是稳定baseline；RapidOCR/ONNX + PP-OCRv6 small/tiny是候选。仅凭模型版本不能决定游戏自动化默认方案。

## Decision

Phase 1冻结TextRecognizer provider接口，不切换默认实现。Phase 4使用相同数据集比较准确率、ROI/全帧cold/warm延迟、p95、RSS/CPU、安装体积、cancel、timeout、crash/hang恢复。small与tiny分别评估。候选达到批准门槛前保留现有baseline。PixelGlyphRecognizer排除在P1-P8外。

## Consequences

- OCR切换有可复现实证。
- provider lifecycle必须支持deadline/cancel/restart/close。
- 跑商价格识别可成为ReadNumber真实benchmark之一。

## 2026-08-31 实施补充

RapidOCR和Paddle Inference均曾按独立Sidecar接入，同一`AutomationOcrEngine`合同直接接收BGRA内存帧。Windows small/tiny benchmark后保留PP-OCRv3模型；随后Windows C++ BAO1候选在准确率不变的前提下将warm mean/p95从24.8/35.1ms降至17.6/27.8ms，1000次稳定性与恢复门禁通过，因此替换PaddleOCR-json路径协议。Linux也使用Paddle Inference C++ + PP-OCRv3。Rapid候选未通过门禁，已删除运行时、Provider回退与构建入口。详见`../ocr-cross-platform-plan.md`和`../windows-cpp-bao1-sidecar-design.md`。

## Rejected

- 直接以PP-OCRv6 small替换现有baseline。
- 只测平均延迟或单张清晰中文图。
