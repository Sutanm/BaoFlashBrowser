# M2 / A1 增量：活动租约与标签休眠生命周期整合

2026-11-24 · 对应[架构 §7 标签生命周期与活动租约](../agent-automation-architecture.md#7-标签生命周期与活动租约)、
[§18 A1](../agent-automation-architecture.md#a1浏览器能力底座m2-当前工作)。
基线提交 `9a1752b`。代码：`app/src/main/activity-lease.ts`（新增）、
`app/src/main/browser-window.ts`（接入）、`app/tests/unit/activity-lease.test.ts`（新增）、
`app/tests/smoke/tab-discard.test.cjs`（新增 3 条）。

## 1. 决定

| 决策 | 选择 | 依据 |
| --- | --- | --- |
| 休眠豁免的表示 | 从 `Tab.keepAwake: boolean` 换成**活动租约表** | 架构 §7：`keepAwake` 承载不了下载、会话恢复、DevTools、Agent/Workflow 的分层生命周期；全局布尔拼不出「谁、何时、为什么」 |
| 归属键 | 稳定 `tabId`（不是 `webContents.id`、不是窗口） | 架构 §6.5：`tabId` 跨窗口移动不变；拖出标签时租约必须跟着走 |
| 表的位置 | 主进程单例（`activityLeases`） | 表挂在窗口上，拖出后新窗口就看不见旧租约——正是本增量要保证不丢的东西 |
| 过期语义 | `expiresAt` 可选；`expiresAt <= now` 即失效；查询时过滤 + 扫描周期 `sweepExpired()` 回收 | 架构 §7 规则 2：owner 崩溃或忘记释放不能把标签永久锁活；确定性时钟注入便于单测 |
| M2 owner 集合 | `user` / `session-restore` / `download` / `devtools` / `system` | 架构 §18 A1 明确的首版集合；`agent`/`workflow`/`capture` 不预留（无真实消费者，见 §4） |
| `keepAwake` 的投影 | `BrowserState.keepAwake` 由租表现算（`hasOwner(tabId, 'user')`），标签上不再存字段 | 单一事实源；UI 行为与协议字段保持兼容 |
| 多租约优先级 | 不设优先级：任意一条有效且 `preventsDiscard` 的租约即阻止休眠 | 架构 §7 规则 4；消费者之间不需要协商 |
| 租约期间的后台计时 | 命中租约时把 `backgroundSince` 重置为当前时刻 | 否则「已挂机 1 小时的标签被 2 分钟的下载租约保护」会在租约结束时立刻被丢弃 |

**为什么这个增量不需要先提取 TabRegistry（代码证据）**：

- 标签业务 ID 已经是全局稳定值：`id: nextTabId++`（`browser-window.ts` 的 `addTab` / `openInternalTab`）；
- 跨窗口移动是「同一个 `Tab` 对象换宿主」，`detachTab()` / `adoptTab()` 既不重建对象也不改 `id`；
- 休眠/唤醒/引擎切换改的是 `tab.binding`（WebContents 代际），`tabId` 不受影响。

因此租约只要按 `tabId` 记账就已满足约束，强行先抽 TabRegistry 属于为重构而重构（架构 §17 的提醒）。
Tab/Window/BrowsingContext 注册表与显式 actor/target 的 Capability API 仍是 A1 的剩余项。

## 2. 实现

### 2.1 新模块 `app/src/main/activity-lease.ts`

纯逻辑，**不 import electron**（因此可以在 Node 里毫秒级单测）：

```ts
interface ActivityLease {
  leaseId: string        // 自动生成 `lease-N`，或调用方显式给出
  tabId: number          // 稳定业务身份
  owner: 'user' | 'session-restore' | 'download' | 'devtools' | 'system'
  preventsDiscard: boolean   // 默认 true
  reason: string
  expiresAt?: number     // 省略 = 无期限，直到 owner 释放
}
```

`ActivityLeaseManager` 的公开面：

| 方法 | 用途 |
| --- | --- |
| `acquire(request)` | 申请；显式 `leaseId` 时是**幂等续租**（同 tabId+owner），不同 tabId/owner 复用同一 ID 抛错 |
| `release(leaseId)` | 单条释放（幂等） |
| `releaseOwner(tabId, owner)` | owner 结束时的批量释放（用户取消「保持活跃」走这条） |
| `releaseTab(tabId)` | 标签/窗口关闭时清空该标签的全部 owner |
| `sweepExpired(at?)` | 确定性回收过期租约，返回条数 |
| `blocksDiscard(tabId, at?)` | 是否存在有效且 `preventsDiscard` 的租约（休眠判定的唯一入口） |
| `hasOwner(tabId, owner, at?)` | 某 owner 是否持有**有效**租约（`keepAwake` 投影用它） |
| `active(tabId, at?)` | 该标签当前有效租约副本（诊断/测试） |

参数非法（`tabId` 非正整数、未知 owner、空 `reason`、`expiresAt` 非有限数）一律抛 `TypeError`：
主进程内部 API 静默容忍只会变成「租约悄悄没生效」。

### 2.2 `browser-window.ts` 接入点

| 位置 | 改动 |
| --- | --- |
| `Tab` 接口 | 删除 `keepAwake?: boolean`，注释指向租约表 |
| `keptAwake(tab)` / `keepAwakeLeaseId(tab)` | 新增；`keepAwake` 投影与菜单勾选都读它 |
| `describe()` | `keepAwake: keptAwake(tab)`（休眠/正常两条分支都改） |
| `setKeepAwake(tab, value)` | 标记 = `acquire({ leaseId: 'keep-awake-<tabId>', owner: 'user', preventsDiscard: true })`；取消 = `releaseOwner(tabId, 'user')` |
| `sweepDiscard()` | 先 `sweepExpired(now)`；守卫链里 `tab.keepAwake` → `blocksDiscard(tab.id, now)`；命中租约时重置 `backgroundSince` |
| `duplicateTab()` | 副本**自己新申请**一条 `user` 租约（继承语义不变，但不再共享字段） |
| `closeTab()` | `releaseTab(tab.id)`（关闭即清理，避免租约表随时间增长） |
| `window.on('closed')` | 对仍属于本窗口的标签 `releaseTab(tab.id)`；拖出中的标签已从 `tabs` 摘除，租约跟着 `tabId` 活到新窗口 |
| 标签右键菜单 | `label` / `checked` / `click` 改用 `keptAwake(tab)` |

**没有改的**：`detachTab()` / `adoptTab()` 不碰租约（跨窗口移动必须保留）；`BrowserState.keepAwake`
字段与渲染层标记（`App.vue` 的 `awake` 类与 `awake-mark`）保持原样。

## 3. 验证

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | ✅ |
| `npm run test:unit`（`node scripts/test.cjs unit`） | ✅ 13 文件 / **123 通过**（新增 `activity-lease.test.ts` 18 条） |
| `node scripts/test.cjs data` | ✅ 7 通过 |
| `node scripts/test.cjs smoke` | ✅ 21 文件 / **0 失败**（`tab-discard.test.cjs` 6/6，用时 39.8 s） |

单元层（确定性时钟）：

1. 无租约 → 可休眠；`user` 租约 → 阻止；
2. 释放后恢复休眠资格，重复释放幂等；
3. 多个租约任意一条 `preventsDiscard` 即阻止；只释放其中一条时另一条仍生效；
4. `expiresAt` 到点后立刻不再阻止；`sweepExpired()` 回收并幂等；无期限租约永不被回收；
5. 同一标签的过期租约不影响另一条有效租约；
6. 显式 `leaseId` 幂等续租（续租延长寿命、不叠加）；
7. `releaseOwner` / `releaseTab` 的作用域与「不影响其它标签」；
8. 租约只认 `tabId`（跨窗口/绑定的语义固化）；
9. 五类 owner 可登记，未知 owner 被拒；参数校验与 ID 冲突抛错；返回副本不可外部篡改。

smoke 层（真实 Electron、`BAO_DISCARD_TTL_MS=3000`、`BAO_DISCARD_SWEEP_MS=300`）：

| 用例 | 覆盖点 |
| --- | --- |
| 超时休眠 → 切回按原地址重建（原有） | 回归：租约表为空时不改变休眠行为 |
| `tab.discard=never` 不休眠（原有） | 回归：设置开关仍优先 |
| 标记保持活跃 → 不休眠；取消 → 恢复（原有） | `keepAwake` ↔ `user` 租约的往返映射 |
| **保持活跃只作用于该标签**（新增） | 同一窗口里 F 照常休眠、E 不被休眠：租约按 `tabId` 隔离，且不影响扫描器 |
| **拖出标签到新窗口后仍保留租约**（新增） | 租约跨窗口不丢；在新窗口取消标记后确实被休眠（正向对照说明扫描器在该窗口生效） |
| **关闭持有租约的标签后其余标签不受影响**（新增） | 关闭路径清理租约、快照不残留标记、普通后台标签仍可休眠 |

## 4. 未覆盖与遗留

1. **过期租约目前没有生产者**：`expiresAt` 的语义与回收有单测，但 M2 里唯一的生产者是无期限 `user` 租约；
   真实 `expiresAt` 要等下载/DevTools/会话恢复接入。
2. **`session-restore` / `download` / `devtools` / `system` 只有登记能力，没有生产者**：
   对应的产品功能（会话恢复、下载策略、DevTools 生命周期）当时尚未实现。
   故意不接线——没有消费者的租约只会变成「写了但测不到」的代码（架构 §18 A1 末段）。
   > 2026-11-24 补记：会话恢复已同日交付（[报告](2026-11-24-session-restore.md)），但恢复是同步构造
   > 标签、后台标签根本没有 WebContents，扫描器不会碰到它们，因此**仍然没有**接
   > `session-restore` 生产者；待恢复引入异步阶段后再接。
3. **smoke 只能观察投影**：租约表本身没有诊断通道（没有 IPC / 日志面），
   「关闭后无泄漏」在 smoke 里只能间接验证（单元测试用 `releaseTab` 直接断言表为空）。
   若后续要做休眠诊断面板，需要给租约表加只读投影（属 M3 诊断能力）。
4. **架构 §7 规则 6「生命周期事件先通知消费者，再使旧 binding 失效」未纳入本次**：
   本增量只有 discard/revive 的既有事件路径，没有把「事件订阅 → 旧 binding 失效」做成统一通道；
   那是 CDP Hub（A2）与 BrowsingContext 事件面的工作。
5. **`agent` / `workflow` / `capture` owner 未预留类型**：接入时新增枚举值 + 生产者 + 用例即可，
   不会影响现有协议与存储。
6. **未做**：`TabRegistry`、`WindowRegistry`、`BrowsingContextRegistry`、显式 actor/target 的 Capability API、
   `navigationId`。它们仍是 A1 的剩余项。

## 5. 代码位置

| 内容 | 位置 |
| --- | --- |
| 租约模块 | `app/src/main/activity-lease.ts` |
| 休眠判定与生命周期接入 | `app/src/main/browser-window.ts`（`keptAwake` / `setKeepAwake` / `sweepDiscard` / `duplicateTab` / `closeTab` / `window.on('closed')`） |
| 单元测试 | `app/tests/unit/activity-lease.test.ts` |
| 行为测试 | `app/tests/smoke/tab-discard.test.cjs` |
| 快照字段（未变） | `app/src/shared/browser.ts` 的 `BrowserTab.keepAwake` |
