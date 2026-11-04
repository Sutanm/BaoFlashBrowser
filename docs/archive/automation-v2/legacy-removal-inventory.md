# Automation 2.0 Legacy Removal Inventory

> 状态：Complete — all entries removed in Phase 8  
> 规则：所有临时适配器必须有唯一ID、owner、搜索标记和删除Phase

| ID | Introduced | Owner | Purpose | Search marker | Delete no later than | Removal condition |
|---|---|---|---|---|---|---|
| LEGACY-P2-001 | Phase 2 | Coordinate/Surface migration | 旧`0..10000` coordinate/region转Core ratio geometry | `LEGACY-P2-001` | Phase 8 | Workflow v3不再加载旧Step/geometry |
| LEGACY-P2-002 | Phase 2 | Coordinate/Surface migration | 旧Driver page/game surface状态适配为ResolvedSurface/Space | `LEGACY-P2-002` | Phase 8 | Runtime/Context不再调用旧coordinateSpace API |
| LEGACY-P2-003 | Phase 2 | Frame migration | 旧ImageMatch + Driver lastFrame桥接到FrameGeometry | `LEGACY-P2-003` | Phase 4 | Vision/OCR返回frame-bound result，Driver lastFrame删除 |
| LEGACY-P3-001 | Phase 3 | Locator/Action migration | 旧pointer Step转Core Locator/Action plan | `LEGACY-P3-001` | Phase 8 | Workflow v3前端直接生成Core Action/Locator |
| LEGACY-P5-001 | Phase 5 | Runtime migration | 可表示的旧Workflow单向翻译为Runtime 2.0 IR；不进入持久化格式 | `LEGACY-P5-001` | Phase 8 | Blockly/Recorder直接生成v3 IR，旧Workflow不再支持 |

Phase 8删除结果：上述五个marker对应源码与测试均已删除；marker仅保留在本历史清单和审计文档中。

创建临时代码时必须把对应marker写入源码注释。Phase 8关闭前全仓搜索这些marker和旧类型必须为零。
