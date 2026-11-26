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

## 5. 未做（A1-b 剩余）

1. **读取侧切换**：`live()`、引擎提交校验、会话快照、诊断投影仍读镜像字段；
2. **WindowRegistry / BrowsingContextRegistry** 还没独立成形（当前靠 `controllers` 与
   `tabs` 的宿主字段隐式表达）；
3. **`CapabilityWorld` 适配**（A1-c）：`capability-contract.ts` 需要 `tab()` 端口返回
   `bindingId`/`navigationId`/`loading`/`flashContent`，本步已经具备前两项的来源；
4. 生命周期事件目前**没有消费者**：这是刻意的（不为没有消费者的能力建空壳），
   A1-c 接线时第一个消费者是 Capability 服务与休眠扫描。
