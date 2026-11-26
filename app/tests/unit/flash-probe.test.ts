import { describe, expect, it } from 'vitest'
import { FlashPresenceCache, FLASH_PROBE, detectFlashContent, probeFlashContent } from '../../src/main/flash-probe'
import type { FlashProbeFrame } from '../../src/main/flash-probe'

/**
 * Flash 内容判定（ADR-0004 §2 硬门禁）的纯层用例。
 *
 * 这份判据以前长在 `browser-window.ts` 的闭包里，只能靠真 Electron 的 smoke 验证
 * （`tab-discard` 里那三条 Flash 用例，每条要 5–8 秒）。抽出来以后，跨帧遍历、fail-closed、
 * 阴性不缓存这些**最容易改错**的语义可以毫秒级穷举；真实销毁行为仍由 smoke 守着。
 */

interface FakeFrame {
  frame: FlashProbeFrame
  calls: number
}

function fakeFrame(options: { detached?: boolean; reply?: unknown; throws?: boolean } = {}): FakeFrame {
  const state: FakeFrame = {
    calls: 0,
    frame: {
      detached: options.detached ?? false,
      executeJavaScript: async () => {
        state.calls += 1
        if (options.throws) throw new Error('frame was disposed')
        return options.reply
      }
    }
  }
  return state
}

function request(tabId: number, binding: number, cache: FlashPresenceCache, frames: () => FlashProbeFrame[] | undefined) {
  return { tabId, binding, cache, frames }
}

describe('probeFlashContent：逐帧探测', () => {
  it('主帧没有、iframe 里有 → 命中（跨源播放器挂在子帧）', async () => {
    const main = fakeFrame({ reply: false })
    const child = fakeFrame({ reply: true })
    expect(await probeFlashContent([main.frame, child.frame])).toBe('hit')
  })

  it('所有帧都回答「没有」→ clear', async () => {
    expect(await probeFlashContent([fakeFrame({ reply: false }).frame, fakeFrame({ reply: false }).frame])).toBe('clear')
  })

  it('已 detach 的帧不去执行脚本（执行必然抛错，那是「这一帧没了」而不是「判不出」）', async () => {
    const detached = fakeFrame({ detached: true, reply: true })
    const live = fakeFrame({ reply: false })
    expect(await probeFlashContent([detached.frame, live.frame])).toBe('clear')
    expect(detached.calls).toBe(0)
    expect(live.calls).toBe(1)
  })

  it('执行抛错 → unknown（fail-closed，且不再往下探）', async () => {
    const broken = fakeFrame({ throws: true })
    const later = fakeFrame({ reply: true })
    expect(await probeFlashContent([broken.frame, later.frame])).toBe('unknown')
    expect(later.calls).toBe(0)
  })

  it('没有帧 → clear', async () => {
    expect(await probeFlashContent([])).toBe('clear')
  })

  it('探测脚本覆盖 ppapi 与 Ruffle 两种形态', () => {
    expect(FLASH_PROBE).toContain('embed')
    expect(FLASH_PROBE).toContain('object')
    expect(FLASH_PROBE).toContain('ruffle-player')
    expect(FLASH_PROBE).toContain('shockwave')
    expect(FLASH_PROBE).toContain('flash')
  })
})

describe('detectFlashContent：缓存与降级', () => {
  it('阳性结果被粘住：同一绑定代际下不再执行脚本', async () => {
    const cache = new FlashPresenceCache()
    let resolved = 0
    const frames = () => {
      resolved += 1
      return [fakeFrame({ reply: true }).frame]
    }
    expect(await detectFlashContent(request(5, 1, cache, frames))).toBe(true)
    expect(await detectFlashContent(request(5, 1, cache, frames))).toBe(true)
    expect(resolved).toBe(1)
    expect(cache.size).toBe(1)
  })

  it('阴性结果**不**缓存：页面后来插入播放器必须能被重新发现', async () => {
    const cache = new FlashPresenceCache()
    let hit = false
    const frames = () => [fakeFrame({ reply: hit }).frame]
    expect(await detectFlashContent(request(5, 1, cache, frames))).toBe(false)
    hit = true
    expect(await detectFlashContent(request(5, 1, cache, frames))).toBe(true)
  })

  it('绑定代际变化使阳性失效（视图重建/唤醒/引擎切换后必须重探）', async () => {
    const cache = new FlashPresenceCache()
    cache.mark(7, 1)
    let resolved = 0
    const frames = () => {
      resolved += 1
      return [fakeFrame({ reply: false }).frame]
    }
    // 旧代际的阳性仍然算数
    expect(await detectFlashContent(request(7, 1, cache, frames))).toBe(true)
    expect(resolved).toBe(0)
    // 新代际必须重探，且阳性记录不会跨代际残留
    expect(await detectFlashContent(request(7, 2, cache, frames))).toBe(false)
    expect(resolved).toBe(1)
    expect(cache.isKnown(7, 2)).toBe(false)
  })

  it('取不到主帧（frames 返回 undefined）→ 按「有 Flash」处理', async () => {
    const cache = new FlashPresenceCache()
    expect(await detectFlashContent(request(1, 1, cache, () => undefined))).toBe(true)
  })

  it('取帧本身抛错 → 按「有 Flash」处理', async () => {
    const cache = new FlashPresenceCache()
    const boom = () => {
      throw new Error('mainFrame disposed')
    }
    expect(await detectFlashContent(request(1, 1, cache, boom))).toBe(true)
  })

  it('判不出（unknown）也按「有 Flash」处理，但不写缓存', async () => {
    const cache = new FlashPresenceCache()
    const broken = () => [fakeFrame({ throws: true }).frame]
    expect(await detectFlashContent(request(2, 1, cache, broken))).toBe(true)
    expect(cache.isKnown(2, 1)).toBe(false)
  })

  it('不同标签的阳性互不串台', async () => {
    const cache = new FlashPresenceCache()
    const hitFrames = () => [fakeFrame({ reply: true }).frame]
    const missFrames = () => [fakeFrame({ reply: false }).frame]
    expect(await detectFlashContent(request(1, 1, cache, hitFrames))).toBe(true)
    expect(await detectFlashContent(request(2, 1, cache, missFrames))).toBe(false)
  })

  it('forget 之后重新探测（休眠/关闭标签时清缓存）', async () => {
    const cache = new FlashPresenceCache()
    cache.mark(3, 1)
    cache.forget(3)
    expect(cache.isKnown(3, 1)).toBe(false)
    let resolved = 0
    const frames = () => {
      resolved += 1
      return [fakeFrame({ reply: false }).frame]
    }
    expect(await detectFlashContent(request(3, 1, cache, frames))).toBe(false)
    expect(resolved).toBe(1)
  })
})

describe('FlashPresenceCache', () => {
  it('按 (tabId, binding) 记录，clear 清空', () => {
    const cache = new FlashPresenceCache()
    cache.mark(1, 1)
    cache.mark(2, 1)
    expect(cache.size).toBe(2)
    expect(cache.isKnown(1, 1)).toBe(true)
    expect(cache.isKnown(1, 2)).toBe(false)
    cache.clear()
    expect(cache.size).toBe(0)
  })
})
