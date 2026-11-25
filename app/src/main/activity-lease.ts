/**
 * 活动租约（Activity Lease）：后台标签休眠判定的唯一权威。
 *
 * 为什么不是一个布尔：`keepAwake` 只能表达「用户不想让它睡」。下载、会话恢复、
 * DevTools、系统维护以及 M3 的 Agent/Workflow 都需要按**各自的生命周期**临时阻止
 * 休眠，并在结束时释放。全局布尔拼不出这些层次——「谁在什么时候、因为什么原因
 * 让它别睡」必须能分开登记、分别释放、分别过期。
 *
 * 设计约束（[架构 §7](../../../docs/agent-automation-architecture.md#7-标签生命周期与活动租约)）：
 *
 * - 租约按**稳定 tabId** 归属，不按 `webContents.id`：跨窗口移动与绑定重建都不丢；
 * - 租约只是数据，不持有 Electron 对象，因此可以纯逻辑单测（本文件不 import electron）；
 * - 过期清理是确定性的：查询时即过滤过期租约，扫描周期还会显式回收，
 *   不依赖 owner 一定记得释放（owner 崩溃不能把标签永久锁活）；
 * - M2 只有 `user` 有真实生产者（右键「保持活跃」）。`download` / `session-restore` /
 *   `devtools` / `system` 目前只有登记能力，生产者在各自功能落地时接入；
 *   不为它们提前建空壳模块（架构 §18 A1、§17 重构边界）。
 */

/**
 * 租约持有者（架构 §7 的 owner 集合按 M2 收窄）。
 *
 * `agent` / `workflow` / `capture` / `audio` 不在本表：它们还没有真实生产者，
 * 提前放进类型只会让「支持」变成一句空话。接入时须同时新增枚举值、生产者、
 * holder 身份/定向清理及用例。
 */
export const ACTIVITY_LEASE_OWNERS = ['user', 'session-restore', 'download', 'devtools', 'system'] as const

export type ActivityLeaseOwner = (typeof ACTIVITY_LEASE_OWNERS)[number]

/** 一条已登记的活动租约。字段名沿用架构 §7 的 M2 子集合同。 */
export interface ActivityLease {
  /** 租约 ID。自动生成时形如 `lease-1`（确定性，便于测试与日志对照）。 */
  leaseId: string
  /** 稳定业务身份：跨窗口移动不变，所以租约天然跟随标签。 */
  tabId: number
  owner: ActivityLeaseOwner
  /** 为 false 时只登记「有人关心这个标签」，不阻止休眠（例如只做观察的消费者）。 */
  preventsDiscard: boolean
  /** 人类可读的原因，会出现在日志与后续诊断里。 */
  reason: string
  /** 到期时刻（毫秒时间戳）。不传表示无期限：一直有效到调用方或明确策略释放。 */
  expiresAt?: number
}

/** 申请租约的参数。`leaseId` 可显式给出，用来把「同一件事再申请一次」变成幂等续租。 */
export interface ActivityLeaseRequest {
  tabId: number
  owner: ActivityLeaseOwner
  reason: string
  /** 默认 true：申请租约通常就是为了阻止休眠。 */
  preventsDiscard?: boolean
  expiresAt?: number
  /** 显式租约 ID（例如 `` `keep-awake-${tabId}` ``）：已存在的同 ID 租约被续租而不是叠加。 */
  leaseId?: string
}

export interface ActivityLeaseManagerOptions {
  /** 时钟注入点：单测用它把过期判定变成确定性的。 */
  now?: () => number
}

function isExpired(lease: ActivityLease, at: number): boolean {
  return lease.expiresAt !== undefined && lease.expiresAt <= at
}

/**
 * 租约表。
 *
 * 主进程只有一个实例（见文件末尾的 `activityLeases`）：租约按全局 tabId 归属，
 * 而标签可以在窗口之间移动，多个窗口各持一份表就会在拖出标签时丢掉租约。
 */
export class ActivityLeaseManager {
  private readonly leases = new Map<string, ActivityLease>()
  private readonly clock: () => number
  /** 自动 ID 计数器：只用递增整数，避免随机数让测试和日志失去可比性。 */
  private sequence = 0

  constructor(options: ActivityLeaseManagerOptions = {}) {
    this.clock = options.now ?? (() => Date.now())
  }

  /** 已登记的租约条数（含尚未被清理的过期租约；判断「能不能休眠」请用 `blocksDiscard()`）。 */
  get size(): number {
    return this.leases.size
  }

