# BaoFlashBrowser Next

BaoFlashBrowser Next 从独立的 `next` 分支开始。当前提交收录产品架构、内核移植记录与相关验证资料。

**当前阶段：M1 已验收；M2 正在实施，尚未整体验收；M3 尚未立项。**

## 从这里开始

- [文档地图与单一事实源](docs/README.md) · **建议先读**：哪份文档算数、冲突登记在哪、新文档怎么加。
- [Agent 与自动化架构](docs/agent-automation-architecture.md) · **现行权威**：产品定位、能力分层、CDP、Page Map、自动化、Agent 与交付顺序。
- [M2 实施与验收记录](docs/kickoff/m2-beta.md) · 当前已交付增量、剩余范围、A1 浏览器能力底座和阶段退出条件。
- [应用初始化与本地启动](app/README.md) · 安装、运行和验证 Win x64 外壳。
- [跑测试的规范](app/README.md#跑测试先设环境变量再选范围) · **每个新会话先看**：`ELECTRON_EXEC_PATH`
  怎么设、按改动大小选范围、新用例要登记哪两处、失败先看什么。

- [浏览器工程架构](docs/discussions/2026-11-22-bfb-next-architecture.md) · 内核、发布、外壳、标签、隔离和数据合同；产品定位与 Agent/自动化章节已归档。
- [架构审计](docs/discussions/2026-11-22-bfb-next-architecture-audit.md) · 原稿逐项评估和上游依据。
- [M1 增量记录：外壳、双标签与本地 PPAPI 样本](docs/reports/2026-11-22-m1-shell-increment.md) · 首个实现增量的条款对应、构建标识与实测输出。
- [内核补丁记录](docs/kernel/README.md) · 自编译内核的补丁序列、构建标识与复现步骤。
- [Chromium 142 Flash 运行报告](docs/reports/2026-11-21-142-flash-runtime.md) · 包含 Electron 39.8.10 / Chromium 142.0.7444.265 的构建与验收记录。
- [142 构建与启动记录](docs/reports/2026-11-20-142-build-bringup.md) · 早期构建与移植过程。

## 历史决策与研究

[原架构讨论](docs/discussions/2026-11-21-bfb-next-architecture.md)、[技术栈讨论](docs/discussions/2026-11-21-bfb-next-tech-stack.md)和[早期技术栈 ADR](docs/adr/0002-next-stack-baseline.md)保留当时的决策过程。版本与实测结果以运行报告的最新记录为准。文档提到的 Chromium 87 源码、模块文档和旧探针可在原项目查阅。 [原项目](https://github.com/Sutanm/BaoFlashBrowser/tree/main)

D:\electron-build-142为chromium源码仓库，可以直接看本地