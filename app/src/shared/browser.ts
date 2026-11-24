import type { ShellTheme } from './shell-theme'
import type { BrowserEngine, EngineSource } from './engine'
import type { Locale, SettingKey, Settings, ThemeMode } from './settings'

export const TAB_BAR_HEIGHT = 40
export const TOOLBAR_HEIGHT = 44

export const browserChannels = {
  command: 'browser:command',
  changed: 'browser:changed'
} as const

export type BrowserCommand =
  | { type: 'snapshot' | 'add' | 'back' | 'forward' | 'reload' | 'undo-close' | 'remember-engine' | 'forget-engine' }
  /** 打开（或切到已存在的）设置标签页（`bao://settings`，Edge 语义）。 */
  | { type: 'open-settings' }
  | { type: 'select' | 'close'; id: number }
  /** 标签操作（架构 §3）：复制、固定/取消固定、静音/取消静音，以及右键菜单。 */
  | { type: 'duplicate' | 'pin' | 'mute' | 'tab-menu'; id: number }
  | { type: 'keep-awake'; id: number; value: boolean }
  | { type: 'navigate'; address: string }
  /** 标签排序（架构 §3「排序」）：把 `id` 移到 `index`。 */
  | { type: 'move'; id: number; index: number }
  /** 把标签拖出窗口：`screenX/screenY` 是释放点的屏幕坐标（架构 §3「拖出窗口」）。 */
  | { type: 'tearoff'; id: number; screenX: number; screenY: number }
  /** 引擎切换（架构 §3 引擎）：用新 WebContents 重建标签并恢复导航栈。 */
  | { type: 'set-engine'; engine: BrowserEngine }
  /**
   * 写入一条设置（架构 §4 数据：主进程持业务权威）。
   *
   * 只有外壳（以及后续的设置页）能发；页面永远拿不到这个命令。值由主进程按
   * `shared/settings.ts` 的键白名单再校验一次，非法值返回 `invalid-setting`。
   */
  | { type: 'set-setting'; key: SettingKey; value: ThemeMode | BrowserEngine | Locale }

/** 稳定错误代码。渲染层按代码取文案，主进程只附加允许公开的详情。 */
export type BrowserFailureCode =
  | 'forbidden-sender'
  | 'invalid-command'
  | 'unknown-tab'
  | 'invalid-address'
  | 'window-closed'
  | 'tearoff-failed'
  | 'nothing-to-undo'
  | 'engine-switch-failed'
  | 'engine-unavailable'
  | 'site-rule-save-failed'
  | 'no-site'
  | 'invalid-setting'
  | 'settings-save-failed'
  | 'storage-unavailable'

export const browserFailureText: Record<BrowserFailureCode, string> = {
  'forbidden-sender': '当前页面无法操作浏览器外壳',
  'invalid-command': '无效的浏览器命令',
  'unknown-tab': '此标签页已关闭',
  'invalid-address': '请输入有效的 HTTP 或 HTTPS 网址',
  'window-closed': '窗口已关闭',
  'tearoff-failed': '无法在新窗口打开此标签页，已退回原窗口',
  'nothing-to-undo': '没有可恢复的标签页',
  'engine-switch-failed': '引擎切换失败，已保留原引擎与页面',
  'engine-unavailable': '原生 Flash 不可用，仍使用当前引擎',
  'site-rule-save-failed': '无法保存站点规则，原有设置未更改',
  'no-site': '当前页面没有可记忆的站点',
  'invalid-setting': '无效的设置项',
  'settings-save-failed': '设置未能保存，已保留原值',
  'storage-unavailable': '设置存储不可用，本次无法保存'
}

export interface BrowserTab {
  id: number
  title: string
  address: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  /** 渲染进程已崩溃或已销毁，需要重建 WebContents 才能继续。 */
  crashed: boolean
  error: string
  /** 瞬态操作警告（例如引擎切换后没能恢复完整导航历史）。 */
  notice?: { id: number; message: string }
  /** 当前标签使用的引擎与其来源（默认 / 站点规则 / 手动切换）。 */
  engine: BrowserEngine
  engineSource: EngineSource
  /** 当前站点已记住的引擎（无规则时为空）。用于区分「规则存在但被手动覆盖」。 */
  pinnedEngine?: BrowserEngine
  /** 固定标签：排在最左、只显示站点图标、无关闭按钮（架构 §3「标签操作」）。 */
  pinned: boolean
  /** 页面音频是否被静音。 */
  muted: boolean
  /**
   * 内部页（`bao://newtab` / `bao://settings`）：没有引擎、站点规则与页面权限。
   * 两种内部页同会话、不同 origin，所以「打开设置」可以覆盖当前的新标签页。
   */
  internal?: 'newtab' | 'settings'
  /** 已休眠（视图被丢弃）：切回时重建并重新加载。 */
  discarded?: boolean
  /** 用户标记「保持活跃」：挂机/游戏标签，永不自动休眠。 */
  keepAwake?: boolean
}

export interface BrowserState {
  revision: number
  theme: ShellTheme
  /** 用户选择的主题模式（`theme` 是它按系统状态解析后的结果）。 */
  settings: Settings
  activeId: number
  /** 可撤销关闭的标签数量（架构 §3「撤销关闭」）。 */
  undoCount: number
  /** 原生 Flash 插件是否可用（BYOP：本项目不随包分发，用户自备插件后才为 true）。 */
  flash: boolean
  /** 未检测到插件时应放置的路径，用于界面提示。 */
  flashHint?: string
  tabs: BrowserTab[]
}

export type BrowserResult =
  | { ok: true; state: BrowserState }
  | { ok: false; code: BrowserFailureCode; message: string }

export interface BrowserBridge {
  run(command: BrowserCommand): Promise<BrowserResult>
  subscribe(listener: (state: BrowserState) => void): () => void
}
