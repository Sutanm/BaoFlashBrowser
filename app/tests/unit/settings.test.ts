import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  SETTING_KEYS,
  isLocale,
  isThemeMode,
  sanitizeSetting,
  settingsFromRows,
  settingsToRows
} from '../../src/shared/settings'

/**
 * 设置层的纯逻辑：写库前校验、坏值回落、行 ↔ 对象互转。
 *
 * 这些以前只被 `tests/data/settings-store.test.cjs`（跑真实 SQLite、11 s）间接覆盖，
 * 现在拆成毫秒级用例；数据库本身的行为仍由那条端到端用例负责。
 */
describe('sanitizeSetting', () => {
  it('接受三个已知键的合法取值', () => {
    expect(sanitizeSetting('theme.mode', 'dark')).toEqual({ key: 'theme.mode', value: 'dark' })
    expect(sanitizeSetting('engine.default', 'ruffle')).toEqual({ key: 'engine.default', value: 'ruffle' })
    expect(sanitizeSetting('locale', 'zh-CN')).toEqual({ key: 'locale', value: 'zh-CN' })
  })

  it('拒绝越界取值', () => {
    expect(sanitizeSetting('theme.mode', 'blue')).toBeUndefined()
    expect(sanitizeSetting('theme.mode', '')).toBeUndefined()
    expect(sanitizeSetting('engine.default', 'flash')).toBeUndefined()
    expect(sanitizeSetting('locale', 'en-US')).toBeUndefined()
  })

  it('拒绝非字符串值（数据库被写坏时不会污染设置）', () => {
    expect(sanitizeSetting('theme.mode', 1)).toBeUndefined()
    expect(sanitizeSetting('theme.mode', null)).toBeUndefined()
    expect(sanitizeSetting('engine.default', { engine: 'ruffle' })).toBeUndefined()
  })

  it('拒绝未知键', () => {
    expect(sanitizeSetting('theme.brightness', 'high')).toBeUndefined()
    expect(sanitizeSetting(undefined, 'dark')).toBeUndefined()
  })
})

describe('settingsFromRows', () => {
  it('空表回落到默认值', () => {
    expect(settingsFromRows([])).toEqual(DEFAULT_SETTINGS)
  })

  it('逐行覆盖，坏值单独丢弃', () => {
    const settings = settingsFromRows([
      { key: 'theme.mode', value: 'light' },
      { key: 'engine.default', value: 'nope' },
      { key: 'locale', value: 'zh-CN' },
      { key: 'unknown.key', value: 'x' }
    ])
    expect(settings).toEqual({ themeMode: 'light', defaultEngine: 'ppapi', locale: 'zh-CN' })
  })

  it('同一个键出现多次时后者生效（迁移/重复写不会留两份状态）', () => {
    const settings = settingsFromRows([
      { key: 'theme.mode', value: 'dark' },
      { key: 'theme.mode', value: 'light' }
    ])
    expect(settings.themeMode).toBe('light')
  })
})

describe('settingsToRows', () => {
  it('摊成固定的三行，键名与表一致', () => {
    const rows = settingsToRows({ themeMode: 'dark', defaultEngine: 'ruffle', locale: 'zh-CN' })
    expect(rows).toEqual([
      { key: 'theme.mode', value: 'dark' },
      { key: 'engine.default', value: 'ruffle' },
      { key: 'locale', value: 'zh-CN' }
    ])
    expect(rows.map((row) => row.key).sort()).toEqual([...SETTING_KEYS].sort())
  })

  it('与 settingsFromRows 互逆', () => {
    const original = { themeMode: 'light' as const, defaultEngine: 'ruffle' as const, locale: 'zh-CN' as const }
    expect(settingsFromRows(settingsToRows(original))).toEqual(original)
  })
})

describe('类型守卫', () => {
  it('isThemeMode / isLocale 只认已知取值', () => {
    for (const mode of ['system', 'light', 'dark']) expect(isThemeMode(mode)).toBe(true)
    expect(isThemeMode('auto')).toBe(false)
    expect(isLocale('zh-CN')).toBe(true)
    expect(isLocale('zh-cn')).toBe(false)
  })
})
