import { describe, expect, it } from 'vitest'
import {
  SESSION_MAX_TABS,
  SESSION_MAX_WINDOWS,
  SESSION_VERSION,
  sanitizeSession,
  sanitizeSessionTab,
  sessionFromPayload,
  sessionTabCount
} from '../../src/shared/session'

/**
 * 会话载荷是不可信输入（磁盘上的旧版本 / 手改 / 截断）。
 * 这里把「什么能进内存」钉死在确定性用例里；真实读写路径在 `tests/data/session-store.test.cjs`，
 * 端到端恢复在 `tests/smoke/session-restore.test.cjs`。
 */

const webTab = (overrides: Record<string, unknown> = {}) => ({
  url: 'https://example.com/game/play.swf',
  title: '示例页面',
  engine: 'ppapi',
  manualOverride: false,
  pinned: false,
  muted: false,
  keepAwake: false,
  ...overrides
})

const session = (windows: unknown[]) => ({ version: SESSION_VERSION, savedAt: 1_700_000_000_000, windows })

describe('sanitizeSessionTab', () => {
  it('接受合法网页标签并保留全部字段', () => {
    expect(sanitizeSessionTab(webTab({ pinned: true, muted: true, keepAwake: true, manualOverride: true })))
      .toEqual({
        url: 'https://example.com/game/play.swf',
        title: '示例页面',
        engine: 'ppapi',
        manualOverride: true,
        pinned: true,
        muted: true,
        keepAwake: true
      })
  })

  it('只认 true：字符串/数字等"看起来为真"的值一律按 false 处理', () => {
    const tab = sanitizeSessionTab(webTab({ pinned: 'true', muted: 1, keepAwake: { yes: true } }))
    expect(tab?.pinned).toBe(false)
    expect(tab?.muted).toBe(false)
    expect(tab?.keepAwake).toBe(false)
  })

  it('拒绝非 http(s)、带凭据的地址', () => {
    for (const url of ['ftp://example.com/a', 'file:///C:/a.html', 'javascript:alert(1)',
      'https://user:pass@example.com/a', 'bao://settings/', '', 'not a url']) {
      expect(sanitizeSessionTab(webTab({ url }))).toBeUndefined()
    }
  })

  it('拒绝未知引擎（不能把坏值当成 ruffle/ppapi）', () => {
    expect(sanitizeSessionTab(webTab({ engine: 'gecko' }))).toBeUndefined()
    expect(sanitizeSessionTab(webTab({ engine: undefined }))).toBeUndefined()
  })

  it('新标签页允许空地址或自身地址，别的地址一律丢弃', () => {
    expect(sanitizeSessionTab(webTab({ url: '', internal: 'newtab' })))
      .toEqual({ url: '', title: '示例页面', engine: 'ppapi', manualOverride: false, pinned: false, muted: false, keepAwake: false, internal: 'newtab' })
    expect(sanitizeSessionTab(webTab({ url: 'bao://newtab/', internal: 'newtab' }))?.url).toBe('')
    expect(sanitizeSessionTab(webTab({ url: 'https://example.com/', internal: 'newtab' }))).toBeUndefined()
    // 未知内部页（例如设置页）不落盘，也不许被当成新标签页
    expect(sanitizeSessionTab(webTab({ url: 'bao://settings/', internal: 'settings' }))).toBeUndefined()
  })

  it('标题截断，非字符串标题归一为空串', () => {
    const long = sanitizeSessionTab(webTab({ title: 'x'.repeat(2000) }))
    expect(long?.title).toHaveLength(512)
    expect(sanitizeSessionTab(webTab({ title: 42 }))?.title).toBe('')
  })
})

describe('sanitizeSession', () => {
  it('合法会话原样通过', () => {
    const value = session([{ tabs: [webTab(), webTab({ url: 'https://example.com/b', active: true })] }])
    expect(sanitizeSession(value)).toEqual(value)
  })

  it('版本不符或结构不对时整份丢弃', () => {
    expect(sanitizeSession(session([{ tabs: [webTab()] }]).version === 1 ? { ...session([{ tabs: [webTab()] }]), version: 2 } : {})).toBeUndefined()
    expect(sanitizeSession({ windows: [{ tabs: [webTab()] }] })).toBeUndefined()
    expect(sanitizeSession({ version: SESSION_VERSION, windows: 'nope' })).toBeUndefined()
    expect(sanitizeSession(null)).toBeUndefined()
    expect(sanitizeSession([webTab()])).toBeUndefined()
  })

  it('丢掉坏标签与空窗口，其余继续恢复', () => {
    const value = session([
      { tabs: [webTab({ url: 'ftp://bad/' })] },
      { tabs: [webTab({ url: 'https://keep.example.com/a' }), webTab({ engine: 'nope' })] },
      'not a window',
      {}
    ])
    const result = sanitizeSession(value)
    expect(result?.windows).toHaveLength(1)
    expect(result?.windows[0].tabs.map((tab) => tab.url)).toEqual(['https://keep.example.com/a'])
  })

  it('每个窗口只保留第一个活动标签，其余降级为普通标签（不丢页面）', () => {
    const value = session([{
      tabs: [webTab({ url: 'https://a.example.com/', active: true }), webTab({ url: 'https://b.example.com/', active: true })]
    }])
    const tabs = sanitizeSession(value)?.windows[0].tabs ?? []
    expect(tabs).toHaveLength(2)
    expect(tabs[0].active).toBe(true)
    expect(tabs[1].active).toBeUndefined()
  })

  it('窗口与标签数量都有上限，超出的截断', () => {
    const manyWindows = Array.from({ length: SESSION_MAX_WINDOWS + 5 }, (_, index) => ({
      tabs: [webTab({ url: `https://w${index}.example.com/` })]
    }))
    expect(sanitizeSession(session(manyWindows))?.windows).toHaveLength(SESSION_MAX_WINDOWS)

    const manyTabs = Array.from({ length: SESSION_MAX_TABS + 20 }, (_, index) => webTab({ url: `https://t${index}.example.com/` }))
    expect(sanitizeSession(session([{ tabs: manyTabs }]))?.windows[0].tabs).toHaveLength(SESSION_MAX_TABS)
  })

  it('savedAt 非法时归一为 0（不阻断恢复）', () => {
    const value = { version: SESSION_VERSION, savedAt: 'yesterday', windows: [{ tabs: [webTab()] }] }
    expect(sanitizeSession(value)?.savedAt).toBe(0)
  })
})

describe('sessionFromPayload', () => {
  it('坏 JSON / 空载荷都当作"没有会话"', () => {
    expect(sessionFromPayload('{ 这不是 JSON')).toBeUndefined()
    expect(sessionFromPayload('')).toBeUndefined()
    expect(sessionFromPayload(undefined)).toBeUndefined()
    expect(sessionFromPayload('null')).toBeUndefined()
  })

  it('合法载荷往返不丢字段', () => {
    const value = session([{ tabs: [webTab({ active: true })] }])
    expect(sessionFromPayload(JSON.stringify(value))).toEqual(value)
  })
})

describe('sessionTabCount', () => {
  it('跨窗口累加标签数（崩溃恢复提示的文案用它）', () => {
    const value = session([
      { tabs: [webTab(), webTab({ url: 'https://b.example.com/' })] },
      { tabs: [webTab({ url: 'https://c.example.com/' })] }
    ])
    expect(sessionTabCount(sanitizeSession(value))).toBe(3)
  })

  it('没有会话时为 0（不显示提示条）', () => {
    expect(sessionTabCount(undefined)).toBe(0)
  })
})
