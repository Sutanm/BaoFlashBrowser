import { describe, expect, it } from 'vitest'
import {
  NEWTAB_URL,
  SETTINGS_URL,
  internalKindOf,
  isInternalUrl,
  isNewTabUrl,
  isSettingsUrl,
  parseInternalAddress,
  parseSettingsAddress
} from '../../src/main/internal-pages'

/**
 * 地址栏对 `bao://` 的识别：决定「输入内部地址是留在当前标签还是新开标签」，
 * 判错会让用户在设置页里把设置页本身导航掉，或让新标签页无法被设置页就地覆盖。
 */
describe('isSettingsUrl', () => {
  it('认设置页及其子路径', () => {
    expect(isSettingsUrl('bao://settings/')).toBe(true)
    expect(isSettingsUrl('bao://settings')).toBe(true)
    expect(isSettingsUrl('bao://settings/appearance')).toBe(true)
  })

  it('不认同 scheme 的其它主机、其它协议与非法输入', () => {
    expect(isSettingsUrl('bao://downloads/')).toBe(false)
    expect(isSettingsUrl('https://settings/')).toBe(false)
    expect(isSettingsUrl('bao:settings/')).toBe(false)
    expect(isSettingsUrl('not a url')).toBe(false)
  })
})

describe('isNewTabUrl', () => {
  it('认新标签页（大小写不敏感，`bao:` 不是 special scheme）', () => {
    expect(isNewTabUrl('bao://newtab/')).toBe(true)
    expect(isNewTabUrl('bao://newtab')).toBe(true)
    expect(isNewTabUrl('BAO://NEWTAB/')).toBe(true)
  })

  it('新标签页与设置页互不误认', () => {
    expect(isNewTabUrl('bao://settings/')).toBe(false)
    expect(isSettingsUrl('bao://newtab/')).toBe(false)
    expect(isNewTabUrl('https://newtab/')).toBe(false)
    expect(isNewTabUrl('bao://newtab:1/')).toBe(false)
  })
})

describe('internalKindOf / isInternalUrl', () => {
  it('两个内部页都有种类，其它一切没有', () => {
    expect(internalKindOf('bao://newtab/')).toBe('newtab')
    expect(internalKindOf('bao://settings/appearance')).toBe('settings')
    expect(internalKindOf('bao://downloads/')).toBeUndefined()
    expect(internalKindOf('https://example.com/')).toBeUndefined()
    expect(isInternalUrl('bao://newtab/')).toBe(true)
    expect(isInternalUrl('bao://settings/')).toBe(true)
    expect(isInternalUrl('https://example.com/')).toBe(false)
  })
})

describe('parseSettingsAddress', () => {
  it('设置页地址归一成规范 URL', () => {
    expect(parseSettingsAddress('bao://settings/')).toBe(SETTINGS_URL)
    expect(parseSettingsAddress('bao://settings')).toBe(SETTINGS_URL)
    expect(parseSettingsAddress('  bao://settings/  ')).toBe(SETTINGS_URL)
    expect(parseSettingsAddress('BAO://SETTINGS/')).toBe(SETTINGS_URL)
  })

  it('带端口的内部地址不接受（避免出现第二个 origin）', () => {
    expect(parseSettingsAddress('bao://settings:8080/')).toBeUndefined()
  })

  it('非 bao:// 或非设置页一律交回普通导航', () => {
    expect(parseSettingsAddress('bao://downloads/')).toBeUndefined()
    expect(parseSettingsAddress('https://example.com/')).toBeUndefined()
    expect(parseSettingsAddress('')).toBeUndefined()
  })
})

describe('parseInternalAddress', () => {
  it('把两种内部页解析成种类 + 规范 URL（子路径归一到根）', () => {
    expect(parseInternalAddress('bao://newtab')).toEqual({ kind: 'newtab', url: NEWTAB_URL })
    expect(parseInternalAddress('bao://NEWTAB/anything')).toEqual({ kind: 'newtab', url: NEWTAB_URL })
    expect(parseInternalAddress('bao://settings/appearance')).toEqual({ kind: 'settings', url: SETTINGS_URL })
  })

  it('未知 host、带端口、非 bao:// 都不算内部页', () => {
    expect(parseInternalAddress('bao://downloads/')).toBeUndefined()
    expect(parseInternalAddress('bao://newtab:1/')).toBeUndefined()
    expect(parseInternalAddress('https://newtab/')).toBeUndefined()
    expect(parseInternalAddress('')).toBeUndefined()
  })
})
