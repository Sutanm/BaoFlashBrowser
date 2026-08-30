# ADR-004：CaptureFrame与Recognition结果所有权

> 状态：Accepted  
> 日期：2026-08-30

## Context

旧Match依赖Driver可变`lastFrame`，OCR又反向导入具体Driver Frame类型。

## Decision

CaptureFrame不可变，携带frameId、target/viewport/surface generation、captured region和FrameTransform。像素通过显式lease读取。Recognition candidate引用产生它的frameId/bitmap geometry；LocatedTarget在构造时投影到带Space logical geometry。任何消费都验证generation。

## Consequences

- 删除`lastFrame`合同。
- Vision与OCR可共享Frame但不能拥有BrowserView。
- Frame/evidence跨JS或日志边界需要单独权限和预算。

## Rejected

- Match只携带x/y/width/height。
- 每个Recognizer自行截图：无法可靠复用或统一失效。
