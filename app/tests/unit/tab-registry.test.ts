import { describe, expect, it } from 'vitest'
import { TabRegistry } from '../../src/main/tab-registry'
import type { TabLifecycleEvent } from '../../src/main/tab-registry'

/**
 * 标签身份与代际（架构 §6.1 / §7 规则 9–10）。
 *
 * 这里钉住三件最容易写错的事：
 * 1. **代际只能单调推进**，且每次推进都有且只有一条事件；
 * 2. **先通知、后失效**（规则 10）——监听器里解析旧代际必须成功，回调返回后才作废；
 * 3. **跨窗口移交不改变身份与代际**（拖出标签不是重建页面）。
 *
 * 行为层（真实休眠、唤醒、引擎切换、拖出）在 smoke 里：`tab-discard` / `tearoff` / `engine-switch`。
 */

function collect(registry: TabRegistry): TabLifecycleEvent[] {
  const events: TabLifecycleEvent[] = []
  registry.subscribe((event) => events.push(event))
  return events
}

describe('登记与解析', () => {
  it('新标签的初始代际是 binding=1 / navigation=0', () => {
    const registry = new TabRegistry()
    expect(registry.create({ tabId: 1, windowId: 10 })).toEqual({
      tabId: 1,
      windowId: 10,
      bindingId: 1,
      navigationId: 0
    })
  })

  it('重复登记同一个 tabId 直接抛错（静默覆盖会让旧引用复活）', () => {
    const registry = new TabRegistry()
    registry.create({ tabId: 1, windowId: 10 })
    expect(() => registry.create({ tabId: 1, windowId: 11 })).toThrow(TypeError)
  })

  it('非法 tabId / windowId 抛错', () => {
    const registry = new TabRegistry()
    expect(() => registry.create({ tabId: 0, windowId: 10 })).toThrow(TypeError)
    expect(() => registry.create({ tabId: 1, windowId: 0 })).toThrow(TypeError)
  })

  it('按窗口列出标签，代际不变', () => {
    const registry = new TabRegistry()
    registry.create({ tabId: 1, windowId: 10 })
    registry.create({ tabId: 2, windowId: 10 })
    registry.create({ tabId: 3, windowId: 20 })
    expect(registry.list(10).map((entry) => entry.tabId)).toEqual([1, 2])
    expect(registry.list(20).map((entry) => entry.tabId)).toEqual([3])
    expect(registry.list().length).toBe(3)
  })

  it('resolve：代际相符才放行，未关闭的标签都解析得到快照', () => {
    const registry = new TabRegistry()
    registry.create({ tabId: 1, windowId: 10 })
    expect(registry.resolve(1)).toEqual({
      ok: true,
      snapshot: { tabId: 1, windowId: 10, bindingId: 1, navigationId: 0 }
    })
  })

  it('resolve：标签不存在 → unknown-tab', () => {
    expect(new TabRegistry().resolve(9)).toEqual({ ok: false, reason: 'unknown-tab' })
  })

  it('resolve：先报 binding 再报 navigation（旧绑定下的导航代际没有可比性）', () => {
    const registry = new TabRegistry()
    registry.create({ tabId: 1, windowId: 10 })
    registry.bumpBinding(1, 'tab-discarded')
    registry.bumpNavigation(1)
    expect(registry.resolve(1, { bindingId: 1, navigationId: 0 })).toMatchObject({
      ok: false,
      reason: 'binding-stale'
    })
    // 绑定对上、导航不对 → navigation-stale
    expect(registry.resolve(1, { bindingId: 2, navigationId: 0 })).toMatchObject({
      ok: false,
      reason: 'navigation-stale'
    })
  })
})

