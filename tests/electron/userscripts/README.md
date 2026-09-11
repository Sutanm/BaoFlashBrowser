# 冻结的移植对照副本 — 不是当前实现

> **这个目录已被取代。其中的 `.ts` 文件不代表当前实现，其旁边的 `*.test.ts` 也不验证生产代码。**

## 这是什么

2026-08 用户脚本运行时从 demo 移植到 `src/` 时留下的**原始验证副本**。
移植过程中它被当作对照基线，见 `docs/superpowers/plans/2026-08-05-userscript-runtime-port.md`。

移植完成后，生产实现继续演进，而这里没有跟进。

## 关键风险：这里的测试跑的是这里的副本

本目录下的 `*.test.ts` 使用**相对导入**（如 `from './userscript-manager'`），
因此它们测的是**同目录的冻结副本**，而不是 `src/` 里的生产代码。

这意味着：**本目录下测试全绿，并不说明生产实现是正确的。**

漂移程度示例（2026-09 实测）：

| 文件 | 本目录副本 | 生产源码 |
| --- | ---: | ---: |
| `preload/gm-api.ts` | 18,099 B | **32,127 B**（副本仅约 56%） |
| `userscript-manager.ts` | 15,156 B | 22,949 B |

生产侧后续新增的能力（`GM_cookie` 只读、`GM_webRequest` 仅观测、`@background` 运行时等）
只存在于 `src/`，这里没有。

## 真正验证生产代码的测试在哪

- `tests/userscripts/` —— 17 个测试文件，导入 `src/` 生产源码。
  与本目录同名的测试已覆盖同等或更强的断言（例如 `userscript-parser.test.ts`：13 项 vs 本目录 12 项）。
- `tests/userscripts/scheduler.test.ts` —— 由本目录的 `scheduler.test.ts` 迁移而来。
  它是本目录中**唯一**在 `tests/userscripts/` 没有对应项的测试，故已迁移以保住 `src/webview-preload/userscripts/scheduler.ts` 的覆盖；本目录那份现已多余。
- `tests/electron/*-smoke.cjs` —— Electron 端冒烟，构建入口指向 `src/`。

## 为什么还留着

当初的实施计划要求「批次 6 验证通过前不删除，作为对照与回归」，
且删除需由用户确认（`...-userscript-runtime-port.md` L602）。

当前建议（2026-09 核查）：**删除本目录**。它已无法充当对照基线——内容已严重漂移，
反而会让人误以为这里提供了回归保护。保留只会制造虚假信心。
删除不会丢失任何覆盖：唯一独有的 `scheduler.test.ts` 已迁移。

在用户确认前保持现状，故添加本说明以免误读。
