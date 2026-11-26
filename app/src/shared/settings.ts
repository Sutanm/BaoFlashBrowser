import { isBookmarkBarMode } from './bookmarks'
import type { BookmarkBarMode } from './bookmarks'
import { isBrowserEngine } from './engine'
import type { BrowserEngine } from './engine'
import { DEFAULT_SEARCH_ENGINE, isSearchEngine } from './search'
import type { SearchEngine } from './search'

/**
 * 设置模型（架构 §4 数据：主进程持业务权威，渲染层只拿投影）。
 *
 * 为什么设置项要有类型化编解码而不是原样存 JSON：设置是**全局副作用**（主题会改
 * nativeTheme、默认引擎会改新标签行为），非法值必须在进库前就被拒绝，不能等用的
 * 时候再兜。这里的 `sanitizeSetting()` 是唯一校验点，主进程不信任渲染层传来的值。
 */
export const DISCARD_MODES = ['auto', 'never'] as const
export type DiscardMode = (typeof DISCARD_MODES)[number]

/**
 * 启动时的标签行为（Chrome 的 `On startup`）。
 *
 * - `newtab`（默认）：正常退出后重启只开新标签页；异常退出才提示「恢复标签页」，由用户决定；
 * - `continue`：每次都恢复上次退出时的标签（`Continue where you left off`）。
 */
export const SESSION_STARTUP_MODES = ['newtab', 'continue'] as const
export type SessionStartupMode = (typeof SESSION_STARTUP_MODES)[number]

/**
 * 预热档位。**只有两档**（2026-11-26 收敛，由三档改为开关）：
 *
 * - `always`（默认）：窗口创建即准备好飞窗文档，第一次打开就是热的；
 * - `never`：不提前创建，用到才建。
 *
 * 曾经还有中间档 `auto`（悬停 180 ms 预热 + 空闲 5 分钟回收）：它省下的就是这 5–9 MB，
 * 却要养一套悬停意图/主进程闸门/空闲回收定时器/切档特判，外加一类真 bug（180 ms 排队期间
 * 策略变了，定时器把刚退役的文档又开回来，2026-11-26 审计）。飞窗寄居外壳渲染进程之后，
 * 常驻每窗口只值 5–9 MB 且不新增渲染进程，中间档的性价比不成立，于是删掉。
 *
 * 老库里残留的 `auto` 不需要迁移脚本：`settingsFromRows()` 逐行丢弃未知取值，
 * 于是它自然回落到默认档（= 开）。
 */
export const PREWARM_MODES = ['always', 'never'] as const
export type PrewarmMode = (typeof PREWARM_MODES)[number]

export const THEME_MODES = ['system', 'light', 'dark'] as const
export type ThemeMode = (typeof THEME_MODES)[number]

export type Locale = 'zh-CN'

/** 用户可见设置的形状（键值平铺，便于投影与持久化对齐）。 */
export interface Settings {
  /**
   * 飞窗预热：always=窗口创建即准备好叠加层文档（默认；共享进程下每窗口约 5–9 MB，
   * 不新增渲染进程）；never=不提前创建，首次打开时再建。
   *
   * 默认曾是 `auto`（悬停预热 + 空闲回收）：那时"常驻"要独占一个渲染进程（+90–110 MB），很贵。
   * 浮层寄居外壳渲染进程之后常驻只值 5–9 MB、不多一个进程，于是 2026-11-25 反转默认、
   * 2026-11-26 把中间档 `auto` 一并删掉（见 `PREWARM_MODES` 的说明）。
   */
  overlayPrewarm: PrewarmMode
  /** 后台标签休眠：auto=后台超过 TTL 丢弃视图（切回重新加载）；never=从不丢弃（挂机场景）。 */
  tabDiscard: DiscardMode
  /** 启动行为：newtab=正常退出后重启开新标签页（崩溃才提示恢复）；continue=总是恢复上次会话。 */
  sessionStartup: SessionStartupMode
  themeMode: ThemeMode
  /** 新标签/新站点的默认引擎；站点规则与手动切换优先于它。 */
  defaultEngine: BrowserEngine
  /**
   * 默认搜索引擎：地址栏与新标签页 realbox 里**不像地址**的输入按它搜索。
   *
   * 「像地址」的判据只在 `shared/search.ts` 的 `looksLikeAddress()` 一处，设置项只决定
   * 用哪家引擎把关键词拼成 URL（见 `shared/search.ts` 的 `searchUrlFor()`）。
   */
  searchEngine: SearchEngine
  /**
   * 收藏夹横条（工具栏下面那第三行）：always=始终显示、ntp=只在新标签页显示（默认）、
   * never=不显示。
   *
   * 默认对齐全家桶的「只在新标签页显示」：横条白占 32px 高度，日常浏览时没有任何信息量，
   * 但它又是新标签页上「收藏了哪些常用站」的唯一入口。三档的取值见 `shared/bookmarks.ts`。
   */
  bookmarkBar: BookmarkBarMode
  locale: Locale
}