describe('绑定代际：休眠 / 唤醒 / 重建 / 引擎切换', () => {
  it('推进绑定代际并产生一条事件，事件带前后快照', () => {
    const registry = new TabRegistry()
    registry.create({ tabId: 1, windowId: 10 })
    const events = collect(registry)
    expect(registry.bumpBinding(1, 'tab-discarded')).toBe(2)
    expect(events).toEqual([
      {
        kind: 'tab-discarded',
        tabId: 1,
        from: { tabId: 1, windowId: 10, bindingId: 1, navigationId: 0 },
        to: { tabId: 1, windowId: 10, bindingId: 2, navigationId: 0 }
      }
    ])
  })

  it('先通知、后失效：监听器里旧代际仍然可解析，回调返回后作废（规则 10）', () => {
    const registry = new TabRegistry()
    registry.create({ tabId: 1, windowId: 10 })
    const seen: boolean[] = []
    registry.subscribe(() => {
      // 旧代际（1）在通知期间仍是"当前代际"
      seen.push(registry.resolve(1, { bindingId: 1 }).ok)
    })
    registry.bumpBinding(1, 'tab-revived')
    // 回调返回后才失效
    seen.push(registry.resolve(1, { bindingId: 1 }).ok)
    expect(seen).toEqual([true, false])
  })

  it('预留代际不提交：预留期间旧代际仍然有效（候选视图的准备阶段）', () => {
    const registry = new TabRegistry()
    registry.create({ tabId: 1, windowId: 10 })
    const events = collect(registry)
    expect(registry.reserveBinding(1)).toBe(2)
    expect(registry.snapshot(1)?.bindingId).toBe(1)
    expect(registry.resolve(1, { bindingId: 1 }).ok).toBe(true)
    expect(events).toEqual([])
  })

  it('提交预留代际后旧视图的事件全部作废', () => {
    const registry = new TabRegistry()
    registry.create({ tabId: 1, windowId: 10 })
    const reserved = registry.reserveBinding(1)!
    expect(registry.commitReserved(1, reserved, 'engine-committed')).toBe(true)
    expect(registry.snapshot(1)?.bindingId).toBe(2)
    expect(registry.resolve(1, { bindingId: 1 })).toMatchObject({ ok: false, reason: 'binding-stale' })
  })

  it('提交一个不是预留值的代际 → 抛错（漏提交或多提交都是 bug）', () => {
    const registry = new TabRegistry()
    registry.create({ tabId: 1, windowId: 10 })
    expect(() => registry.commitReserved(1, 5, 'engine-committed')).toThrow(RangeError)
  })

  it('对已关闭的标签推进代际返回 undefined，不产生事件', () => {
    const registry = new TabRegistry()
    const events = collect(registry)
    expect(registry.bumpBinding(7, 'tab-revived')).toBeUndefined()
    expect(registry.reserveBinding(7)).toBeUndefined()
    expect(registry.commitReserved(7, 2, 'tab-revived')).toBe(false)
    expect(events).toEqual([])
  })
})

describe('导航代际', () => {
  it('只推进 navigation，binding 不变', () => {
    const registry = new TabRegistry()
    registry.create({ tabId: 1, windowId: 10 })
    expect(registry.bumpNavigation(1)).toBe(1)
    expect(registry.snapshot(1)).toMatchObject({ bindingId: 1, navigationId: 1 })
  })

  it('产生一条 tab-navigated 事件', () => {
    const registry = new TabRegistry()
    registry.create({ tabId: 1, windowId: 10 })
    const events = collect(registry)
    registry.bumpNavigation(1)
    expect(events.map((event) => event.kind)).toEqual(['tab-navigated'])
  })
})

describe('关闭与跨窗口移交', () => {
  it('关闭：先通知（通知期间仍可解析），再移除', () => {
    const registry = new TabRegistry()
    registry.create({ tabId: 1, windowId: 10 })
    const inCallback: boolean[] = []
    registry.subscribe((event) => {
      if (event.kind === 'tab-closed') inCallback.push(registry.resolve(1).ok)
    })
    expect(registry.close(1)).toBe(true)
    expect(inCallback).toEqual([true])
    expect(registry.resolve(1)).toEqual({ ok: false, reason: 'unknown-tab' })
    expect(registry.size).toBe(0)
  })

  it('关闭不存在的标签返回 false，不发事件', () => {
    const registry = new TabRegistry()
    const events = collect(registry)
    expect(registry.close(7)).toBe(false)
    expect(events).toEqual([])
  })

  it('跨窗口移交：身份与两个代际都不变，只有 windowId 变', () => {
    const registry = new TabRegistry()
    registry.create({ tabId: 1, windowId: 10 })
    registry.bumpBinding(1, 'tab-revived')
    registry.bumpNavigation(1)
    const before = registry.snapshot(1)!
    expect(registry.migrate(1, 20)).toBe(true)
    const after = registry.snapshot(1)!
    expect(after.windowId).toBe(20)
    expect(after.bindingId).toBe(before.bindingId)
    expect(after.navigationId).toBe(before.navigationId)
    expect(registry.list(10)).toEqual([])
    expect(registry.list(20).map((entry) => entry.tabId)).toEqual([1])
  })

  it('移交到同一个窗口是空操作（不发事件）', () => {
    const registry = new TabRegistry()
    registry.create({ tabId: 1, windowId: 10 })
    const events = collect(registry)
    expect(registry.migrate(1, 10)).toBe(false)
    expect(events).toEqual([])
  })
})

describe('事件派发', () => {
  it('取消订阅后不再收到事件', () => {
    const registry = new TabRegistry()
    const events = collect(registry)
    const unsubscribe = registry.subscribe((event) => events.push(event))
    unsubscribe()
    registry.create({ tabId: 1, windowId: 10 })
    expect(events.length).toBe(1) // 只剩 collect 那一份
  })

  it('监听器里再改账本：按提交顺序派发，不递归', () => {
    const registry = new TabRegistry()
    registry.create({ tabId: 1, windowId: 10 })
    registry.create({ tabId: 2, windowId: 10 })
    const order: string[] = []
    registry.subscribe((event) => {
      order.push(`${event.kind}:${event.tabId}`)
      // 收到 tab 1 的休眠事件时顺手关掉 tab 2：事件必须排在当前这条之后
      if (event.kind === 'tab-discarded' && event.tabId === 1) registry.close(2)
    })
    registry.bumpBinding(1, 'tab-discarded')
    expect(order).toEqual(['tab-discarded:1', 'tab-closed:2'])
  })
})
