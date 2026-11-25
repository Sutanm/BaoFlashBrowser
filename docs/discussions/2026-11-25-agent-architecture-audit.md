# Agent 与自动化架构审计

2026-11-25 · **审计记录（已裁决并回填）**。本文逐条审查 [`agent-automation-architecture.md`](../agent-automation-architecture.md)（2026-11-24 SSOT）；裁决已于 2026-11-25 按第 8 节回填 SSOT。本文保留审计证据和备选项，实施一律以回填后的 SSOT 为准。

审计依据三类：

1. SSOT 自身条款是否自洽；
2. Next 现有源码是否支撑该条款（`app/src/`）；
3. 老项目（BaoFlashBrowser，Electron 11 / Chromium 87）已交付的实现是否提供反例或现成资产。

## 0. 结论摘要、裁决顺序与结果

> 本节问题表以及第 1–7 节的“现状/缺口/建议”均是**裁决回填前快照**；当前合同以本节“2026-11-25 裁决”和回填后的 SSOT 为准。

**总评**：方向成立，§3 三类角色、§9 两阶段观察、§10 三通道、§16「确定性步骤不调用模型」、§20 非目标清单均应保留。本轮复核后，原稿六项中只有「观察结果的来源封装缺少强制出口」可直接成立；其余多为值得澄清的实现风险，不能表述成已证实缺陷。另发现原稿漏掉了租约合同中 `id` / `leaseId` 的直接漂移，以及 `audio` owner 没有交付阶段。

| # | 复核后的问题 | 级别 | 位置 | 性质 |
| --- | --- | --- | --- | --- |
| 1 | **观察类**结果缺 Host 强制来源封装出口 | **P0** | §14.3 / §15 | 真实合同缺口 |
| 2 | `TargetRef` 的短期句柄语义与可持久化目标的命名、类型边界不够明确 | **P1** | §6.4 / §16 | 澄清项；原稿「混成一个结构」不成立 |
| 3 | 租约合同 `id` / 实现 `leaseId` 漂移；未来会话可能误用 `releaseOwner`；崩溃清理缺 holder 身份 | **P1** | §7 + `main/activity-lease.ts` | 一项现存漂移 + 两项未来风险 |
| 4 | CDP Hub 缺少「哪些能力经过 Hub」的路由边界和实测闸门 | **P1** | §8 / §18-A2 | 边界不清；原稿「Hub 没必要」证据不足 |
| 5 | A1 可增加非 UI 的 Capability 合同测试，但不应提前引入 Workflow 真实任务 | **P2** | §18-A1 | 验收增强；原建议破坏 A1–A4 顺序 |
| 6 | 不需要「Agent 不立项」常规分支；若产品定位改变，应走 ADR/SSOT 替代 | **不立项** | §2 / §18 / §21 | 原问题与现行产品定位冲突 |

**建议裁决顺序：#1 → #3 → #2 → #4 → #5；#6 关闭。**

理由：#1 是安全边界，#3 含已经存在的文档/代码合同漂移，优先收口；#2、#4 是实现前必须明确的类型与路由边界；#5 只增强 A1 验收，不改变阶段依赖。

### 2026-11-25 裁决

| # | 裁决 | 回填结果 |
| --- | --- | --- |
| 1 | **采纳 A** | SSOT §14.3 增加 `CapabilityResult` 来源联合类型；§15 管线增加 classify/wrap；只把页面派生内容标为不可信 |
| 2 | **采纳 A** | §6.4 保留短期 `TargetRef`，新增 `DurableTargetSpec`、可判别联合与统一 `validateTargetRef`；Shell target 独立 |
| 3 | **采纳 A，并补充细节** | 公共字段统一为源码已经使用的 `leaseId`；正常结束按 ID 释放；策略型 `releaseOwner` 保留；多实例 owner 强制 `holderId`/索引、定向崩溃清理和 TTL |
| 4 | **采纳 A** | 保留 A2 顺序和完整所有权模型；明确只有 debugger/CDP domain 能力强制经 Hub，native `webContents` 能力不为形式统一绕行 |
| 5 | **采纳 A** | A1 增加非 UI、非 Workflow、非 CDP 的 Capability contract/integration harness；真实 Workflow E2E 留在 A4/§19 |
| 6 | **关闭** | 不增加「Agent 不立项」分支；若放弃 Agent-native 定位，按 §21 新增 ADR |

