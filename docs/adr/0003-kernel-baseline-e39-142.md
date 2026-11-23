# ADR 0003：内核基线更正为 Electron 39 / Chromium 142

- 状态：**已接受**（2026-11-23）
- 决策人：项目负责人
- 关系：**推翻 [ADR-0002](0002-next-stack-baseline.md) §2「内核基线」**；其余章节不受影响
- 依据：[142 真机报告](../reports/2026-11-21-142-flash-runtime.md)、[往上推进版本可行性评估](../specs/2026-11-15-forward-version-feasibility.md) §1.7、[内核补丁记录](../kernel/README.md)

## 背景

ADR-0002（2026-11-21）推荐 Electron 37 / Chromium 138 作为基线，当时 140 与 142 尚未验证。此后 140、142 均完成受控移植与出帧验证，原始推荐的前提已不成立。

## 决策

1. 基线改为 **Electron 39.8.10 / Chromium 142.0.7444.265**，内核 tag `bao-v142-265-ppapi-sandbox`（回退点 `bao-v142-265-verified`），补丁序列见 [kernel/README](../kernel/README.md)。
2. **144+ 不作为演进目标**：144 起 legacy IPC 消息系统整体移除，PPAPI 约 300 条消息失去编译基础，复活需 2–3 个月且风险高（spec §1.7 实测）。
3. 后续若需要更新的 Web 平台能力（例如 WebMCP），默认走**用户态实现**或**挑补丁进 142**，不以升级内核为默认手段。

## 后果

- 自编译内核与插件成为发布前置条件：`runtime:check`、`pack:win` 按 `scripts/runtime-manifest.json` 做 SHA-256 门禁。
- Electron 39 线已于 2026-05-05 结束上游支持，可发布范围须按实际维护能力单独审定（提案 §2）。
- 内核补丁须按「可 rebase 的最小集」维护，并持续监视上游 rendering/hidden/WebContentsView 类目的变更。
