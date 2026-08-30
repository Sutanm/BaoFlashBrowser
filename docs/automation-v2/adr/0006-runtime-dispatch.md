# ADR-006：Runtime控制流与扩展Dispatch分离

> 状态：Accepted  
> 日期：2026-08-30

## Context

旧Runtime以不断增长的`switch(step.type)`同时承载控制流和所有动作/目标组合。

## Decision

Runtime只穷举少量固定IR控制节点：sequence、if、loop、break、continue、wait、action、query、let/set、with context。Action、Query和Locator分别由启动时冻结的registry dispatch。未知kind在compile/validation阶段拒绝。

## Consequences

- 控制流switch规模稳定。
- 新Locator不触及Action或Runtime control interpreter。
- Blockly不承担try/catch、function、class、closure等完整语言能力。

## Rejected

- 所有节点完全插件化：对有限Workflow过度设计。
- 继续扩展单一Step switch：无法满足正交扩展约束。