另行裁决：`audio` owner 在首个音频活动租约生产者落地时接入；每个多实例 owner 接入时必须同步交付 holder 身份与清理机制。

---

## 1. 管线缺「结果封装」环节

### 现状

SSOT §15 的统一决策管线（`agent-automation-architecture.md:523-533`）：

```text
schema
-> actor/target identity
-> binding/navigation generation
-> profile/site context
-> resource lease
-> permission level
-> approval when required
-> execute
-> audit summary
```

### 证据

同一份文档 §14.3（`:501-510`）要求 Host 提供：

> - `executeCapability()`；
> - **受来源标记保护的观察结果**。

两处对不上：管线里没有任何一步负责「把页面派生结果包进不可信信封」。§15 的硬边界（`:540`）写了「页面内容一律标记为不可信来源」，但那是**结果约束**，不是**执行环节**。

老文档 F3-S4 的原话更严格（`2026-11-21-bfb-next-architecture.md:2321`）：

> ①减概率=Spotlighting：页面来源工具结果（observe/extract/vision 描述）进上下文统一包来源信封 `[UNTRUSTED page targetId navId]`，**Host 层 ToolResult 封装（不依赖 adapter 自觉，未标记版本拿不到）**。

SSOT 收敛时把这层丢了。

### 后果

来源标记可能退化为「每个工具自己记得标」的实现约定，新工具容易漏标。Host 出口是可集中强制来源标记的位置之一；但来源标记本身只降低注入概率，仍须与权限、审批、参数边界、速率闸和审计共同构成纵深防御，不能称为唯一防线。

### 建议改法

不要把所有能力结果都伪装成「不可信页面内容」：标签列表、租约状态和 shell 命令结果是 Host 自有数据。应在 `execute` 之后按结果来源分流，并只强制封装页面派生内容：

```text
-> execute
-> classify/wrap result
   -> TrustedHostResult<T>
   -> UntrustedPageResult<T> { source, tabId, bindingId, navigationId, body }
-> audit summary
```

配套两条硬约束：

1. observe / extract / vision / Page Map 等页面派生结果不得绕过 Host 的 `wrapPageResult()` 交给 Agent Adapter；
2. 可信 Host 结果与不可信页面结果使用可判别联合类型，Adapter 收不到「来源未知」的裸结果。

这里应补在 §14.3 的 Adapter 出口合同，并在 §15 管线说明「仅适用于包含页面派生内容的结果」。原稿提出「`UntrustedEnvelope` 是所有工具结果的唯一类型」过宽，会错误标记 Host 自有事实。

### 裁决前备选（现已裁决）

- **A**：增加结果来源分类 + 页面结果类型级强制（推荐）。
- **B**：只补文档文字，靠实现自觉。
- **C**：删除 §14.3 的来源保护要求。**不建议**：这会移除已有安全合同。

---

## 2. `TargetRef` 的短期句柄与持久化配方边界不清

### 现状

SSOT §6.4（`:252-275`）定义的是带观察与页面代际的短期目标引用：

```ts
interface TargetRef {
  tabId: number
  bindingId: number
  navigationId: number
  frameId?: string
  observationId: string
  targetId: string
  kind: 'dom' | 'ax' | 'surface' | 'visual' | 'shell'
  captureId?: string
  transformVersion?: number
}
```

### 证据（老项目对照）

老项目确实拆开了可序列化定位配方和解析结果，但这只能证明该拆分可取，不能证明 SSOT 已把二者合成一个类型：

