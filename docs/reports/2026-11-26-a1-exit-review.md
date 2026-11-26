# A1 退出条件核对（2026-11-26）

对应[架构 §18-A1](../agent-automation-architecture.md#a1浏览器能力底座m2-当前工作)。
本文只**核对证据**，不代替验收：SSOT 里的 A1 状态由文档 owner 回填。

## 1. 逐条核对

| # | 退出条件 | 结论 | 证据 |
| --- | --- | --- | --- |
| 1 | UI 已通过统一 Capability API 调用关键标签动作 | **达成** | 10 类外壳标签动作全部经 `runCapability`（`select`/`close`/`duplicate`/`pin`/`mute`/`move`/`navigate`/`reload`/`set-engine`/`tearoff`）；`tab-ops` 断言操作者恒为 `human-ui` 且记录含 5 个动作；变异验证见[能力入口报告 §6.4](2026-11-26-capability-service.md#64-证据) |
| 2 | 休眠不会销毁持有阻止休眠租约的标签 | **达成** | `tab-discard` 11 条：租约阻止休眠、跨窗口移交后租约不丢、关闭后不残留；能力层 `tab.discard` 也有独立门禁（`lease-blocks-discard`） |
| 3 | WebContents 重建和导航代际可被测试观察 | **达成** | `TabRegistry` 21 条单测（事件顺序、先通知后失效、预留/提交、跨窗移交）+ `debugState()` 暴露真实 `binding` + `engine-switch` 8 条（提交校验导航代际） |
| 4 | 现有 smoke 全绿 | **达成** | 全量隐藏冒烟 **30 个文件 0 失败**（98.2 s，4 并发）；unit 283、data 11 |
| 5 | Capability contract/integration harness，不依赖 UI/Workflow/CDP/Page Map，覆盖 actor、显式 target、binding/navigation 拒绝、租约、稳定错误码 | **达成（合同层）** | `capability-contract.test.ts` 61 条，纯函数、不启动 Electron；「每个失败码都被真的走通一次」是硬断言。**集成层目前由 smoke 承担**（`tab-ops` / `tab-discard`），没有独立的无 UI 集成 harness——见 §2 |
| 6 | 固化可供后续审计消费的结构化调用记录合同 | **达成** | `CapabilityCallRecord`（身份 + 结论 + 时长，无载荷）+ `CapabilityCallLog`（环形 500）+ 未打包诊断钩子 `__baoCapabilityCalls()`；断言"记录里不含动作参数" |

## 2. 未覆盖与理由

| 项 | 状态 | 为什么可以晚做 / 什么时候必须做 |
| --- | --- | --- |
| `ShellRef` 的**生产者**（人机共用指认 UI） | 只有类型与校验器，`capabilityWorld().shellElement` 恒为 `false` | 指认 UI 属产品功能，不在 M2 剩余范围；外壳元素表必须与 UI 一起长出来，否则就是猜 ID。A1 交付的是**能接收并校验** `ShellRef` 的能力 |
| WindowRegistry / BrowsingContextRegistry | 未建 | 窗口归属已由 `TabRegistry.windowId` 表达；弹窗上下文身份在能力服务解析窗口/弹窗 target 前没有消费者（§18-A1「不为没有消费者的能力建空壳」）。A1-c 后续或 M3 与第一个消费者一起做 |
| 无 UI 的**集成** harness | 未做 | 现在的能力入口在控制器闭包里，脱离 Electron 跑不了。要么等动作实现搬出闭包（需要一次更大的重构），要么把集成断言留在 smoke。当前选择后者，并把它写成明确的技术债 |
| `tab.discard` 的运行时生产者 | 无（只被单测与校验器覆盖） | 属架构 §7 规则 12 的自动化侧能力，M3 的 Agent/Workflow 接入时才有调用方 |
| `audio` 租约 owner | 未接入 | 与上次口径一致：无真实生产者 |

## 3. 结论与建议

A1 的六条退出条件里，**五条有直接证据、一条（harness）达成于合同层**；未覆盖项都能说清"为什么不是现在"。

建议 SSOT 的 A1 状态这样写（供 owner 参考）：

> A1 · 浏览器能力底座：**M2 内达成（2026-11-26）**，证据见 `reports/2026-11-26-a1-exit-review.md`；
> 遗留两项明确挂账：`ShellRef` 生产者随指认 UI、Window/BrowsingContext 注册表随第一个消费者；
> 无 UI 集成 harness 记为技术债（当前由 smoke 承担）。

## 4. 复核方式

```powershell
cd app
npm run typecheck
npm run test:unit        # 283
npm run test:data        # 11
$env:ELECTRON_EXEC_PATH = (Resolve-Path '.runtime\win-x64\electron.exe').Path
npm run smoke            # 30 个文件，0 失败
```
