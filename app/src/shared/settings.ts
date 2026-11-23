import { isBrowserEngine } from './engine'
import type { BrowserEngine } from './engine'

/**
 * 设置模型（架构 §4 数据：主进程持业务权威，渲染层只拿投影）。
 *
 * 为什么设置项要有类型化编解码而不是原样存 JSON：设置是**全局副作用**（主题会改
 * nativeTheme、默认引擎会改新标签行为），非法值必须在进库前就被拒绝，不能等用的
 * 时候再兜。这里的 `sanitizeSetting()` 是唯一校验点，主进程不信任渲染层传来的值。
 */
export const THEME_MODES = ['system', 'light', 'dark'] as const
export type ThemeMode = (typeof THEME_MODES)[number]

export type Locale = 'zh-CN'

/** 用户可见设置的形状（键值平铺，便于投影与持久化对齐）。 */
export interface Settings {
  themeMode: ThemeMode
  /** 新标签/新站点的默认引擎；站点规则与手动切换优先于它。 */
  defaultEngine: BrowserEngine
  locale: Locale
}

export const DEFAULT_SETTINGS: Settings = {
  themeMode: 'system',
  // 原生优先：M1 的默认值，改成设置项后保持同样的行为。
  defaultEngine: 'ppapi',
  locale: 'zh-CN'
}

/** 数据库键 ↔ 设置字段的映射（表里一行一个键，便于迁移与增量）。 */
export const SETTING_COLUMNS = {
  'theme.mode': 'themeMode',
  'engine.default': 'defaultEngine',
  locale: 'locale'
} as const

export type SettingKey = keyof typeof SETTING_COLUMNS
export type SettingColumn = (typeof SETTING_COLUMNS)[SettingKey]

/** 每个键的取值域（写入校验与投影共用同一张表）。 */
export type SettingValue = {
  'theme.mode': ThemeMode
  'engine.default': BrowserEngine
  locale: Locale
}

export const SETTING_KEYS = Object.keys(SETTING_COLUMNS) as SettingKey[]

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark'
}

export function isLocale(value: unknown): value is Locale {
  return value === 'zh-CN'
}

export interface SanitizedSetting {
  key: SettingKey
  value: ThemeMode | BrowserEngine | Locale
}
/**
 * 校验并归一一条设置写入。返回 `undefined` 表示拒绝（未知键或非法值）。
 *
 * 拒绝的策略是**整体拒绝**而不是"回落到默认值"：把错的静默改成默认值会让用户以为
 * 设置生效了（例如选了深色却回到跟随系统），比报错更难排查。
 */
export function sanitizeSetting(key: unknown, value: unknown): SanitizedSetting | undefined {
  if (key === 'theme.mode') return isThemeMode(value) ? { key, value } : undefined
  if (key === 'engine.default') return isBrowserEngine(value) ? { key, value } : undefined
  if (key === 'locale') return isLocale(value) ? { key, value } : undefined
  return undefined
}

/** 把数据库里的键值行解成设置对象；坏值逐项丢弃（回落到默认值）而不是整库失败。 */
export function settingsFromRows(rows: ReadonlyArray<{ key: string; value: string }>): Settings {
  const settings: Settings = { ...DEFAULT_SETTINGS }
  for (const row of rows) {
    const sanitized = sanitizeSetting(row.key, row.value)
    if (!sanitized) continue
    const column = SETTING_COLUMNS[sanitized.key]
    // 三个字段的取值域互不相同，这里按列名收窄。
    settings[column] = sanitized.value as never
  }
  return settings
}

/** 把设置对象摊成可写库的行。 */
export function settingsToRows(settings: Settings): Array<{ key: SettingKey; value: string }> {
  return SETTING_KEYS.map((key) => ({ key, value: String(settings[SETTING_COLUMNS[key]]) }))
}

export const themeModeLabels: Record<ThemeMode, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色'
}
