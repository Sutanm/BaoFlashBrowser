import { describe, expect, it } from 'vitest'
import { ACTIVITY_LEASE_OWNERS, ActivityLeaseManager } from '../../src/main/activity-lease'

/**
 * 活动租约是标签休眠判定的唯一权威（架构 §7）。
 *
 * 这里全部是确定性用例：时钟由构造函数注入，所以「过期」不需要等真实时间。
 * 行为层的整合验证在 `tests/smoke/tab-discard.test.cjs`（真实 Electron + 真实销毁）。
 */

/** 假时钟：`clock.advance(ms)` 手动推进时间。 */
function fakeClock(start = 1_000) {
  let now = start
  return {
    now: () => now,
    advance(ms: number) {
      now += ms
      return now
    }
  }
}

describe('ActivityLeaseManager：基本登记与休眠判定', () => {
  it('没有租约时标签可以休眠', () => {
    const manager = new ActivityLeaseManager()
    expect(manager.blocksDiscard(3)).toBe(false)
    expect(manager.active(3)).toEqual([])
  })

  it('user 租约阻止休眠，默认就是 preventsDiscard', () => {
    const manager = new ActivityLeaseManager()
    const lease = manager.acquire({ tabId: 3, owner: 'user', reason: '用户标记「保持活跃」' })
    expect(lease.preventsDiscard).toBe(true)
    expect(lease.expiresAt).toBeUndefined()
    expect(manager.blocksDiscard(3)).toBe(true)
    expect(manager.hasOwner(3, 'user')).toBe(true)
  })

  it('取消（释放）租约后恢复休眠资格', () => {
    const manager = new ActivityLeaseManager()
    const lease = manager.acquire({ tabId: 3, owner: 'user', reason: '用户标记' })
    expect(manager.release(lease.leaseId)).toBe(true)
    expect(manager.blocksDiscard(3)).toBe(false)
    // 重复释放是幂等的，不抛错
    expect(manager.release(lease.leaseId)).toBe(false)
  })

  it('多个租约中任意一个 preventsDiscard 即阻止休眠', () => {
    const manager = new ActivityLeaseManager()
    const observer = manager.acquire({ tabId: 5, owner: 'system', reason: '只观察', preventsDiscard: false })
    expect(manager.blocksDiscard(5)).toBe(false)

    const download = manager.acquire({ tabId: 5, owner: 'download', reason: '下载中' })
    expect(manager.blocksDiscard(5)).toBe(true)

    // 释放「阻止」的那条后，只剩不阻止休眠的观察租约 → 重新可以休眠
    manager.release(download.leaseId)
    expect(manager.blocksDiscard(5)).toBe(false)

    // 两条阻止租约里释放任意一条，另一条仍然生效
    const devtools = manager.acquire({ tabId: 5, owner: 'devtools', reason: 'DevTools 已打开' })
    const restore = manager.acquire({ tabId: 5, owner: 'session-restore', reason: '恢复现场' })
    manager.release(devtools.leaseId)
    expect(manager.blocksDiscard(5)).toBe(true)
    manager.release(restore.leaseId)
    expect(manager.blocksDiscard(5)).toBe(false)
    expect(manager.release(observer.leaseId)).toBe(true)
    expect(manager.size).toBe(0)
  })

  it('M2 的五个 owner 都能登记，未知 owner 被拒绝', () => {
    const manager = new ActivityLeaseManager()
    for (const owner of ACTIVITY_LEASE_OWNERS) {
      expect(manager.acquire({ tabId: 9, owner, reason: `${owner} 测试` }).owner).toBe(owner)
    }
    expect(ACTIVITY_LEASE_OWNERS).toEqual(['user', 'session-restore', 'download', 'devtools', 'system'])
    expect(manager.blocksDiscard(9)).toBe(true)
  })

  it('返回副本：外部改不到内部状态', () => {
    const manager = new ActivityLeaseManager()
    const lease = manager.acquire({ tabId: 4, owner: 'user', reason: '用户标记' })
    lease.preventsDiscard = false
    lease.tabId = 99
    expect(manager.blocksDiscard(4)).toBe(true)
    expect(manager.blocksDiscard(99)).toBe(false)
    expect(manager.active(4)[0].preventsDiscard).toBe(true)
  })
})

