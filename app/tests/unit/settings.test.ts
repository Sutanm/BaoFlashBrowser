import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  SESSION_STARTUP_MODES,
  SETTING_KEYS,
  isLocale,
  isThemeMode,
  sanitizeSetting,
  sessionStartupLabels,
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
  it('接受已知键的合法取值', () => {
    expect(sanitizeSetting('theme.mode', 'dark')).toEqual({ key: 'theme.mode', value: 'dark' })
    expect(sanitizeSetting('engine.default', 'ruffle')).toEqual({ key: 'engine.default', value: 'ruffle' })
    expect(sanitizeSetting('search.engine', 'bing')).toEqual({ key: 'search.engine', value: 'bing' })
    expect(sanitizeSetting('locale', 'zh-CN')).toEqual({ key: 'locale', value: 'zh-CN' })
    expect(sanitizeSetting('overlay.prewarm', 'always')).toEqual({ key: 'overlay.prewarm', value: 'always' })
    expect(sanitizeSetting('tab.discard', 'never')).toEqual({ key: 'tab.discard', value: 'never' })
    expect(sanitizeSetting('session.startup', 'continue')).toEqual({ key: 'session.startup', value: 'continue' })
  })

  it('拒绝越界取值', () => {
    expect(sanitizeSetting('theme.mode', 'blue')).toBeUndefined()
    expect(sanitizeSetting('theme.mode', '')).toBeUndefined()
    expect(sanitizeSetting('engine.default', 'flash')).toBeUndefined()
    // 搜索引擎只有内置目录：别把用户自造的 id 静默接受（设置页会显示成空白）。
    expect(sanitizeSetting('search.engine', 'sogou')).toBeUndefined()
    expect(sanitizeSetting('search.engine', '')).toBeUndefined()
    expect(sanitizeSetting('locale', 'en-US')).toBeUndefined()
    expect(sanitizeSetting('tab.discard', 'aggressive')).toBeUndefined()
    // 启动行为只有两档：别把 Chrome 的 "restore" 之类写法当成合法值静默接受。
    expect(sanitizeSetting('session.startup', 'restore')).toBeUndefined()
    expect(sanitizeSetting('session.startup', 'Continue')).toBeUndefined()
  })

  it('拒绝非字符串值（数据库被写坏时不会污染设置）', () => {
    expect(sanitizeSetting('theme.mode', 1)).toBeUndefined()
    expect(sanitizeSetting('theme.mode', null)).toBeUndefined()
    expect(sanitizeSetting('engine.default', { engine: 'ruffle' })).toBeUndefined()
    expect(sanitizeSetting('session.startup', true)).toBeUndefined()
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

  it('启动行为默认是 newtab（正常退出后重启不恢复）', () => {
    expect(DEFAULT_SETTINGS.sessionStartup).toBe('newtab')
  })

  it('启动选项的文案不带括号说明（细节归文档，不进控件标签）', () => {
    for (const mode of SESSION_STARTUP_MODES) {
      expect(sessionStartupLabels[mode]).not.toMatch(/[（(]/)
    }
    expect(sessionStartupLabels.newtab).toBe('打开新标签页')
    expect(sessionStartupLabels.continue).toBe('打开上一个会话中的标签页')
  })

  it('逐行覆盖，坏值单独丢弃', () => {
    const settings = settingsFromRows([
      { key: 'theme.mode', value: 'light' },
      { key: 'engine.default', value: 'nope' },
      { key: 'locale', value: 'zh-CN' },
      { key: 'unknown.key', value: 'x' }
    ])
    // 默认值从 DEFAULT_SETTINGS 取，别在这里硬编码档位：`overlay.prewarm` 的默认值会随产品决策变
    // （2026-11-25 从 auto 改成 always：共享进程下常驻只值 +5–6 MB），这条用例要断言的是
    // "坏值回落到默认"，不是"默认是哪一档"。
    expect(settings).toEqual({
      overlayPrewarm: DEFAULT_SETTINGS.overlayPrewarm, tabDiscard: 'auto', sessionStartup: 'newtab',
      themeMode: 'light', defaultEngine: 'ppapi', searchEngine: DEFAULT_SETTINGS.searchEngine, locale: 'zh-CN'
    })
  })

  it('老库里残留的 `auto` 预热档被丢弃并回落到默认（删档不需要迁移脚本）', () => {
    const settings = settingsFromRows([
      { key: 'overlay.prewarm', value: 'auto' },
      { key: 'tab.discard', value: 'auto' }
    ])
    // 2026-11-26：预热由三档收敛成开关，中间档 `auto` 从取值域里删掉。
    // 磁盘上残留的 `auto` 不该让整份设置报废，也不该被当成"关"，回落到默认档即可。
    expect(settings.overlayPrewarm).toBe(DEFAULT_SETTINGS.overlayPrewarm)
    expect(settings.overlayPrewarm).toBe('always')
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
  it('摊成固定的行，键名与表一致', () => {
    const rows = settingsToRows({
      themeMode: 'dark', defaultEngine: 'ruffle', searchEngine: 'bing', locale: 'zh-CN',
      overlayPrewarm: 'never', tabDiscard: 'auto', sessionStartup: 'newtab'
    })
    expect(rows).toEqual([
      { key: 'overlay.prewarm', value: 'never' },
      { key: 'tab.discard', value: 'auto' },
      { key: 'session.startup', value: 'newtab' },
      { key: 'theme.mode', value: 'dark' },
      { key: 'engine.default', value: 'ruffle' },
      { key: 'search.engine', value: 'bing' },
      { key: 'locale', value: 'zh-CN' }
    ])
    expect(rows.map((row) => row.key).sort()).toEqual([...SETTING_KEYS].sort())
  })

  it('与 settingsFromRows 互逆', () => {
    const original = {
      themeMode: 'light' as const, defaultEngine: 'ruffle' as const, locale: 'zh-CN' as const,
      searchEngine: 'google' as const, overlayPrewarm: 'always' as const, tabDiscard: 'auto' as const,
      sessionStartup: 'continue' as const
    }
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
