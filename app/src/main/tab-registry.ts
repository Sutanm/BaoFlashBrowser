/**
 * 标签身份与代际（TabRegistry）——纯账本，不持有 Electron 对象。
 *
 * 为什么需要它：`browser-window.ts` 里每个标签有两个数字在跑——`binding`（视图绑定代际）
 * 与 `navVersion`（主文档代际）。它们今天散在四处各自 `+= 1`，谁都能改，改完也没人知道
 * 「刚才发生过一次重建」。代价是真实存在的：引擎切换提交时要靠比对 `navVersion` 才发现
 * 用户中途导航过（2026-11-26 审计复现的那一类问题），而休眠/唤醒、拖出移交、崩溃重建
 * 之后旧引用该不该失效，全靠读代码推断。
 *
 * 这个模块把两件事收口：**代际只能从这里推进**，且**每次推进都产生一条生命周期事件**
 * （架构 §7 规则 9）。事件与提交的顺序也是合同的一部分——规则 10 要求「先通知消费者，
 * 再使旧 binding 失效」，所以监听器里仍然能解析旧代际，返回后它才失效。
 *
 * 边界（与架构 §6.1 一致）：只管**稳定身份与代际**。窗口布局、标签顺序、活动标签、
 * WebContents、`BrowserState` 投影都不在这里——那些依赖原生对象或界面语义。
 * 因此本文件不 import electron，可以用毫秒级用例把边界穷举掉。
 *
 * 为什么是模块级单例（同 `activity-lease`）：标签能跨窗口移动，而代际必须跟着**标签**走。
 * 每个窗口各持一份账本，拖出标签后新窗口就会以为它是全新标签（binding 从 1 开始），
 * 旧引用会诡异地重新变"有效"。
 */

/** 标签稳定身份 + 代际。`tabId` 跨窗口移动不变，两个代际会变。 */
export interface TabIdentitySnapshot {
  tabId: number
  /** 当前归属窗口。移交后变化，但身份与代际的**语义**不变。 */
  windowId: number
  /** WebContents 绑定代际：休眠、唤醒、引擎切换、崩溃重建后 +1。 */
  bindingId: number
  /** 同一绑定内的主文档导航代际：普通导航、重定向、同文档历史更新后 +1。 */
  navigationId: number
}

/**
 * 生命周期事件类型（架构 §7 规则 9）。
 *
 * 只列**真的会发生**的转换：没有 `tab-pinned`、`tab-muted` 这类与代际无关的状态变化——
 * 它们不需要失效任何引用，塞进来只会让「什么时候该丢引用」变模糊。
 */
export type TabLifecycleKind =
  | 'tab-created'
  | 'tab-closed'
  | 'tab-discarded'
  | 'tab-revived'
  | 'tab-rebuilt'
  | 'tab-migrated'
  | 'engine-committed'
  | 'tab-navigated'

export interface TabLifecycleEvent {
  kind: TabLifecycleKind
  tabId: number
  /** 变化前；`tab-created` 没有。 */
  from?: TabIdentitySnapshot
  /** 变化后；`tab-closed` 没有。 */
  to?: TabIdentitySnapshot
}

export type TabResolveFailure = 'unknown-tab' | 'binding-stale' | 'navigation-stale'

export type TabResolveResult =
  | { ok: true; snapshot: TabIdentitySnapshot }
  | { ok: false; reason: TabResolveFailure; snapshot?: TabIdentitySnapshot }

export interface TabCreateOptions {
  tabId: number
  windowId: number
  /** 恢复会话时可以给初始代际（后台标签以休眠态恢复时视图尚未建，代际从 1 起也自然）。 */
  bindingId?: number
  navigationId?: number
}

type Listener = (event: TabLifecycleEvent) => void

export class TabRegistry {
  private readonly tabs = new Map<number, TabIdentitySnapshot>()
  private readonly listeners = new Set<Listener>()
  /** 通知深度：监听器里再触发变更时，事件排队而不是递归派发。 */
  private depth = 0
  private readonly queued: TabLifecycleEvent[] = []

  get size(): number {
    return this.tabs.size
  }

  /** 登记新标签。重复 `tabId` 直接抛错：那是调用方的 bug，静默覆盖会让旧引用复活。 */
  create(options: TabCreateOptions): TabIdentitySnapshot {
    const { tabId, windowId } = options
    if (!Number.isInteger(tabId) || tabId <= 0) throw new TypeError(`tabId 非法：${String(tabId)}`)
    if (!Number.isInteger(windowId) || windowId <= 0) throw new TypeError(`windowId 非法：${String(windowId)}`)
    if (this.tabs.has(tabId)) throw new TypeError(`tabId 已被登记：${tabId}`)
    const snapshot: TabIdentitySnapshot = {
      tabId,
      windowId,
      bindingId: options.bindingId ?? 1,
      navigationId: options.navigationId ?? 0
    }
    this.tabs.set(tabId, snapshot)
    this.emit({ kind: 'tab-created', tabId, to: { ...snapshot } })
    return { ...snapshot }
  }

  /** 关闭标签：先通知，再删除（通知期间 `resolve()` 仍然成功，见文件头）。 */
  close(tabId: number): boolean {
    const current = this.tabs.get(tabId)
    if (!current) return false
    this.emit({ kind: 'tab-closed', tabId, from: { ...current } })
    this.tabs.delete(tabId)
    return true
  }

