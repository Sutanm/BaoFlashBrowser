# Phase 3 — Locator + Action 实现计划

> 状态：Complete  
> 输入：Approved Core §11-13/24、ADR-005/006、Phase 2 Complete

## 边界

实现Locator、LocatedTarget、Action与Query Core contract。继续不修改Blockly UI；Vision/OCR/Input的具体服务拆分属于Phase 4，Phase 3通过窄port和旧Driver adapter连接。

## 批次

1. `P3-T01`：LocatorSpecMap、TargetRef、LocatedTarget、LocateOutcome、registry和selection。
2. `P3-T02`：CoordinateLocator resolver。
3. `P3-T03`：Image/Text resolver port与通用candidate adapter。
4. `P3-T04`：Click/Move/Drag Action executor，只消费LocatedTarget。
5. `P3-T05`：Find/Exists/Wait query语义。
6. `P3-T06`：Automation 1.x adapter，不改旧持久schema/Blockly。
7. `P3-T07`：Color test Locator扩展性合同、全量验证和关闭。

## 核心验收

- Core中不存在`click-image/click-text/click-coordinate` Action。
- Action executor不switch Locator kind。
- 新增Color测试Locator时Click/Move/Drag源码零修改。
- LocatedTarget在每次Action前验证Space generation。
- miss只在Action需要单目标时转为`TARGET_NOT_FOUND`；Exists只软化miss。
- 旧系统adapter带LEGACY标记并登记Phase 8删除。
