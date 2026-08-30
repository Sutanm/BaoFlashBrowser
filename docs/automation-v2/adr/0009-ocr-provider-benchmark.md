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

## Rejected

- 直接以PP-OCRv6 small替换现有baseline。
- 只测平均延迟或单张清晰中文图。
