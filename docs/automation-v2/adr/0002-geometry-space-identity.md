# ADR-002：Geometry单位与Space identity

> 状态：Accepted  
> 日期：2026-08-30

## Context

旧Point/Region依靠调用位置解释page/game、logical/display/bitmap/preview，导致重复转换和`lastFrame`隐式合同。

## Decision

持久几何默认使用`ratio [0,1]`，运行时使用有限logical浮点。每个Point/Region必须携带SpaceRef。公共Space仅有ViewportSpace与SurfaceSpace；bitmap/display是Adapter内部空间。运行时identity包含target、viewport和surface generation。Region使用半开边界，舍入只发生在命名Adapter边界。

## Consequences

- 无品牌geometry在Core中非法。
- 旧`0..10000`只存在于临时adapter。
- stale generation可在输入前验证。

## Rejected

- 全部使用整数pixel：无法跨DPI/zoom/surface复用。
- 保留page/game枚举：不能表达嵌套或未来Surface。