describe('ActivityLeaseManager：过期与清理', () => {
  it('过期租约立刻不再阻止休眠，且能被确定性回收', () => {
    const clock = fakeClock()
    const manager = new ActivityLeaseManager({ now: clock.now })
    manager.acquire({ tabId: 1, owner: 'download', reason: '下载中', expiresAt: clock.now() + 500 })

    expect(manager.blocksDiscard(1)).toBe(true)
    clock.advance(500) // expiresAt <= now 即过期
    expect(manager.blocksDiscard(1)).toBe(false)
    expect(manager.hasOwner(1, 'download')).toBe(false)
    expect(manager.active(1)).toEqual([])
    // 过期租约还在表里，等扫描周期回收
    expect(manager.size).toBe(1)
    expect(manager.sweepExpired()).toBe(1)
    expect(manager.size).toBe(0)
    // 再扫一次是幂等的
    expect(manager.sweepExpired()).toBe(0)
  })

  it('无期限租约不会被清理，任何时刻都阻止休眠', () => {
    const clock = fakeClock()
    const manager = new ActivityLeaseManager({ now: clock.now })
    manager.acquire({ tabId: 2, owner: 'user', reason: '用户标记' })
    clock.advance(10 * 24 * 60 * 60_000)
    expect(manager.sweepExpired()).toBe(0)
    expect(manager.blocksDiscard(2)).toBe(true)
  })

  it('同一标签的过期租约不影响未过期的另一条', () => {
    const clock = fakeClock()
    const manager = new ActivityLeaseManager({ now: clock.now })
    manager.acquire({ tabId: 6, owner: 'download', reason: '短期下载', expiresAt: clock.now() + 100 })
    manager.acquire({ tabId: 6, owner: 'user', reason: '用户标记' })
    clock.advance(1_000)
    expect(manager.sweepExpired()).toBe(1)
    expect(manager.blocksDiscard(6)).toBe(true)
    expect(manager.active(6).map((lease) => lease.owner)).toEqual(['user'])
  })

  it('显式 leaseId 是幂等续租，不会叠加第二条', () => {
    const clock = fakeClock()
    const manager = new ActivityLeaseManager({ now: clock.now })
    const first = manager.acquire({
      leaseId: 'keep-awake-7', tabId: 7, owner: 'user', reason: '用户标记', expiresAt: clock.now() + 1_000
    })
    const renewed = manager.acquire({
      leaseId: 'keep-awake-7', tabId: 7, owner: 'user', reason: '用户标记（续）', expiresAt: clock.now() + 5_000
    })
    expect(manager.size).toBe(1)
    expect(first.leaseId).toBe(renewed.leaseId)
    expect(renewed.reason).toBe('用户标记（续）')
    // 续租延长了寿命：原来的到期点不再是边界
    clock.advance(2_000)
    expect(manager.blocksDiscard(7)).toBe(true)
  })
})