export const DEFAULT_SETTINGS: Settings = {
  // 常驻预热：共享进程下每窗口只值 +5–6 MB（且不多一个渲染进程），换来"第一次点开就是热的"。
  // 需要省内存的用户仍可在设置里选「自动（悬停预热）」或「不预热」。
  overlayPrewarm: 'always',
  tabDiscard: 'auto',
  // 默认对齐 Chrome：正常退出后重启是新标签页，只有崩溃才提示恢复。
  sessionStartup: 'newtab',
  themeMode: 'system',
  // 原生优先：M1 的默认值，改成设置项后保持同样的行为。
  defaultEngine: 'ppapi',
  searchEngine: DEFAULT_SEARCH_ENGINE,
  // 对齐全家桶的默认：横条只在新标签页上出现（见 `Settings.bookmarkBar`）。
  bookmarkBar: 'ntp',
  locale: 'zh-CN'
}

/** 数据库键 ↔ 设置字段的映射（表里一行一个键，便于迁移与增量）。 */
export const SETTING_COLUMNS = {
  'overlay.prewarm': 'overlayPrewarm',
  'tab.discard': 'tabDiscard',
  'session.startup': 'sessionStartup',
  'theme.mode': 'themeMode',
  'engine.default': 'defaultEngine',
  'search.engine': 'searchEngine',
  'bookmark.bar': 'bookmarkBar',
  locale: 'locale'
} as const

export type SettingKey = keyof typeof SETTING_COLUMNS
export type SettingColumn = (typeof SETTING_COLUMNS)[SettingKey]

/** 每个键的取值域（写入校验与投影共用同一张表）。 */
export type SettingValue = {
  'overlay.prewarm': PrewarmMode
  'tab.discard': DiscardMode
  'session.startup': SessionStartupMode
  'theme.mode': ThemeMode
  'engine.default': BrowserEngine
  'search.engine': SearchEngine
  'bookmark.bar': BookmarkBarMode
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
  value:
    | ThemeMode | BrowserEngine | Locale | PrewarmMode | DiscardMode | SessionStartupMode | SearchEngine
    | BookmarkBarMode
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

export function isSessionStartupMode(value: unknown): value is SessionStartupMode {
  return typeof value === 'string' && (SESSION_STARTUP_MODES as readonly string[]).includes(value)
}

export function sanitizeSetting(key: unknown, value: unknown): SanitizedSetting | undefined {
  if (key === 'tab.discard') return isDiscardMode(value) ? { key, value } : undefined
  if (key === 'session.startup') return isSessionStartupMode(value) ? { key, value } : undefined
  if (key === 'overlay.prewarm') return isPrewarmMode(value) ? { key, value } : undefined
  if (key === 'theme.mode') return isThemeMode(value) ? { key, value } : undefined
  if (key === 'engine.default') return isBrowserEngine(value) ? { key, value } : undefined
  if (key === 'search.engine') return isSearchEngine(value) ? { key, value } : undefined
  if (key === 'bookmark.bar') return isBookmarkBarMode(value) ? { key, value } : undefined
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

/**
 * 启动行为的选项文案。
 *
 * 刻意**不带括号说明**：这两档的区别在设置页里由单选项本身表达，
 * 括号补丁式解释只会让标签变长、扫描变慢（对齐 Chrome/Edge 的 `On startup` 写法）。
 * 细节（"崩溃后才提示恢复"）留给文档与报告，不进控件标签。
 */
export const sessionStartupLabels: Record<SessionStartupMode, string> = {
  newtab: '打开新标签页',
  continue: '打开上一个会话中的标签页'
}

/**
 * 开关右侧那一行「当前实际行为」。
 *
 * 为什么跟着开关状态变：静态一句「决定飞窗在使用前何时准备好」看不出**现在**到底会不会预热
 * （2026-11-26 反馈：库里存着 `auto`，用户以为默认是常驻却看到别的档位）。默认档的说明直接
 * 带上「默认」二字，不额外做徽标。
 */
export const prewarmModeSummaries: Record<PrewarmMode, string> = {
  always: '默认：窗口创建后即准备好飞窗，首次打开无需等待',
  never: '不提前创建，打开时再加载'
}

/** 开关的悬浮提示 / 读屏说明：开与关各自付什么、换什么。 */
export const prewarmToggleHint =
  '窗口创建后即准备好飞窗文档，首次打开无需等待；共享渲染进程下每窗口约增加 5–9 MB，不新增渲染进程。关闭后第一次打开要先创建文档，会慢一截。'

export const themeModeLabels: Record<ThemeMode, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色'
}

/**
 * 收藏夹横条的三档文案（Edge 的「显示收藏夹栏」子菜单同款措辞）。
 *
 * 用 `Record<BookmarkBarMode, …>` 把取值域钉住：档位改名时类型检查会红，
 * 不会出现"设置页少了「从不显示」"这种静默缺档。
 */
export const bookmarkBarModeLabels: Record<BookmarkBarMode, string> = {
  always: '始终显示',
  ntp: '仅在新标签页上显示',
  never: '从不显示'
}

/** 设置页那一行的副标题：说清三档各自付什么（为什么默认是"仅新标签页"）。 */
export const bookmarkBarHint = '横条在工具栏下方占一行，列出「收藏夹栏」文件夹里的网址。'

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
  /** 清除已保存的会话（分类清理的「会话」档，M2 存储清理）。 */
  sessionClear: 'settings:session-clear',
  /** 清除站点引擎规则（分类清理的「规则」档）。 */
  engineRulesClear: 'settings:engine-rules-clear',
  /**
   * 清除全部收藏夹内容（分类清理的「收藏」档）。
   *
   * 保留两个永久根（`bar` / `other`）与它们的位置：横条与面板都按这两个根渲染，
   * 连根一起删掉的话界面会变成"收藏夹栏不见了"，而不是"清空了"。
   */
  bookmarksClear: 'settings:bookmarks-clear',
  /**
   * 打开收藏夹管理页（`bao://favorites`）。
   *
   * 设置页里「外观 → 收藏夹栏」那张卡需要一个"去整理"的入口：三档只决定**显示不显示**，
   * 真正的整理在管理页（2026-11-27 反馈：设置面板里没有进收藏页的入口）。
   */
  openFavorites: 'settings:open-favorites',
  /** 忘记**某个站点**的引擎规则（设置页列表里的单行删除）。 */
  engineRuleForget: 'settings:engine-rule-forget',
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
  /**
   * 「关于」分区要显示的版本三元组。
   *
   * 为什么走快照而不是让页面自己问 `process.versions`：内部页的 preload 只暴露
   * `baoSettings`（拿不到 process/nodeIntegration），而这些值只有主进程知道。
   * 顺手把应用版本一起带上——`app.getVersion()` 在 main 里是一次调用，页面不必再开通道。
   */
  runtime: { app: string; electron: string; chromium: string }
  /**
   * 各站点「记住的引擎」（按 host 排序）。
   *
   * 为什么要放进快照：设置页原来只有 `clearEngineRules()` 一个动作，卡片里永远只有一个
   * 「全部清除」按钮——0 条时看不出是空的，有规则时也看不出是哪几个站点（2026-11-26 反馈）。
   * 列表 + 单条忘记（`forgetEngineRule`）之后，这张卡才像"能用的东西"。
   */
  engineRules: EngineRuleEntry[]
}

