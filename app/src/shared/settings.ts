import { isBrowserEngine } from './engine'
import type { BrowserEngine } from './engine'

/**
 * 设置模型（架构 §4 数据：主进程持业务权威，渲染层只拿投影）。
 *
 * 为什么设置项要有类型化编解码而不是原样存 JSON：设置是**全局副作用**（主题会改
 * nativeTheme、默认引擎会改新标签行为），非法值必须在进库前就被拒绝，不能等用的
 * 时候再兜。这里的 `sanitizeSetting()` 是唯一校验点，主进程不信任渲染层传来的值。
 */
export const DISCARD_MODES = ['auto', 'never'] as const
export type DiscardMode = (typeof DISCARD_MODES)[number]

export const PREWARM_MODES = ['auto', 'always', 'never'] as const
export type PrewarmMode = (typeof PREWARM_MODES)[number]

export const THEME_MODES = ['system', 'light', 'dark'] as const
export type ThemeMode = (typeof THEME_MODES)[number]

export type Locale = 'zh-CN'

/** 用户可见设置的形状（键值平铺，便于投影与持久化对齐）。 */
export interface Settings {
  /** 叠加层预热策略：auto=悬停预热 + 5 分钟回收；always=窗口创建即常驻；never=用到才建。 */
  overlayPrewarm: PrewarmMode
  /** 后台标签休眠：auto=后台超过 TTL 丢弃视图（切回重新加载）；never=从不丢弃（挂机场景）。 */
  tabDiscard: DiscardMode
  themeMode: ThemeMode
  /** 新标签/新站点的默认引擎；站点规则与手动切换优先于它。 */
  defaultEngine: BrowserEngine
  locale: Locale
}

export const DEFAULT_SETTINGS: Settings = {
  overlayPrewarm: 'auto',
  tabDiscard: 'auto',
  themeMode: 'system',
  // 原生优先：M1 的默认值，改成设置项后保持同样的行为。
  defaultEngine: 'ppapi',
  locale: 'zh-CN'
}

/** 数据库键 ↔ 设置字段的映射（表里一行一个键，便于迁移与增量）。 */
export const SETTING_COLUMNS = {
  'overlay.prewarm': 'overlayPrewarm',
  'tab.discard': 'tabDiscard',
  'theme.mode': 'themeMode',
  'engine.default': 'defaultEngine',
  locale: 'locale'
} as const

export type SettingKey = keyof typeof SETTING_COLUMNS
export type SettingColumn = (typeof SETTING_COLUMNS)[SettingKey]

/** 每个键的取值域（写入校验与投影共用同一张表）。 */
export type SettingValue = {
  'overlay.prewarm': PrewarmMode
  'tab.discard': DiscardMode
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
  value: ThemeMode | BrowserEngine | Locale | PrewarmMode | DiscardMode
}
/**
 * 校验并归一一条设置写入。返回 `undefined` 表示拒绝（未知键或非法值）。
 *
 * 拒绝的策略是**整体拒绝**而不是"回落到默认值"：把错的静默改成默认值会让用户以为
 * 设置生效了（例如选了深色却回到跟随系统），比报错更难排查。
 */
export function isDiscardMode(value: unknown): value is DiscardMode {
  return typeof value === 'string' && (DISCARD_MODES as readonly string[]).includes(value)
}

export function isPrewarmMode(value: unknown): value is PrewarmMode {
  return typeof value === 'string' && (PREWARM_MODES as readonly string[]).includes(value)
}

export function sanitizeSetting(key: unknown, value: unknown): SanitizedSetting | undefined {
  if (key === 'tab.discard') return isDiscardMode(value) ? { key, value } : undefined
  if (key === 'overlay.prewarm') return isPrewarmMode(value) ? { key, value } : undefined
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

export const discardModeLabels: Record<DiscardMode, string> = {
  auto: '自动（后台 10 分钟后休眠）',
  never: '从不（后台标签一直运行）'
}

export const prewarmModeLabels: Record<PrewarmMode, string> = {
  auto: '自动（悬停预热）',
  always: '常驻（更快，占内存）',
  never: '不预热'
}

export const themeModeLabels: Record<ThemeMode, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色'
}

/* ------------------------------------------------------------------ *
 * 内部设置页（`bao://settings`）与主进程之间的窄合同。
 *
 * 这里刻意只有三个通道、两个动词：内部页**拿不到** `baoBrowser` / `baoOverlay` /
 * `baoWindowControl`，也拿不到任意 URL 的读写或文件路径。发送者身份由主进程按
 * 「本窗口的标签表 ∧ 主帧 ∧ 文档 URL ∈ bao://settings/*」三条件判定。
 * ------------------------------------------------------------------ */

export const settingsChannels = {
  read: 'settings:read',
  write: 'settings:write',
  changed: 'settings:changed',
  /** 读 Flash 插件状态（是否就绪 / 版本 / 是否需要重启）。 */
  flashStatus: 'settings:flash-status',
  /** 打开文件选择框导入插件（复制到 `<userData>/flash/`）。 */
  flashImport: 'settings:flash-import',
  /** 在系统文件管理器里定位当前插件（路径由主进程解析，页面不能指定）。 */
  flashReveal: 'settings:flash-reveal'
} as const

export type FlashPluginSource = 'env' | 'user' | 'exe' | 'resources' | 'scan'

export interface FlashPluginState {
  /** 本进程启动时注册的就是磁盘上当前这一份。 */
  ready: boolean
  /** 磁盘上是否解析到了真实的插件文件；false 时 `path` 只是建议的投放位置。 */
  found: boolean
  /** 实际加载的插件路径（未找到时是期望的投放路径）。 */
  path: string
  version?: string
  size?: number
  source?: FlashPluginSource
  /** 自动发现的来源标签（`system-flash` / `chrome` / `downloads` …），仅 `source === 'scan'`。 */
  origin?: string
  /** 自动发现结果的扫描时间（毫秒时间戳），仅 `source === 'scan'`。 */
  discoveredAt?: number
  /** 磁盘上的插件与本进程启动时注册的不一致（或没注册上）→ 需要重启。 */
  restartRequired: boolean
}

export type FlashImportResult =
  | { ok: true; status: FlashPluginState }
  | { ok: false; code: 'forbidden-sender' | 'cancelled' | 'invalid' | 'not-64-bit' | 'not-pepper' | 'copy-failed' }

export interface SettingsSnapshot {
  settings: Settings
  /** 解析后的亮/暗：内部页据此上色（`nativeTheme.shouldUseDarkColors` 的结果）。 */
  theme: 'light' | 'dark'
  storage: 'ready' | 'unavailable'
  /** 原生 Flash 插件是否可用（BYOP：没放插件时引擎项置灰）。 */
  flash: boolean
}

export type SettingsWriteFailure =
  | 'forbidden-sender'
  | 'invalid-setting'
  | 'settings-save-failed'
  | 'storage-unavailable'

export type SettingsWriteResult =
  | { ok: true; snapshot: SettingsSnapshot }
  | { ok: false; code: SettingsWriteFailure }

export interface SettingsBridge {
  read(): Promise<SettingsSnapshot | undefined>
  write(key: SettingKey, value: SettingValue[SettingKey]): Promise<SettingsWriteResult>
  flashStatus(): Promise<FlashPluginState | undefined>
  flashImport(): Promise<FlashImportResult>
  /** 在文件管理器里定位当前插件；没有真实文件时返回 false。 */
  flashReveal(): Promise<boolean>
  subscribe(listener: (snapshot: SettingsSnapshot) => void): () => void
}
