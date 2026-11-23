# ADR 0002：BaoFlashBrowser Next 技术栈（指针）

- 状态：**已移交 `next` 分支维护**（2026-11-23）
- 权威版：`next` 分支的 `docs/adr/0002-next-stack-baseline.md`（含 2026-11-21 / 11-22 更新）
- 本文件在 `main` 上**只作指路**，不承载内容——两条线各留一份必然再次分叉。
- 旧快照：[`../archive/adr/0002-next-stack-baseline.md`](../archive/adr/0002-next-stack-baseline.md)（2026-11-15 提案原文）

## 为什么不在 main 维护

2026-11-15 的提案把内核基线推荐为 **E37 / Chromium 138**、UI 框架留作"待定"。
2026-11-21–22 的实测与架构讨论把这两项都推翻了，而更新只落在 `next` 分支——
`main` 上那份逐渐变成"看起来像决策、其实是过时提案"的文件。按
[`../README.md`](../README.md) 维护规则第 6 条（同一事实只留一个权威出处），
`main` 改为指针。

## 现行结论（摘录，2026-11-23）

以下逐项摘自 `next` 分支文档，**论证与细节不在这里展开**：

| 项 | 结论 | 出处 |
| --- | --- | --- |
| 内核基线 | Electron 39（v39.8.10）/ Chromium 142.0.7444.265，原生 PPAPI 出帧 | `next` 分支 `docs/reports/2026-11-21-142-flash-runtime.md` |
| 语言 | TypeScript（内核决策的下位推论，**勿重议**） | `next` 分支 ADR 0002 §3 语言行 |
| UI 框架 | Vue 3 + Pinia | `next` 分支 ADR 0002（2026-11-21 更新） |
| 进程模型 | WebContentsView（弃 BrowserView） | `next` 分支架构讨论 §D1 |
| 构建链 | electron-vite 统一链（esbuild 散装双配置作废） | `next` 分支架构讨论 §A4-D2 |
| 版本号 | Next 从 `0.x` 起，独立 channel | [`../version-lines.md`](../version-lines.md) §2 |