| 老项目 | 结构 | 生命周期 | 位置 |
| --- | --- | --- | --- |
| `TargetRef` | **配方**：`locator`（coordinate/image/text/firstOf）+ `anchor` + `offset` + `selection` | 可序列化、设计为重新解析；能否复用取决于页面 | `src/shared/automation/core/locator.ts:65-70` |
| `LocatedTarget` | **解析结果**：`space` + `resolvedAt` + `locatorFingerprint` + `evidence` 等 | 构造及动作消费前集中校验空间代际 | 同文件 `:78-88`，`action.ts:109-111` |

原稿称老项目「已经跑过完整五阶段钓鱼流程」没有交付证据。归档的钓鱼方案仍含待验证项，不能作为已跑通事实。

SSOT 自身已在 §16 写成「`TargetRef` **或**可重新解析的语义目标」，所以不能据此断言它把配方与句柄合成了一个结构。真正缺口是：第二种类型没有命名，`TargetRef` 名称又容易让读者按老项目语义误认成配方；同时缺少统一的新鲜度校验合同。

### 后果

1. **Workflow 侧**：如果实现者把 §6.4 的短引用直接序列化进 Workflow IR，重启后必然失效；但这是 §16 类型未定义造成的歧义，不是 §6.4 结构本身必然错误。
2. **工具侧**：§6.4 规定了写操作与视觉坐标的最低校验，却没有规定统一校验入口，容易让校验散落在各工具中。
3. **命名侧**：老项目的 `TargetRef` 是配方，Next 文档的同名类型是观察快照内短引用，迁移时极易误用。

### 建议改法

明确命名并拆出三层职责：

```ts
// §6.4：保留为观察快照内短句柄；按 kind 建可判别联合，shell 不属于页面目标。
type TargetRef = DomTargetRef | AxTargetRef | SurfaceTargetRef | VisualTargetRef

// §16：可持久化并在每次执行时重新解析。
interface DurableTargetSpec {
  locator: LocatorSpec
  frameHops?: FrameLocatorRecipe[]
  anchor?: Anchor
  selection?: SelectionPolicy
}

// 所有消费短引用的动作都经过同一入口；规则按 action + kind 决定。
function validateTargetRef(action: BrowserAction, target: TargetRef): void
```

校验至少覆盖 binding、navigation、observation、frame/surface 有效性；视觉坐标还要覆盖 capture 与 transform。不能用原稿那张简化表：从旧 observation 提取内容通常也需要 navigation/observation 新鲜度，`shell.*` 则根本不应接受页面 `TargetRef`。Page Map 生成的临时目标也未必能反推出可持久化配方，所以短句柄不应强制包含 `spec`。

### 裁决前备选（现已裁决）

- **A**：保留短句柄，新增 `DurableTargetSpec`，移除 `kind: 'shell'` 并定义集中校验入口（推荐）。
- **B**：只命名持久化目标并补文字约束，具体联合类型在 A3 立项时定。
- **C**：维持现状，接受迁移和校验歧义。

---

## 3. 租约合同漂移与未来 holder 身份缺口

> 以下“现状/缺失/建议”记录的是**裁决回填前快照**。当前 SSOT 已统一使用 `leaseId`，并补入 required-holder、定向崩溃清理和 TTL 合同。

### 回填前已证实的现状

`app/src/main/activity-lease.ts` 是纯逻辑、可单测且不 import Electron 的租约实现。复核当时发现三件不同性质的事：

1. **当时存在的合同漂移（现已关闭）**：SSOT §7 的字段名是 `id`，实现使用 `leaseId`（`:30-54`）。裁决统一为 `leaseId`。
2. **当前批量语义合理**：`releaseOwner(tabId, owner)`（`:133-142`）是显式的同标签、同 owner 类别批量操作。唯一生产调用方是用户「保持活跃」开关，取消时故意清空该标签全部 `user` 租约（`browser-window.ts:1483-1497`）。改成只允许 `release(leaseId)` 会改变现有 UI 语义，并非「零风险」。
3. **未来存在误用风险**：若两个 AgentSession 共用一个 tab 且都登记 `owner: 'agent'`，任一 Session 结束时错误调用 `releaseOwner`，确会删除另一个 Session 的租约。但目前 `agent` 不在 owner 类型内，测试还明确拒绝它；SSOT 也没有规定 Session 结束调用 `releaseOwner`，所以这不是当前缺陷，更不是 M3「必然触发」。

