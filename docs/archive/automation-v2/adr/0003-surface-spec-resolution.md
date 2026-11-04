# ADR-003：SurfaceSpec与ResolvedSurface分离

> 状态：Accepted  
> 日期：2026-08-30

## Context

持久game locator、临时candidate、bound fingerprint和viewport revision目前混在Service/Driver状态中。

## Decision

`SurfaceSpec`只保存定位意图；`ResolvedSurface`是绑定target/surface generation的不可变运行时结果。Surface形成以Viewport为根的无环树，可表达element、visual、region和named profile。Flash、Ruffle、Canvas、iframe、container只是resolver hint，不改变Action语义。重定位生成新generation，不修改旧对象。

## Consequences

- Workflow不保存DOM/CDP/WebContents对象。
- `with surface`统一所有视觉区域。
- Surface等待进入可取消Operation生命周期。

## Rejected

- 在每个Action保留page/game下拉。
- 原地刷新ResolvedSurface：会让旧Frame/Match含义漂移。
