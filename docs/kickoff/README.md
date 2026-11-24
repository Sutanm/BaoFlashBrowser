# 开工与阶段归档

此目录用于存放 BaoFlashBrowser Next 各阶段的立项、实施与验收记录。M0–M3 是唯一项目里程碑；Agent/自动化工作流的阶段映射见[现行权威架构 §18](../agent-automation-architecture.md#18-交付顺序)。旧架构第 6 节仅保留为 M0/M1 的历史立项依据。

## 阶段文件

| 阶段 | 文件 | 状态 |
| --- | --- | --- |
| M0 · 可复现的运行时 | [`m0-reproducible-runtime.md`](m0-reproducible-runtime.md) | 已通过（无独立建档，依据见该文件） |
| M1 · 浏览器薄切片 | [`m1-browser-slice.md`](m1-browser-slice.md) | **已验收**（2026-11-23） |
| M2 · 测试版 | [`m2-beta.md`](m2-beta.md) | **实施中，尚未验收**（当前阶段） |
| M3 · 专项能力 | [`m3-specialized-capabilities.md`](m3-specialized-capabilities.md) | 未立项（占位） |

每份记录包含阶段状态、交付范围、构建或提交标识、证据链接、遗留事项和最终验收结果。**M2 已进入实施但尚未通过，M3 尚未立项**；阶段中的单个增量可以写“已交付/测试通过”，但不得据此把整个阶段写成“已通过”。

## Agent/自动化工作流映射

| 项目阶段 | 架构工作流 |
| --- | --- |
| M2 | A0 已完成；A1 浏览器能力底座增量实施 |
| M3 | A2 CDP Hub → A3 Page Map → A4 确定性自动化 → A5 Agent Host → A6 工作流编译与视觉增强 |

A0–A6 不是新的里程碑编号，不能用“A1 完成”替代“M2 验收”。

## 与环境相关的文档

| 文档 | 内容 |
| --- | --- |
| [`dev-environment.md`](dev-environment.md) | 新机器 / 新成员搭建开发环境：自编译内核运行时的获取与校验、重建内核的慢路径、已知坑与就绪清单 |