  snapshot(tabId: number): TabIdentitySnapshot | undefined {
    const current = this.tabs.get(tabId)
    return current ? { ...current } : undefined
  }

  /** 某窗口当前登记的标签（顺序不保证：布局归控制器）。 */
  list(windowId?: number): TabIdentitySnapshot[] {
    const all = [...this.tabs.values()]
    return (windowId === undefined ? all : all.filter((entry) => entry.windowId === windowId)).map((entry) => ({
      ...entry
    }))
  }

  /** 消费短引用前的统一判定（架构 §6.4：所有短引用都必须过同一道校验）。 */
  resolve(tabId: number, expected: { bindingId?: number; navigationId?: number } = {}): TabResolveResult {
    const current = this.tabs.get(tabId)
    if (!current) return { ok: false, reason: 'unknown-tab' }
    // 先报绑定：旧绑定下的 navigationId 没有可比性（报错也要报对原因）。
    if (expected.bindingId !== undefined && expected.bindingId !== current.bindingId) {
      return { ok: false, reason: 'binding-stale', snapshot: { ...current } }
    }
    if (expected.navigationId !== undefined && expected.navigationId !== current.navigationId) {
      return { ok: false, reason: 'navigation-stale', snapshot: { ...current } }
    }
    return { ok: true, snapshot: { ...current } }
  }

  /**
   * 推进绑定代际（休眠、唤醒、崩溃重建、引擎切换提交）。
   *
   * @returns 新代际；标签不存在时返回 `undefined`（调用方通常在看一个已关闭的标签）。
   */
  bumpBinding(tabId: number, kind: TabLifecycleKind): number | undefined {
    const current = this.tabs.get(tabId)
    if (!current) return undefined
    const next: TabIdentitySnapshot = { ...current, bindingId: current.bindingId + 1 }
    this.emit({ kind, tabId, from: { ...current }, to: { ...next } })
    // 通知之后才提交：监听器在回调期间仍能解析旧代际（架构 §7 规则 10）。
    this.tabs.set(tabId, next)
    return next.bindingId
  }

  /**
   * 预留下一个绑定代际，但**不提交**（两阶段引擎切换的候选视图用）。
   *
   * 候选视图按这个代际绑定，因此在提交前它的所有事件都因 `resolve()` 报
   * `binding-stale` 而作废——这正是「准备阶段失败不影响旧视图」的实现方式。
   */
  reserveBinding(tabId: number): number | undefined {
    const current = this.tabs.get(tabId)
    return current ? current.bindingId + 1 : undefined
  }

  /** 提交预留的代际。必须正好等于「当前 + 1」，否则抛错（漏提交或多提交都是 bug）。 */
  commitReserved(tabId: number, bindingId: number, kind: TabLifecycleKind): boolean {
    const current = this.tabs.get(tabId)
    if (!current) return false
    if (bindingId !== current.bindingId + 1) {
      throw new RangeError(`提交的绑定代际不是预留值：${bindingId} ≠ ${current.bindingId + 1}`)
    }
    const next: TabIdentitySnapshot = { ...current, bindingId }
    this.emit({ kind, tabId, from: { ...current }, to: { ...next } })
    this.tabs.set(tabId, next)
    return true
  }

  /** 推进导航代际。绑定不变——只有主文档换了，视图还是同一个。 */
  bumpNavigation(tabId: number): number | undefined {
    const current = this.tabs.get(tabId)
    if (!current) return undefined
    const next: TabIdentitySnapshot = { ...current, navigationId: current.navigationId + 1 }
    this.emit({ kind: 'tab-navigated', tabId, from: { ...current }, to: { ...next } })
    this.tabs.set(tabId, next)
    return next.navigationId
  }

  /** 跨窗口移交：换 `windowId`，身份与两个代际都不变（拖出标签不能重建页面）。 */
  migrate(tabId: number, windowId: number): boolean {
    const current = this.tabs.get(tabId)
    if (!current) return false
    if (current.windowId === windowId) return false
    if (!Number.isInteger(windowId) || windowId <= 0) throw new TypeError(`windowId 非法：${String(windowId)}`)
    const next: TabIdentitySnapshot = { ...current, windowId }
    this.emit({ kind: 'tab-migrated', tabId, from: { ...current }, to: { ...next } })
    this.tabs.set(tabId, next)
    return true
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 清空（窗口全关 / 测试用）。不发事件：这是「没有消费者了」，不是一次生命周期转换。 */
  clear(): void {
    this.tabs.clear()
    this.queued.length = 0
    this.depth = 0
  }

  private emit(event: TabLifecycleEvent): void {
    this.queued.push(event)
    // 监听器里再改账本时，事件排到队尾而不是递归派发：派发顺序永远等于提交顺序。
    if (this.depth > 0) return
    this.depth += 1
    try {
      while (this.queued.length > 0) {
        const next = this.queued.shift()
        if (!next) break
        for (const listener of [...this.listeners]) listener(next)
      }
    } finally {
      this.depth -= 1
    }
  }
}

/**
 * 主进程唯一的标签账本。
 *
 * 同上：标签会跨窗口移动，代际必须跟着标签走。窗口各持一份会让拖出后的标签「返老还童」。
 */
export const tabRegistry = new TabRegistry()