### 回填前缺失的身份（现已补入合同）

回填前的 §7 要求「owner 崩溃时必须释放」，但 `owner` 只是类别，不是具体 Session、Task 或进程实例。把方法简单改名成 `releaseOwnerOnCrash` 仍会误杀同类别的存活 holder，无法实现该要求。当前 SSOT 已要求多实例 owner 使用 `holderId` 或等价索引。

### 当时建议的改法（已执行）

1. 公共字段名统一为 `leaseId`，同步 SSOT 与实现合同；
2. 在 §7 明确：正常生命周期结束必须按租约 ID 释放；`releaseOwner` 是显式批量策略操作，不得用于单 Session 结束；
3. M3 引入 Agent/Workflow owner 时增加 `holderId`（或维护 `sessionId -> leaseIds` 索引），崩溃清理由 holder 索引或 TTL 完成；
4. 保留现有 `user` 批量开关语义，并补一条「同 tab、同 owner 多条租约全部释放」单测以固化契约；
5. 补充裁决 SSOT 中已有但 A1/M3 交付范围均未提到的 `audio` owner。

### 裁决前备选（现已裁决）

- **A**：立即统一字段名与释放合同；holder 身份随首个多实例 owner 一起交付（推荐）。
- **B**：只统一字段名，把会话释放和崩溃清理推迟到 M3 设计。

---

## 4. CDP Hub 的适用边界需要写清

### 现状

SSOT §8（`:306-322`）称 Hub 是 Page、Perception、Automation 和 Agent 的共同底座，但真正的硬约束是：正式源码不得绕过 Hub **直接 attach**。这不等于 `capturePage`、`sendInputEvent` 等原生 `webContents` API 也必须经过 Hub。

A2 早于 A3 有直接理由：A3 已明确需要 DOMSnapshot、Accessibility 和 OOPIF，而这些能力需要统一管理 debugger attachment、domain 和 target 生命周期。问题不是「Hub 是否必要」，而是 §4 架构图和 §8 没有清楚区分 Core registries 与 CDP Hub，也没有写明哪些能力应绕过 CDP。

### 老项目证据的正确边界

老项目证明截图可以走 `capturePage`，部分元素边界读取可以走 `executeJavaScript`，`mouseMove` 有 `sendInputEvent` 路径；但其点击、拖拽、键盘、文本和滚轮大量经 `Input.*` CDP，`game-surface-detector.ts` 也大量使用 Target/Page/DOM/Runtime。`cdp-lease.ts` 主要解决每个 WebContents 单 debugger 客户端的排他与串行，不支持原稿「CDP 只出现两处」「80% 用不上」或「因为 CDP 贵所以排队」的结论。

同样，普通网络请求 broker 不能替代页面 Network/Fetch 拦截；`executeJavaScript` 也不能覆盖跨源/OOPIF DOM。具体操作是否使用 CDP，应按语义、可信输入和跨 frame 覆盖做 Electron 39 实测，而不是从 Electron 11 老实现直接外推。

### 建议改法

§8 补一条路由边界：

> 任何需要 `webContents.debugger` attachment 或 CDP domain 的正式能力必须经 Hub；不需要 debugger 的 `webContents` 原生能力不为统一形式而绕行 Hub。Core registries 与 CDP Hub 是并列基础设施，并非所有 Browser/Shell 能力都依赖 CDP。

保留 A2 的单连接、多消费者、domain 生命周期、OOPIF 与 detach 所有权模型。A2/A3 立项时为 DOM 操作、截图和输入分别记录选路探针，不在本文预判「一律 CDP」或「一律 webContents」。

### 裁决前备选（现已裁决）

