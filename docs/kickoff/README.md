# 开工与阶段归档

此目录用于存放 BaoFlashBrowser Next 各阶段验收完成后的记录。阶段划分和验收条件见[新版架构第 6 节](../discussions/2026-11-22-bfb-next-architecture.md#6-交付顺序和验收)。

## 阶段文件

| 阶段 | 文件 | 状态 |
| --- | --- | --- |
| M0 · 可复现的运行时 | [`m0-reproducible-runtime.md`](m0-reproducible-runtime.md) | 已通过（无独立建档，依据见该文件） |
| M1 · 浏览器薄切片 | [`m1-browser-slice.md`](m1-browser-slice.md) | **已验收**（2026-11-23） |
| M2 · 测试版 | [`m2-beta.md`](m2-beta.md) | 未验收（占位） |
| M3 · 专项能力 | [`m3-specialized-capabilities.md`](m3-specialized-capabilities.md) | 未立项（占位） |

每份记录包含验收日期、交付范围、构建或提交标识、验收结果、证据链接和遗留事项。**M2/M3 目前是占位文件，验收前不得写入任何「已通过」表述**；占位与回填同样受此约束。

## 与环境相关的文档

| 文档 | 内容 |
| --- | --- |
| [`dev-environment.md`](dev-environment.md) | 新机器 / 新成员搭建开发环境：自编译内核运行时的获取与校验、重建内核的慢路径、已知坑与就绪清单 |