describe('ActivityLeaseManager：清理入口', () => {
  it('releaseOwner 只释放该 owner，releaseTab 释放整个标签', () => {
    const manager = new ActivityLeaseManager()
    manager.acquire({ tabId: 8, owner: 'user', reason: '用户标记' })
    manager.acquire({ tabId: 8, owner: 'download', reason: '下载中' })
    manager.acquire({ tabId: 8, owner: 'devtools', reason: 'DevTools 已打开' })

    expect(manager.releaseOwner(8, 'user')).toBe(1)
    expect(manager.hasOwner(8, 'user')).toBe(false)
    expect(manager.blocksDiscard(8)).toBe(true)

    expect(manager.releaseTab(8)).toBe(2)
    expect(manager.size).toBe(0)
    expect(manager.blocksDiscard(8)).toBe(false)
  })

  it('releaseOwner / releaseTab 不影响其它标签', () => {
    const manager = new ActivityLeaseManager()
    manager.acquire({ tabId: 10, owner: 'user', reason: '用户标记 10' })
    manager.acquire({ tabId: 11, owner: 'user', reason: '用户标记 11' })

    expect(manager.releaseOwner(10, 'user')).toBe(1)
    expect(manager.blocksDiscard(10)).toBe(false)
    expect(manager.blocksDiscard(11)).toBe(true)

    expect(manager.releaseTab(10)).toBe(0)
    expect(manager.blocksDiscard(11)).toBe(true)
  })

  /**
   * 跨窗口移动不丢租约，本质是「租约只认 tabId、不认窗口」。
   *
   * 主进程只有一个 `activityLeases` 实例，标签拖出时 `detachTab`/`adoptTab` 既不释放
   * 也不重建租约，所以这里用「同一 tabId 的租约在任何调用方视角下都成立」来固化语义。
   */
  it('租约按 tabId 归属，与窗口/绑定无关', () => {
    const manager = new ActivityLeaseManager()
    manager.acquire({ leaseId: 'keep-awake-12', tabId: 12, owner: 'user', reason: '用户标记' })
    // 「新窗口」只是换了个调用方，同一张表里同一 tabId 的租约仍然成立
    expect(manager.blocksDiscard(12)).toBe(true)
    expect(manager.hasOwner(12, 'user')).toBe(true)
    expect(manager.active(12)).toHaveLength(1)
  })

  it('clear 清空整张表', () => {
    const manager = new ActivityLeaseManager()
    manager.acquire({ tabId: 1, owner: 'user', reason: 'a' })
    manager.acquire({ tabId: 2, owner: 'system', reason: 'b' })
    manager.clear()
    expect(manager.size).toBe(0)
    expect(manager.blocksDiscard(1)).toBe(false)
  })
})

describe('ActivityLeaseManager：参数校验', () => {
  const manager = () => new ActivityLeaseManager()

  it('拒绝非法 tabId', () => {
    expect(() => manager().acquire({ tabId: 0, owner: 'user', reason: 'x' })).toThrow(TypeError)
    expect(() => manager().acquire({ tabId: -1, owner: 'user', reason: 'x' })).toThrow(TypeError)
    expect(() => manager().acquire({ tabId: 1.5, owner: 'user', reason: 'x' })).toThrow(TypeError)
  })

  it('拒绝未知 owner 与空 reason', () => {
    const acquire = (request: Record<string, unknown>) =>
      manager().acquire(request as unknown as Parameters<ActivityLeaseManager['acquire']>[0])
    expect(() => acquire({ tabId: 1, owner: 'agent', reason: 'x' })).toThrow(TypeError)
    expect(() => acquire({ tabId: 1, owner: 'user', reason: '   ' })).toThrow(TypeError)
    expect(() => acquire({ tabId: 1, owner: 'user' })).toThrow(TypeError)
  })

  it('拒绝非法 expiresAt', () => {
    expect(() => manager().acquire({ tabId: 1, owner: 'user', reason: 'x', expiresAt: Number.NaN })).toThrow(TypeError)
    expect(() => manager().acquire({ tabId: 1, owner: 'user', reason: 'x', expiresAt: Infinity })).toThrow(TypeError)
  })

  it('拒绝用同一 leaseId 覆盖另一个标签或 owner 的租约', () => {
    const instance = manager()
    instance.acquire({ leaseId: 'fixed', tabId: 1, owner: 'user', reason: 'x' })
    expect(() => instance.acquire({ leaseId: 'fixed', tabId: 2, owner: 'user', reason: 'y' })).toThrow(TypeError)
    expect(() => instance.acquire({ leaseId: 'fixed', tabId: 1, owner: 'system', reason: 'y' })).toThrow(TypeError)
    expect(instance.size).toBe(1)
  })
})