- **A**：保留 A2 范围和顺序，补 Hub 路由边界与 E39 探针闸门（推荐）。
- **B**：维持现有宽泛措辞，把路由边界留给 A2 设计。

### 待验证

- Electron 39 / Chromium 142 下 debugger、DevTools 与其他客户端的共存/失效行为；
- 隐藏页面的两种截图路径、真实输入语义和 OOPIF 覆盖。

---

## 5. A1 可增加非 UI 的 Capability 合同测试

### 现状

原稿称 A1–A4「全程没有用例」不准确：A1 有 API/UI/代际/租约/smoke 退出条件，A2 有生命周期探针，A3 有三类 fixture，A4 有表单批填和测试平台用例。A1 的接入者也不只有 UI，还包括书签、历史、恢复、分组、下载与休眠等 M2 模块。

但这些大多仍是产品模块或 UI 适配者。增加一个直接调用 service 的非 UI contract/integration harness，确实可以更早验证显式 actor/target、代际、租约、稳定错误码和审计入口，而不让 API 只按某一 UI 调用形状生长。

### 不应采用的原建议

让 A1 跑「真实 workflow」会倒置阶段：Workflow Runtime 属 A4，而 A4 的进入条件是 A1–A3 可用。老项目钓鱼流程也没有完整交付证据，并依赖视觉/动态游戏能力，不适合作为 A1 基础闸门。表单批填同样已属于 A4。

### 建议改法

A1 退出条件追加：

> 提供一个不依赖 UI、Workflow Runtime、CDP Hub 或 Page Map 的 Capability contract/integration harness，直接覆盖 actor、显式 target、binding/navigation 拒绝、租约与稳定错误码；审计模块若尚未进入 A1，则至少固化可供后续审计消费的结构化调用记录合同。

真实确定性 workflow 与端到端任务仍由 A4、§19 验收。

### 裁决前备选（现已裁决）

- **A**：追加非 UI Capability harness（推荐）。
- **B**：维持现有 A1 退出条件。

---

## 6. 「若 Agent 不立项」不是现行架构的缺口

### 复核结论

§2 已把 Agent-native 定为产品定位，`ActorKind.agent` 是核心接口合同，不是空壳业务。§18 明确 M3 不要求一次交付 A2–A6，M2 owner 只实现五类、`agent` / `workflow` / `capture` 到 M3 再接入。源码收窄 owner 集合正是在执行该阶段策略，不是与文档口径分裂。

「A5 永远不发生」实质上是推翻产品定位，不能作为 §18 的常规分支。预先删除 `ActorKind.agent` 会制造核心 API churn，也不能因为实现延期就删除已经裁决的调用者类别。

### 建议处理

- 关闭本问题，不新增「若 Agent 不立项」小节；
- 可在 A5 立项记录中补 go/no-go/延期条件，并重申 A4 确定性自动化可以独立交付；
- 若未来正式放弃 Agent-native 定位，应按 §21 新增 ADR、替代 §2/§5/§14 的合同，而不是把它当成普通阶段裁剪。

### 裁决建议

- **A**：关闭原问题；仅在 A5 立项时补 go/no-go 条件（推荐）。
- **B**：发起产品定位 ADR，再讨论删除 Agent 合同。

---

## 7. 明确不需要改的部分

以下条款本次审计未发现问题，且是实现时最值钱的部分，不建议在裁决中一并改动：

| 条款 | 为什么保留 |
| --- | --- |
| §3 三类角色（Capability / Automation / Agent） | 职责切分干净，「Agent 决定做什么、Capability 决定能做什么、Automation 决定怎么稳定做」这句话可直接作为代码分层的判据 |
| §9 两阶段观察（Overview → Inspect） | 与 BrowserGym / browser-use 的成本治理同构，且解决了「不能把全部 frame 的 DOM 发给模型」 |
| §10 DOM/视觉/hybrid 三通道 | 与 Playwright MCP 官方建议一致；「视觉不是 DOM 失败后的 fallback」是 Flash/Canvas 场景的关键前提 |
| §16「确定性步骤不调用模型」 | 挂机 8 小时的成本与延迟都不能承受每步推理；这条是产品成立的前提 |
| §20 非目标清单 | 六条全部应该保留，尤其「不让模型直接消费完整 DOM 或原始 CDP 流」 |

