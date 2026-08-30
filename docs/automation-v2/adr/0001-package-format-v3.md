# ADR-001：Automation包格式使用v3

> 状态：Accepted  
> 日期：2026-08-30

## Context

当前`.baoauto`已使用`formatVersion: 2`且只承载旧Workflow/asset模型。Automation 2.0需要workflow、JavaScript、assets和profiles共存，并最终拒绝旧格式。

## Decision

新格式固定为`formatVersion: 3`。包包含`manifest.json`、可选`workflow.json`、`scripts/`、`assets/`和`profiles/`；manifest显式声明entrypoints、features、permissions和Core/API最低版本。grant保存在包外。Phase 8后v2直接拒绝，不提供migration或永久adapter。

## Consequences

- 产品架构名“2.0”与文件格式号不再混淆。
- Blockly与JS可在一个包内共存。
- 重构期间的v2 adapter必须登记并在Phase 8删除。

## Rejected

- 继续使用v2：无法区分旧语义。
- 自动迁移旧包：违反断代要求并形成长期兼容面。