/** 一条站点引擎规则的展示投影。 */
export interface EngineRuleEntry {
  host: string
  engine: BrowserEngine
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
  /**
   * 清除已保存的会话（会话载荷 + 退出标记）。
   *
   * 返回 `true` 表示确实删掉了；清除后**本次运行不再记录会话**（否则节流写会在
   * 800 ms 后把当前标签又写回去），下次启动恢复记录能力。
   */
  clearSession(): Promise<boolean>
  /**
   * 清除站点引擎规则（「记住的引擎」）。
   *
   * 只删规则表，不动任何标签：已打开的标签保持当前引擎，重新计算来源后会显示为默认值。
   */
  clearEngineRules(): Promise<boolean>
  /**
   * 清除全部收藏夹内容（「数据」分区的第三档）。
   *
   * 只清内容、保留两个永久根；已打开的收藏夹管理页会跟着主进程的广播刷新，
   * 不需要页面自己重建。
   */
  clearBookmarks(): Promise<boolean>
  /**
   * 打开收藏夹管理页（`bao://favorites`），返回是否成功。
   *
   * 只做"打开"：页面里不导航、不拿任意地址能力，目标由主进程写死。
   */
  openFavorites(): Promise<boolean>
  /**
   * 忘记某个站点的引擎规则（设置页列表里的单行删除）。
   *
   * `host` 由主进程校验（非空、长度上限），不信任页面传值；只删这一条，
   * 已打开的标签不重载（与「全部清除」同一语义）。
   */
  forgetEngineRule(host: string): Promise<boolean>
  flashStatus(): Promise<FlashPluginState | undefined>
  flashImport(): Promise<FlashImportResult>
  /** 在文件管理器里定位当前插件；没有真实文件时返回 false。 */
  flashReveal(): Promise<boolean>
  subscribe(listener: (snapshot: SettingsSnapshot) => void): () => void
}
