# ADR-007：Capture复用是Context内显式策略

> 状态：Accepted  
> 日期：2026-08-30

## Context

旧`withFreshFrame`只在局部Condition复用，运行、OCR、复核和前端测试仍重复截图。

## Decision

Frame cache属于Operation/ExecutionContext。只有target/viewport/surface generation相同、region覆盖、格式/scale满足、maxAge有效且未越过input/navigation freshness barrier时才复用。较大Frame可派生FrameView，共享frameId和像素lease。

## Consequences

- Image/Text/复核能在同一逻辑scope复用一帧。
- 不引入全局隐式last frame。
- input、scroll、navigation默认使后续识别需要fresh frame。

## Rejected

- 全局最近截图缓存：跨tab/generation风险高。
- 永远每个Recognizer独立截图：浪费且无法保证同一时刻语义。
