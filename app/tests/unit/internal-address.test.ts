import { describe, expect, it } from 'vitest'
import { SETTINGS_URL, isSettingsUrl, parseSettingsAddress } from '../../src/main/internal-pages'

/**
 * 地址栏对 `bao://` 的识别：决定「输入内部地址是留在当前标签还是新开标签」，
 * 判错会让用户在设置页里把设置页本身导航掉。
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
