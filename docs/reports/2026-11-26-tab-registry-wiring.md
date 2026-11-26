# M2 / A1-b（第一步）：标签身份与代际收口

2026-11-26 · 对应[架构 §6.1 TabRegistry](../agent-automation-architecture.md#61-tabregistry)、
[§7 规则 9–10](../agent-automation-architecture.md#7-标签生命周期与活动租约)。

## 1. 这一步到底改了什么

以前 `binding`（视图绑定代际）与 `navVersion`（主文档代际）散在 `browser-window.ts` 里
各自 `+= 1`：8 处推进、4 处初始化，没有一处知道「刚才发生过一次重建」。现在：

| 责任 | 以前 | 现在 |
| --- | --- | --- |
| 推进代际 | 各处直接 `+= 1` | 只能通过 `tabRegistry.bumpBinding()` / `bumpNavigation()` |
| 生命周期事件 | 没有 | 每次推进发一条（`tab-discarded` / `tab-revived` / `tab-rebuilt` / `engine-committed` / `tab-navigated` / `tab-migrated` / `tab-closed`） |
| 短引用校验 | 各调用点自己比数字 | `tabRegistry.resolve(tabId, { bindingId, navigationId })` 返回 `unknown-tab` / `binding-stale` / `navigation-stale` |
| 跨窗口移交 | 只改 `tab.host` | 同时 `migrate()`：身份与两个代际都不变 |

`tab.binding` / `tab.navVersion` **仍然是标签上的镜像字段**，但只有三个帮助函数能写它。
为什么不一次性删字段：这两个数字有十几处读取（事件守卫 `live()`、引擎切换提交校验、会话快照、
诊断投影），把「写入收口」和「读取侧重构」合成一次改动，回归面会覆盖全部 30 个 smoke 文件。
下一片再切读取侧。

## 2. 事件与提交的顺序是合同

架构 §7 规则 10 要求「先通知消费者，再使旧 binding 失效」。`TabRegistry` 的实现是：
**先派发事件，再 `set` 新代际**。所以监听器回调期间 `resolve(旧代际)` 仍然成功，返回后才失效——
这一条有专门用例（`先通知、后失效`）。

两阶段引擎切换用 `reserveBinding()` / `commitReserved()`：候选视图按「当前 + 1」绑定，
提交前它的所有事件都因 `binding-stale` 作废（这正是「准备阶段失败不影响旧视图」的实现方式）；
提交一个不是预留值的代际直接抛 `RangeError`。

## 3. 踩到的坑（值得记住）

接线后 `popup`、`ruffle-cors`、`tab-discard`、`session-restore` 四个文件挂了。现象是
「切到 Ruffle 后点链接不开窗」「页面按钮一直不可见」——看着像策略问题，其实是：

```ts
// 错的：commitReserved 成功时返回 true，这里却只在“失败”时同步镜像
if (!tabRegistry.commitReserved(tab.id, attempt.binding, 'engine-committed')) {
  tab.binding = attempt.binding
}
```

引擎切换提交后镜像停在旧代际 → 事件守卫 `live()` 恒为假（`tab.binding === binding` 永不成立）
→ 该标签的**所有**页面事件被静默忽略（点击不开窗、加载状态不更新），而不报任何错。

定位方式（值得复用）：先二分（把本次改动按组回退，确认是哪一组），再在可疑函数里写**临时文件日志**
（`appendFileSync`，因为冒烟不放行主进程 stderr）。日志一行就说明问题：
`create tab=1 win=1 at openInternalTab | at openNewTab` —— 登记本身正常，问题在提交侧。
根因只用一次 diff 复读就看见了：`!commit` 的判断方向写反。

教训：**「提交式 API 的返回值方向」是最容易写反、且只有端到端用例能发现的一类错误**
（单测覆盖的是账本，镜像同步在 `browser-window.ts` 里）。已在原位留注释，避免有人再"顺手优化"回来。

## 4. 验证

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run test:unit` | **280/280**（新增 `tab-registry` 21 条） |
| `npm run test:data` | 11/11 |
| 隐藏冒烟（全量，4 并发） | **30 个文件 0 失败**，97.3 s |
| 关键用例 | `engine-switch` 8/8、`tearoff` 8/8、`tab-discard` 11/11、`session-restore` 7/7、`popup` 2/2 |

## 5. 追加（同日）：读取侧切换，镜像字段删除

接线第一片保留了 `tab.binding` / `tab.navVersion` 作镜像。同一天做完第二片：**读取侧全部切到账本，
两个字段从 `Tab` 上删除**。

| 读取点 | 现在 |
| --- | --- |
| 事件守卫 `live()` | `bindingOf(tab) === binding` |
| 引擎切换提交校验 | `navigationOf(tab) === navVersion`（准备时取的快照值） |
| 会话快照 / 诊断投影 | `bindingOf(tab)` |
| 候选视图 | `tabRegistry.reserveBinding(tab.id)` |

配套两个防御：

1. `bindingOf()` 对「不在账本里的标签」返回 **0**：任何捕获到的代际都不会等于 0，
   于是已关闭标签的视图事件自然全部作废，不需要额外的「已关闭」标记；
2. `bind()` 里先 `ensureRegistered(tab)` 再读代际。**不能**写成参数默认值
   `binding = bindingOf(tab)`——默认值在登记之前求值（未登记 → 0），之后 `live()` 永远为假，
   又是一次静默丢事件。这条已写进函数注释。

验证：typecheck 通过、unit 280/280、全量隐藏冒烟 **30 个文件 0 失败**（98.7 s）；
`browser-window.ts` 3162 行（接线前 3151、纯化前 3165——两次改动都在同一个量级，
真正删掉的是 2 个字段和 13 处分散写入）。

## 6. 未做（归到 A1-c）

1. **WindowRegistry / BrowsingContextRegistry 没有独立成形**。原因不是没时间，而是**没有消费者**：
   窗口归属已由 `TabRegistry.windowId` 表达，窗口生命周期目前只有控制器自己在用；
   弹窗上下文的稳定身份要等能力服务开始解析 target 时才有意义。按 §18-A1「不为没有消费者的
   能力提前建空壳」的口径，这一步留在 A1-c 与第一个消费者一起做。
2. **生命周期事件还没有消费者**：同上，A1-c 的第一个消费者是能力服务与休眠扫描。
3. **`CapabilityWorld` 适配**（A1-c）：代际、加载态、Flash 判定、租约四个来源现在都齐了。
