/**
 * 外壳渲染线程心跳（纯逻辑，不 import electron，可在单测里覆盖）。
 *
 * 为什么需要它（2026-11-25 演示 §7.7-1）：共享进程把「工具栏」和「浮层」放进了同一个渲染进程
 * 主线程，任何一方跑同步长任务，另一方都得排队。而**被占住的主线程无法回答任何 IPC**——
 * 主进程发的 `reload()`/诊断请求都排在任务后面，所以「有没有卡」只能由主进程主动测。
 *
 * 判据来自实测（同一份 demo）：空闲 RTT ≈ 2 ms；浮层跑 400 ms 忙循环时，外壳一次
 * `run()` 往返 402 ms。也就是说 **RTT 直接等于被阻塞的时长**，不需要任何渲染端 API。
 *
 * 采样与统计都是确定性的：时钟注入、滑动窗口、不依赖 `Date.now()` 的隐式行为。
 */
export interface HeartbeatStats {
  /** 已完成的往返次数。 */
  count: number
  /** 最近一次往返（毫秒）。 */
  last: number
  p50: number
  p95: number
  p99: number
  max: number
  /** 超过阈值的次数（长任务事件）。 */
  stalls: number
  /** 超过阈值的那几个样本（最多保留 20 条，供诊断）。 */
  worst: number[]
}

export interface HeartbeatOptions {
  /** 时钟注入点（默认 `Date.now`）。 */
  now?: () => number
  /** 超过多少毫秒算一次「卡顿」。 */
  stallMs?: number
  /** 保留多少条样本用于分位数（默认 300 ≈ 30 s @100 ms）。 */
  window?: number
}

export class HeartbeatMonitor {
  private readonly now: () => number
  private readonly stallMs: number
  private readonly window: number
  private readonly samples: number[] = []
  private readonly worst: number[] = []
  private pendingSeq = 0
  private readonly sentAt = new Map<number, number>()
  private stalls = 0

  constructor(options: HeartbeatOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.stallMs = options.stallMs ?? 200
    this.window = options.window ?? 300
  }

  /** 发出一跳，返回序号；`onPong` 用它配对。 */
  tick(): number {
    const seq = ++this.pendingSeq
    this.sentAt.set(seq, this.now())
    // 只留最近 32 个在途序号：渲染线程被长时间占住时不能无限增长。
    if (this.sentAt.size > 32) {
      const oldest = this.sentAt.keys().next().value
      if (oldest !== undefined) this.sentAt.delete(oldest)
    }
    return seq
  }

  /** 收到回执；配对不上（未知序号）时返回 `undefined`。 */
  onPong(seq: number): number | undefined {
    const sent = this.sentAt.get(seq)
    if (sent === undefined) return undefined
    this.sentAt.delete(seq)
    const rtt = Math.max(0, this.now() - sent)
    this.samples.push(rtt)
    if (this.samples.length > this.window) this.samples.shift()
    if (rtt > this.stallMs) {
      this.stalls += 1
      this.worst.push(rtt)
      if (this.worst.length > 20) this.worst.shift()
    }
    return rtt
  }

  /** 当前统计（没有样本时分位数全为 0）。 */
  stats(): HeartbeatStats {
    const sorted = [...this.samples].sort((a, b) => a - b)
    const pick = (ratio: number): number => {
      if (sorted.length === 0) return 0
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]
    }
    return {
      count: this.samples.length,
      last: sorted.length === 0 ? 0 : this.samples[this.samples.length - 1],
      p50: pick(0.5),
      p95: pick(0.95),
      p99: pick(0.99),
      max: sorted.length === 0 ? 0 : sorted[sorted.length - 1],
      stalls: this.stalls,
      worst: [...this.worst]
    }
  }

  /** 清空样本与计数（测试用）。 */
  reset(): void {
    this.samples.length = 0
    this.worst.length = 0
    this.sentAt.clear()
    this.stalls = 0
  }
}
