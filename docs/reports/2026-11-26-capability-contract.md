# M2 / A1-a：Capability 合同与纯校验层

2026-11-26 · 对应[架构 §18-A1](../agent-automation-architecture.md#a1浏览器能力底座m2-当前工作)、
[§5 统一浏览器能力接口](../agent-automation-architecture.md#5-统一浏览器能力接口)、
[§6.4 TargetRegistry](../agent-automation-architecture.md#64-targetregistry)、
[§6.5 指代的产出者](../agent-automation-architecture.md#65-指代的产出者2026-11-26-裁决)、
[ADR-0004](../adr/0004-liveness-over-memory-reclaim.md)。

A1 拆成串行五步（见 [m2-beta §2](../kickoff/m2-beta.md#2-agent-ready-浏览器底座a1)）后的第一步：
**只立合同与纯校验层，不接线、不改任何运行行为**。

## 1. 为什么要先做这一步

A1 的退出条件里有两条是"事后补不上"的：

- 「UI 已通过统一 Capability API 调用关键标签动作」——一旦 UI 与业务各自接线，再统一就是重写；
- 「提供一个不依赖 UI、Workflow Runtime、CDP Hub 或 Page Map 的 Capability contract/integration
  harness，直接覆盖 actor、显式 target、binding/navigation 拒绝、租约和稳定错误码」——
  harness 只有对着**已冻结的合同**才写得出来。

先做纯层还有工程上的理由：本项目已经验证过三次「纯模块 + 单测先行」的路子（`activity-lease`、
`crossdomain-rules`、`heartbeat`）。合同层不 import electron，因此代际拒绝、租约门禁这类
「穷举比调试便宜」的判断可以在毫秒级用例里跑完，不必启动 Electron。

## 2. 交付物

| 文件 | 内容 | 行数 |
| --- | --- | --- |
| `app/src/shared/capability.ts` | 合同：`ActorKind` / `TargetProducer` / `ActionContext` / `BrowserTarget` / `TargetRef` / `ShellRef` / `CapabilityAction` / 21 个稳定失败码与文案 / 调用记录类型 / 判别辅助 | 约 300 |
| `app/src/main/capability-contract.ts` | 纯校验器：`validateCapabilityCall`、`validateTargetRef`、`validateShellRef`、`CapabilityCallLog`（环形缓冲 500 条） | 约 390 |
| `app/tests/unit/capability-contract.test.ts` | 合同 harness：58 条 | 约 480 |

`app/scripts/test-map.cjs` 增加映射：改这两个模块跑 `tab-ops` + `tab-discard`（接线后会落在
`browser-window.ts`，那张已是全量）。

## 3. 关键决定与理由

### 3.1 不猜当前活动标签

`tab.*` 动作缺 `target` 一律 `target-required`。这不是严格癖：Agent 与工作流没有「当前标签」
这个概念，而 UI 侧把它翻译成显式 `tabId` 只需一行适配（架构 §5 规则 2）。允许隐式活动标签，
等于把「用户切了一下标签」变成一次静默的越权执行。

### 3.2 两个动作的操作者被收窄

| 动作 | 允许的操作者 | 理由 |
| --- | --- | --- |
| `tab.tearoff` | 仅 `human-ui` | 它是指针手势的产物（屏幕坐标来自拖动）。自动化要「新窗口」应走窗口能力，不是模拟拖出 |
| `tab.discard` | `agent` / `workflow` / `system` | 无人值守的内存回收语义（§7 规则 12）。人想表达同一意图时的动作是「关闭」或「保持活跃」，把它们塞进 discard 会让人看不出发生了什么 |

其余动作四类操作者共用**同一条**执行路径（§5 规则 6：避免三套实现漂移）。

### 3.3 ADR-0004 的硬门禁挪到 API 边界

`tab.discard` 在校验层就检查四条，顺序即优先级（游戏连续性 > 内存回收）：

```
reason-required → flash-content → tab-loading → lease-blocks-discard
```

也就是说：休眠扫描里的那套门禁（`a5e5d5a`、`1337064`）现在有**第二个**执行点。这不是重复——
自动扫描是「没人问就自己决定」，Capability 是「有人明确要求丢弃」。两者判据必须一致，
否则 Agent 可以绕过扫描器直接要求丢掉一个正在跑 Flash 的标签。A1-c 接线时**不得**在服务层
再写一套判定。

### 3.4 缺端口按失效处理（fail-closed）

页面短引用的观察/frame/surface/capture 端口在 M2 没有生产者。校验器对**缺失的端口**返回失效
（`observation-stale` 等），而不是「没有证据就当有效」。后果是：现在页面短引用在 M2 一律被拒。
这是诚实的结果——A2/A3 接入时端口自然就有了。

### 3.5 调用记录只记身份，不记载荷

`CapabilityCallRecord` 只有：谁（actor/profile/task/session）、对什么（target 身份）、
什么动作、成不成、为什么不成、多久。**不记地址、不记文本、不记 CDP 参数**——
与 §8 对 CDP Hub「只记指标，不记参数和响应」的口径一致。用例断言了「导航地址不出现在记录里」。

`actor` / `profileId` 是可选字段：上下文本身非法时（`invalid-context`），审计只知道发生过一次
非法调用，**不编造**一个看起来合法的操作者。

### 3.6 不写执行器

没有消费者的执行器只会变成「写了但测不到」的代码（§18-A1 末段、§17 重构边界）。因此本步
没有任何 Electron 依赖，运行时也没有任何导入方——对现有行为零影响，这是刻意的。

## 4. harness 覆盖面

58 条，按四个必测面 + 两项合同质量分组：

| 组 | 条数 | 关键断言 |
| --- | --- | --- |
| 结构与操作者 | 6 | 未知动作、非法 actor、空 profile、调用不是对象时不抛异常、`tab.list` 不接受 target |
| 显式 target | 8 | 缺 target 被拒、三种目标类型互不冒充、`tabId` 非法（0/小数/字符串）、未知标签、返回解析后的 `tabId` |
| 代际拒绝 | 5 | binding / navigation 各自失效、同时失效时报 binding（旧绑定下 navigation 无意义）、非法声明、相符放行 |
| 动作策略 | 4 | 拖出与丢弃的操收窄、人类激活正常 |
| ADR-0004 门禁 | 6 | 四条理由各自被拒、三条同时成立时报 flash、全清放行 |
| 页面短引用 | 14 | dom/surface/visual 全路径、观察端口缺失即失效、帧/surface/capture/transform 失效 |
| 外壳元素引用 | 6 | 元素表、空 elementId、`surfaceId` 冒充、产出者非法、动作路径一致 |
| 稳定错误码 | 3 | 码表快照、文案非空且互异、**每个码都被真的走通一次** |
| 调用记录 | 7 | ok/denied、不记载荷、ID 递增、上下文非法时不编造、环形缓冲、返回副本 |

其中「每个码都被真的走通一次」是刻意设计：新增失败码而不写用例，会直接让这条断言变红。

## 5. 变异验证（用例确实有牙）

把七处门禁同时改成恒假（binding ×2、navigation ×2、flash、loading、lease），重跑：

```
Tests  10 failed | 48 passed (58)
```

失败分布正好覆盖代际 4 条、ADR-0004 门禁 4 条、码覆盖 1 条、以及一条组合用例；恢复文件后
58/58 全过。

## 6. 未做与边界

1. **未接线**：`browser-window.ts`、`App.vue`、preload 均未改动，现有行为零变化；
2. **页面短引用在 M2 一律被拒**：观察/frame/surface 端口属 A2/A3；
3. **`shell.invoke` 没有执行器**：外壳元素表（`elementId` → Browser/Shell 命令）随指认 UI 落地；
4. **没有整合 harness**：本步的 harness 是合同层；真实 Electron 里的接线验证在 A1-c 补；
5. **`audio` 租约 owner 仍未接入**，与 §18-A1 的阶段策略一致。

## 7. 下一步（A1-b）

提取 Tab / Window / BrowsingContext 注册表，**只提取 Capability 需要的部分**（目标解析 +
生命周期事件），不做目录式重写；判据是现有 smoke 全绿、行为零变化、`browser-window.ts` 净减行。

## 8. 验证

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run test:unit` | **225/225**（新增 58） |
| `npm run test:data` | 11/11 |
| 隐藏冒烟（全量，4 并发） | **30 个文件 0 失败**，98.8 s |

首轮全量并行里 `tab-discard` 有一条因并发加载失败超时（页面停在「标题=URL、loading=false」），
单独跑 11/11、复跑全量 0 失败；已按[冒烟 flake §9](2026-11-25-smoke-flake.md#9-修正节2026-11-26-追加openpage-的标题等待会吃掉-30-s)登记，
不是产品回归。
