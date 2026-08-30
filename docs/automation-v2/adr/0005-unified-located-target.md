# ADR-005：Locator统一返回LocatedTarget

> 状态：Accepted  
> 日期：2026-08-30

## Context

旧Action按click-image/click-text/click-coordinate复制，新增Locator会扩散到Runtime、Schema和Blockly。

## Decision

Coordinate/Image/Text Locator通过registry解析为统一LocatedTarget。结果至少包含activationPoint、Space/generation、resolvedAt，识别目标可带bounds/confidence/frame/evidence。Action只消费LocatedTarget，不读取Locator kind。anchor/offset属于TargetRef，timeout/retry属于Query/Context。

## Consequences

- 新增Locator不修改Click/Move/Drag。
- Coordinate target无需伪造图片bounds或confidence。
- stale/reacquire策略集中在Action执行管线。

## Rejected

- 每类Locator定义一套Action。
- `LocatedTarget`暴露provider-specific object：会把Action重新耦合到Recognizer。
