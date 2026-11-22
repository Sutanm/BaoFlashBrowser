import type { ShellTheme } from './shell-theme'
import type { BrowserEngine, EngineSource } from './engine'

export const TAB_BAR_HEIGHT = 40
export const TOOLBAR_HEIGHT = 44

export const browserChannels = {
  command: 'browser:command',
  changed: 'browser:changed'
} as const

export type BrowserCommand =
  | { type: 'snapshot' | 'add' | 'back' | 'forward' | 'reload' | 'undo-close' | 'remember-engine' | 'forget-engine' }
  | { type: 'select' | 'close'; id: number }
  | { type: 'navigate'; address: string }
  /** 标签排序（架构 §3「排序」）：把 `id` 移到 `index`。 */
  | { type: 'move'; id: number; index: number }
  /** 把标签拖出窗口：`screenX/screenY` 是释放点的屏幕坐标（架构 §3「拖出窗口」）。 */
  | { type: 'tearoff'; id: number; screenX: number; screenY: number }
  /** 引擎切换（架构 §3 引擎）：用新 WebContents 重建标签并恢复导航栈。 */
  | { type: 'set-engine'; engine: BrowserEngine }

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
  'no-site': '当前页面没有可记忆的站点'
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
}

export interface BrowserState {
  revision: number
  theme: ShellTheme
  activeId: number
  /** 可撤销关闭的标签数量（架构 §3「撤销关闭」）。 */
  undoCount: number
  tabs: BrowserTab[]
}

export type BrowserResult =
  | { ok: true; state: BrowserState }
  | { ok: false; code: BrowserFailureCode; message: string }

export interface BrowserBridge {
  run(command: BrowserCommand): Promise<BrowserResult>
  subscribe(listener: (state: BrowserState) => void): () => void
}
