# Automation 2.0 文档控制中心

> 状态：Complete — Phase 0～8 已关闭  
> 最后更新：2026-08-30  
> 适用范围：BaoFlashBrowser Automation 1.x → Automation Core + 多前端

## 1. 本目录的角色

本目录是 Automation 2.0 重构期间的唯一执行入口。聊天记录、README 摘要和历史设计文档只能提供背景，不能替代这里的阶段状态、批准决策和验收证据。

执行顺序固定为：

```text
审计事实
  ↓
批准设计与 ADR
  ↓
阶段执行计划
  ↓
代码与测试
  ↓
验证证据
  ↓
阶段关闭
```

任何实现若无法追溯到已批准的 Requirement、ADR 或阶段任务，不进入 Automation 2.0 主线。

## 2. 权威文档

| 文档 | 状态 | 作用 |
|---|---|---|
| [automation-v2-execution-plan.md](automation-v2-execution-plan.md) | Complete | 主执行计划、阶段依赖、批次和门禁 |
| [status.md](status.md) | Complete | 当前阶段、下一动作、风险与验证摘要 |
| [automation-v2-architecture-audit.md](automation-v2-architecture-audit.md) | Approved | Phase 0 现状事实、量化、隐式合同、风险与Phase 1输入 |
| [automation-v2-core-design.md](automation-v2-core-design.md) | Approved | Phase 1 Core语义、接口草案与不变量 |
| [automation-v2-core-interfaces.draft.ts](automation-v2-core-interfaces.draft.ts) | Approved | 不进入产品构建的TypeScript接口草案 |
| [traceability.md](traceability.md) | Complete | Requirement → Audit → ADR/Design → Phase/Test映射 |
| [verification-log.md](verification-log.md) | Complete | 各批次命令、结果、平台和人工验证证据 |
| `legacy-removal-inventory.md` | Complete | 临时适配器与 Automation 1.x 删除清单 |
| [adr/](adr/) | Accepted | 10项关键且不可隐式改变的架构决策 |
| `phases/` | Complete | 每个 Phase 的详细执行计划与关闭状态 |

文档在首次需要时创建，不预建空白“已完成”产物。Phase 0 和 Phase 1 的文档必须完整评审后，才能创建相应实现阶段的执行计划。

## 3. 状态模型

每份活动文档和每个 Phase 使用以下状态之一：

- `Planned`：已进入路线图，尚未开始。
- `In Progress`：正在审计、设计、实现或验证。
- `Review`：内容完成，等待评审结论。
- `Approved`：设计或计划已批准，可以作为实现依据。
- `Verifying`：实现完成，正在收集自动化与人工验证证据。
- `Complete`：入口条件、实现、验证和文档均已关闭。
- `Blocked`：存在明确外部阻塞，并记录解除条件。
- `Superseded`：已由新的权威文档取代，禁止继续实施。

同一时间最多一个 Phase 为 `In Progress` 或 `Verifying`。研究型 benchmark 可以并行收集数据，但不得越过当前阶段的设计门禁改变产品代码。

## 4. 文档驱动执行规则

1. **先更新文档，再改变架构。** 新概念、范围变化、包格式、安全边界或兼容策略必须先写入设计或 ADR。
2. **Phase 0、1 禁止产品代码变更。** 只允许创建和修改审计、设计、计划、ADR 与验证记录。
3. **一批一证据。** 每个实现批次必须列出输入文档、目标文件、测试、退出条件和回滚边界。
4. **不以 LOC 判定拆分完成。** 以依赖方向、接口边界和替换测试判定。
5. **临时适配器必须登记删除。** 创建时同时写入 `legacy-removal-inventory.md`，包含引入 Phase、删除 Phase 和搜索标记。
6. **旧格式不形成永久兼容层。** Automation 2.0 是产品名称；新 `.baoauto` 使用新的文件格式版本，旧包最终明确拒绝。
7. **测试通过不等于阶段完成。** 还必须更新追踪矩阵、验证日志、风险和文档中的实际接口。
8. **不自动改写历史设计。** 被取代的文档标记 `Superseded`，保留其决策背景。
9. **不自动提交 Git。** 是否提交、如何分支和提交粒度由用户授权；计划要求每批保持可独立审查和回滚。

## 5. 每次执行的固定开场

开始任何 Automation 2.0 工作前，执行者必须：

1. 阅读本文件、`status.md` 和主执行计划。
2. 阅读当前 Phase 的全部权威文档和引用 ADR。
3. 检查工作树，保护用户未提交改动。
4. 核对当前 Phase 的入口门禁。
5. 在 `status.md` 中把唯一当前批次标为 `In Progress`。
6. 只实施该批次明确列出的范围。

批次结束时必须：

1. 运行计划要求的测试与探针。
2. 把命令、结果和未覆盖项写入 `verification-log.md`。
3. 更新 `traceability.md` 和 `status.md`。
4. 若接口与批准设计不同，停止关闭批次，先补 ADR 或修订设计并重新评审。

## 6. 已冻结的旧提案

下列设计抓住了“统一识别目标”的问题，但仍基于旧 Step/Runtime 和兼容迁移，不作为 Automation 2.0 实现依据：

- `docs/superpowers/specs/2026-08-29-recognition-target-unification-design.md`
- `docs/superpowers/specs/2026-08-29-text-target-in-pointer-blocks-design.md`
- `docs/superpowers/specs/2026-08-29-automation-continue-on-image-timeout-design.md`

Phase 0 应在审计中记录其可复用结论；Phase 1 重新决定 Action、Locator、错误与控制流语义。