  /**
   * 申请或续租。
   *
   * 显式传 `leaseId` 且已存在同一 tabId + owner 的租约时，按新参数**续租**
   * （刷新 `reason` / `preventsDiscard` / `expiresAt`），不会堆出第二条。
   * 参数非法一律抛错：这是主进程内部 API，静默容忍只会变成「租约悄悄没生效」。
   */
  acquire(request: ActivityLeaseRequest): ActivityLease {
    if (!request || typeof request !== 'object') throw new TypeError('租约申请必须是对象')
    const { tabId } = request
    if (!Number.isInteger(tabId) || tabId <= 0) throw new TypeError(`租约的 tabId 非法：${String(tabId)}`)
    if (!(ACTIVITY_LEASE_OWNERS as readonly string[]).includes(request.owner)) {
      throw new TypeError(`未知的租约 owner：${String(request.owner)}`)
    }
    const reason = typeof request.reason === 'string' ? request.reason.trim() : ''
    if (!reason) throw new TypeError('租约必须有非空的 reason')
    if (request.expiresAt !== undefined && !Number.isFinite(request.expiresAt)) {
      throw new TypeError(`租约的 expiresAt 非法：${String(request.expiresAt)}`)
    }
    if (request.leaseId !== undefined && (!request.leaseId || typeof request.leaseId !== 'string')) {
      throw new TypeError('租约的 leaseId 非法')
    }

    const leaseId = request.leaseId ?? `lease-${++this.sequence}`
    const existing = this.leases.get(leaseId)
    if (existing && (existing.tabId !== tabId || existing.owner !== request.owner)) {
      throw new TypeError(`租约 ID 已被占用：${leaseId}（tabId ${existing.tabId} / owner ${existing.owner}）`)
    }
    const lease: ActivityLease = {
      leaseId,
      tabId,
      owner: request.owner,
      // 只有显式传 false 才不阻止休眠：默认值偏向「保护标签」，误睡代价比多占内存更高。
      preventsDiscard: request.preventsDiscard !== false,
      reason,
      ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt })
    }
    this.leases.set(leaseId, lease)
    return { ...lease }
  }

  /** 释放一条租约；不存在的 ID 返回 false（重复释放是安全的幂等操作）。 */
  release(leaseId: string): boolean {
    return this.leases.delete(leaseId)
  }

  /** 明确策略操作：释放某个标签上某 owner 类别的全部租约，返回释放条数；不得用于单 holder 结束。 */
  releaseOwner(tabId: number, owner: ActivityLeaseOwner): number {
    let released = 0
    for (const [leaseId, lease] of this.leases) {
      if (lease.tabId !== tabId || lease.owner !== owner) continue
      this.leases.delete(leaseId)
      released += 1
    }
    return released
  }

  /** 标签关闭时清空它的全部租约（任何 owner），返回释放条数。 */
  releaseTab(tabId: number): number {
    let released = 0
    for (const [leaseId, lease] of this.leases) {
      if (lease.tabId !== tabId) continue
      this.leases.delete(leaseId)
      released += 1
    }
    return released
  }

  /** 确定性地回收已过期租约，返回回收条数。幂等：没有过期租约时返回 0。 */
  sweepExpired(at: number = this.clock()): number {
    let removed = 0
    for (const [leaseId, lease] of this.leases) {
      if (!isExpired(lease, at)) continue
      this.leases.delete(leaseId)
      removed += 1
    }
    return removed
  }

  /**
   * 该标签此刻是否被有效租约阻止休眠。
   *
   * 只要**任意一条**未过期且 `preventsDiscard` 的租约成立就返回 true（架构 §7 规则 4）：
   * 多个消费者之间不需要协商优先级，谁在都算「还在用」。
   */
  blocksDiscard(tabId: number, at: number = this.clock()): boolean {
    for (const lease of this.leases.values()) {
      if (lease.tabId !== tabId || !lease.preventsDiscard || isExpired(lease, at)) continue
      return true
    }
    return false
  }

  /** 该标签上是否有某 owner 的**有效**租约（用户「保持活跃」投影用它，不看过期租约）。 */
  hasOwner(tabId: number, owner: ActivityLeaseOwner, at: number = this.clock()): boolean {
    for (const lease of this.leases.values()) {
      if (lease.tabId !== tabId || lease.owner !== owner || isExpired(lease, at)) continue
      return true
    }
    return false
  }

  /** 某标签当前有效的租约（诊断与测试用；返回副本，外部改不到内部状态）。 */
  active(tabId: number, at: number = this.clock()): ActivityLease[] {
    const list: ActivityLease[] = []
    for (const lease of this.leases.values()) {
      if (lease.tabId !== tabId || isExpired(lease, at)) continue
      list.push({ ...lease })
    }
    return list
  }

  /** 清空整张表（进程退出或测试用）。 */
  clear(): void {
    this.leases.clear()
  }
}

/**
 * 主进程唯一的租约表。
 *
 * 为什么是模块级单例：租约按全局 `tabId` 归属，而标签会跨窗口移动（拖出标签）。
 * 表挂在某个窗口上，拖出后新窗口就看不到旧租约了——这正是本次增量要保证不丢的东西。
 */
export const activityLeases = new ActivityLeaseManager()
