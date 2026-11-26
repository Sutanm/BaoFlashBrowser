import { describe, expect, it } from 'vitest'
import { HeartbeatMonitor } from '../../src/main/heartbeat'

/**
 * 心跳统计（2026-11-25 演示 §7.7-1 的观测手段）。
 *
 * 这部分逻辑必须确定性：时钟注入，不依赖真实时间。
 */
function monitorAt(clock: { now: number }, stallMs = 200) {
  return new HeartbeatMonitor({ now: () => clock.now, stallMs, window: 100 })
}

describe('HeartbeatMonitor', () => {
  it('往返时间 = 回执时刻 - 发出时刻', () => {
    const clock = { now: 1_000 }
    const monitor = monitorAt(clock)
    const seq = monitor.tick()
    clock.now += 42
    expect(monitor.onPong(seq)).toBe(42)
    expect(monitor.stats()).toMatchObject({ count: 1, last: 42, p50: 42, p95: 42, p99: 42, max: 42, stalls: 0 })
  })

  it('未知序号（重复回执 / 伪造回执）返回 undefined，不污染统计', () => {
    const clock = { now: 0 }
    const monitor = monitorAt(clock)
    expect(monitor.onPong(999)).toBeUndefined()
    expect(monitor.stats().count).toBe(0)
    const seq = monitor.tick()
    clock.now += 5
    expect(monitor.onPong(seq)).toBe(5)
    expect(monitor.onPong(seq)).toBeUndefined()
    expect(monitor.stats().count).toBe(1)
  })

  it('分位数与最大值', () => {
    const clock = { now: 0 }
    const monitor = monitorAt(clock)
    for (const rtt of [1, 2, 3, 4, 5, 6, 7, 8, 9, 100]) {
      const seq = monitor.tick()
      clock.now += rtt
      monitor.onPong(seq)
    }
    const stats = monitor.stats()
    expect(stats.max).toBe(100)
    expect(stats.p50).toBeGreaterThanOrEqual(5)
    expect(stats.p50).toBeLessThanOrEqual(6)
    expect(stats.p99).toBe(100)
  })

  it('超过阈值的记为卡顿，并保留最差样本（上限 20）', () => {
    const clock = { now: 0 }
    const monitor = monitorAt(clock, 200)
    for (let index = 0; index < 30; index += 1) {
      const seq = monitor.tick()
      clock.now += 250
      monitor.onPong(seq)
    }
    const stats = monitor.stats()
    expect(stats.stalls).toBe(30)
    expect(stats.worst.length).toBe(20)
    expect(stats.worst.every((value) => value >= 200)).toBe(true)
  })

  it('在途序号不会无限增长（渲染线程长期被占住时）', () => {
    const clock = { now: 0 }
    const monitor = monitorAt(clock)
    for (let index = 0; index < 200; index += 1) {
      monitor.tick()
      clock.now += 1
    }
    // 只有最近 32 个还在途；更早的回执视为孤儿。
    expect(monitor.onPong(1)).toBeUndefined()
    expect(monitor.onPong(200)).toBeGreaterThanOrEqual(0)
  })

  it('reset 清空样本与计数', () => {
    const clock = { now: 0 }
    const monitor = monitorAt(clock)
    const seq = monitor.tick()
    clock.now += 10
    monitor.onPong(seq)
    monitor.reset()
    expect(monitor.stats()).toMatchObject({ count: 0, last: 0, max: 0, stalls: 0, worst: [] })
  })

  /**
   * 冷启动（2026-11-26）：首帧之前的往返测的是「新渲染进程还在起来 + 文档还在解析」，
   * 不是线程被占住——真实把启动报成卡顿的那次 331 ms 就属于这一类。
   */
  it('冷启动期：往返只记 boot，不进样本、不算卡顿', () => {
    const clock = { now: 0 }
    const monitor = new HeartbeatMonitor({ now: () => clock.now, stallMs: 200, warmup: true })
    expect(monitor.stats()).toMatchObject({ ready: false, boot: 0, count: 0, stalls: 0 })

    const bootSeq = monitor.tick()
    clock.now += 331
    expect(monitor.onPong(bootSeq)).toBe(331)
    expect(monitor.stats()).toMatchObject({ ready: false, boot: 331, count: 0, stalls: 0, worst: [] })

    // 首帧之后：同样的 331 ms 才是真的卡顿。
    expect(monitor.markReady()).toBe(331)
    const seq = monitor.tick()
    clock.now += 331
    monitor.onPong(seq)
    expect(monitor.stats()).toMatchObject({ ready: true, boot: 331, count: 1, stalls: 1 })
    // 重复就绪（外壳崩溃自愈重载后又报一次）无害，也不再把 boot 报一遍。
    expect(monitor.markReady()).toBe(0)
  })

  it('不带 warmup 时立刻统计（纯逻辑调用方的默认行为）', () => {
    const clock = { now: 0 }
    const monitor = monitorAt(clock)
    expect(monitor.stats()).toMatchObject({ ready: true, boot: 0 })
    expect(monitor.markReady()).toBe(0)
  })

  it('reset 清样本但保留 cold-start 事实（boot / ready）', () => {
    const clock = { now: 0 }
    const monitor = new HeartbeatMonitor({ now: () => clock.now, stallMs: 200, warmup: true })
    const bootSeq = monitor.tick()
    clock.now += 250
    monitor.onPong(bootSeq)
    monitor.markReady()
    const seq = monitor.tick()
    clock.now += 250
    monitor.onPong(seq)
    expect(monitor.stats()).toMatchObject({ count: 1, stalls: 1, boot: 250, ready: true })
    monitor.reset()
    expect(monitor.stats()).toMatchObject({ count: 0, stalls: 0, boot: 250, ready: true })
  })
})