---

## 8. 回填映射（已执行）

| # | 改动位置 | 改动形式 |
| --- | --- | --- |
| 1 | §14.3 + §15 管线/硬边界 | 增加可信 Host 结果与不可信页面派生结果的来源分类；页面结果只能经 Host 封装出口 |
| 2 | §6.4 + §16 | 保留短期 `TargetRef`；新增 `DurableTargetSpec`；移除 `kind: 'shell'`；定义集中校验合同 |
| 3 | §7 + `activity-lease.ts` | 已统一为 `leaseId`；区分单租约释放、策略批量释放和 holder 崩溃清理；已裁决 `audio` 阶段 |
| 4 | §4 架构图说明 + §8 | 明确 registries 与 Hub 并列、只有 debugger/CDP 能力必须经 Hub；保留 A2 所有权模型 |
| 5 | §18 A1 退出条件 | 增加不依赖 UI/Workflow/CDP 的 Capability contract/integration harness |
| 6 | 无 | 关闭；若放弃 Agent 定位，另走 ADR |
| — | `docs/README.md` | 裁决并回填 SSOT 后再更新本审计状态；无需为已归档旧 F 区另造冲突编号 |

上述回填已于 2026-11-25 执行；`docs/README.md` §7 的状态描述同步为「已裁决并回填」。

---

## 9. 本次审计未覆盖的范围

以下项均为**加法**（晚做不返工），本次不审，留到 M3 立项或真实需求出现时处理：

- Page Map 的具体字段与裁剪规则（§9）；
- 通道成本评分的权重与「历史定位成功率」的数据来源（§10.4 提到该因子，但全文没有定义其存储面——**这是一处已知空洞，不是本次审计的遗漏**）；
- `ProfileHandle` 的默认值与隔离策略（§13）；
- 审批 UX 形态（面板队列 vs 模态）；
- 模型 Adapter 的具体依赖选型（原 F8，仍为待审计）；
- Workflow IR 相对老项目 `core/workflow-ir.ts` 的增量范围（该文件已有表达式求值、值类型系统、`with` 作用域、if/loop/wait(query)，是可复用基线；SSOT §16 未提，属**资产浪费风险**，建议 M3 立项时补一条「以老项目 IR 为基线扩充 retry/checkpoint/evidence」）。

---

## 附录：本文的证据分级

| 结论 | 依据类型 |
| --- | --- |
| 第 1 条的合同缺口 | 【事实】SSOT §14.3、§15 与旧 Host ToolResult 合同对照；类型形状已裁决为 `CapabilityResult` 来源联合 |
| 第 2 条 | 【回填前事实】SSOT 已把 `TargetRef` 定为短引用，但持久化语义目标当时未命名；现已命名为 `DurableTargetSpec`，老项目仅用于证明拆分可行 |
| 第 3 条 | 【回填前事实】SSOT `id` 与源码 `leaseId` 曾漂移，现已统一为 `leaseId`；`releaseOwner` 符合 user 批量开关语义；未来多 Session 误用属于【推断】，已由 holder 合同预防 |
| 第 4 条 | 【事实】老项目同时使用 native 与 CDP 输入路径；具体选路和 E39 共存行为为【待验证】 |
| 第 5 条 | 【事实】A1–A4 各有现行退出证据；非 UI harness 是【建议】而非已证实缺陷 |
| 第 6 条 | 【事实】Agent-native 是 §2 现行产品定位，owner 的 M2 收窄由 §18 明定 |
| §9 中「历史定位成功率无存储面」 | 【事实】全文检索无对应数据面定义 |

---

*本文为已裁决审计记录。现行合同以 [`agent-automation-architecture.md`](../agent-automation-architecture.md) 为准；本文中的备选方案仅保留决策过程。*
