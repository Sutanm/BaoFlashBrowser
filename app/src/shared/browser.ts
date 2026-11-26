import type { ShellTheme } from './shell-theme'
import type { BookmarkNode } from './bookmarks'
import type { BrowserEngine, EngineSource } from './engine'
import type { Locale, SettingKey, SettingValue, Settings, ThemeMode } from './settings'

/**
 * 外壳三行 chrome 的固定高度（页面视图的 y 偏移由它们算出来）。
 *
 * 数值照抄 Chromium 142 的布局常量（**非触摸**档，`chrome/browser/ui/layout_constants.cc`）：
 * - 标签栏 = `TAB_STRIP_HEIGHT` = `TAB_HEIGHT(34) + TABSTRIP_TOOLBAR_OVERLAP(1)` + `TAB_STRIP_PADDING(6)` = **41**；
 * - 工具栏 = `max(location_bar, back) + TOOLBAR_INTERIOR_MARGIN.vertical()(6×2)` = 34 + 12 = **46**
 *   （`ToolbarView::CalculatePreferredSize`，`toolbar_view.cc:765`）；
 * - 收藏夹横条 = `BOOKMARK_BAR_BUTTON_HEIGHT(28) + 6`（居中留白）= **34**。
 *
 * 2026-11-26 反馈"地址栏/工具栏高度差几像素、标签页没有正常浏览器宽"：我们原来是 40 / 44 / 32、
 * 标签宽 180；Chromium 是 41 / 46 / 34，标签**标准宽 256**（`kTabWidth(232) + 2×12` 底角，
 * `chrome/browser/ui/tabs/tab_style.cc:31`）。三行都按 Chromium 走，页面视图因此下移 3px。
 */
export const TAB_BAR_HEIGHT = 41
export const TOOLBAR_HEIGHT = 46
/** 崩溃恢复提示条的高度（只在外壳顶部显示，页面视图相应下移）。 */
export const INFOBAR_HEIGHT = 36
/** 收藏夹横条的高度（显示与否见 `showsBookmarkBar()`）。 */
export const BOOKMARK_BAR_HEIGHT = 34

export const browserChannels = {
  command: 'browser:command',
  changed: 'browser:changed'
} as const

export type BrowserCommand =
  | { type: 'snapshot' | 'add' | 'back' | 'forward' | 'reload' | 'undo-close' | 'remember-engine' | 'forget-engine' }
  /** 打开（或切到已存在的）设置标签页（`bao://settings`，Edge 语义）。 */
  | { type: 'open-settings' }
  /**
   * 崩溃恢复提示的两个回答（Chrome 的「恢复页面」气泡语义）：
   * 上次没有走正常退出路径时，重启只显示气泡，**用户点「恢复」才真的恢复**。
   *
   * 正常路径由气泡的 `close-bubble`（叠加层通道）回答；这两个命令是同一语义的直接入口
   * （命令通道，测试/脚本用），两者最终走同一对函数。
   */
  | { type: 'restore-session' | 'dismiss-session' }
  | { type: 'select' | 'close'; id: number }
  /** 标签操作（架构 §3）：复制、固定/取消固定、静音/取消静音，以及右键菜单。 */
  | { type: 'duplicate' | 'pin' | 'mute' | 'tab-menu'; id: number }
  | { type: 'keep-awake'; id: number; value: boolean }
  | { type: 'navigate'; address: string }
  /**
   * 标签排序（架构 §3「排序」）：把 `id` 移到 `index`。
   *
   * `index` 是**移除被拖项之后**的最终索引（`0..tabs.length-1`）。渲染层按"含被拖项"的
   * 插槽算落点，发 IPC 前必须先换算，否则向右拖会偏一位。
   */
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
  | { type: 'set-setting'; key: SettingKey; value: SettingValue[SettingKey] }
  /**
   * 收藏当前页（地址栏星标）。**主进程自己取当前标签的地址与标题**，界面不传：
   * 星标是浏览器的动作（Chromium 的 `BookmarkCurrentTab` → `AddIfNotBookmarked`），
   * 不该变成"界面把一个地址塞进库"。
   *
   * 幂等：这个地址已经收藏过就什么都不做（Chromium 的 `IsBookmarkedByUser` 判定），
   * 所以"点星标 → 展开气泡"这条路径重复点也不会攒出重复条目。
   */
  | { type: 'bookmark-page' }
  /** 改写一条收藏的名称 / 地址 / 所在文件夹（编辑气泡与完整编辑器共用）。三者都可省略。 */
  | { type: 'update-bookmark'; id: string; title?: string; url?: string; parentId?: string }
  /**
   * 新建一个文件夹（完整编辑器里的「新建文件夹」）。
   *
   * `parentId` 可以是任一文件夹（两个永久根或已有文件夹）；校验与 `addBookmark` 同一处，
   * 所以"放进网址节点下面"这类非法父节点会返回 `bookmark-save-failed` 而不是写坏数据。
   */
  | { type: 'create-bookmark-folder'; title: string; parentId?: string }
  /** 删除一条收藏（编辑气泡的「删除」、收藏夹面板每行的 ×）。删除是幂等的。 */
  | { type: 'remove-bookmark'; id: string }
  /**
   * 打开一条收藏：主进程按 id 从库里取地址再导航当前标签。
   *
   * 为什么不让界面直接把地址交给 `navigate`：那样"收藏夹面板"就等于拿到了任意导航能力；
   * 按 id 取地址时，能被导航的只可能是用户自己收藏过的东西。
   */
  | { type: 'open-bookmark'; id: string }
  /**
   * 打开收藏夹管理页（`bao://favorites`）。
   *
   * 入口有三个：工具栏/横条的空态提示、横条的右键菜单、收藏夹飞窗底部的「管理收藏夹」。
   * 主进程按**单例内部页**处理它（已有就切过去、当前是新标签页就地覆盖），
   * 与「打开设置」同一条规则。
   */
  | { type: 'open-favorites' }
  /**
   * 记录收藏夹树的展开状态（用户点了某个箭头）。
   *
   * 为什么由外壳/管理页分别发、存在库里而不是各存各的：收藏夹是进程级数据，"上次展开了
   * 哪几个文件夹"是用户对收藏夹的心智模型，不该按界面各存一份（2026-11-27 反馈）。
   */
  | { type: 'set-bookmarks-expanded'; ids: string[] }
  /**
   * 收藏夹横条的右键菜单（Chromium 的 `BookmarkBarView::ShowContextMenu`）。
   *
   * 菜单是**原生**的（`Menu.popup`）：它是系统控件，不是我们要重画的一套 UI；而且
   * 「显示收藏夹栏」这个三档开关必须有除了设置页之外的第二个入口——横条自己身上。
   */
  | { type: 'bookmark-bar-menu' }

/** 稳定错误代码。渲染层按代码取文案，主进程只附加允许公开的详情。 */
export type BrowserFailureCode =
  | 'forbidden-sender'
  | 'invalid-command'
  | 'unknown-tab'
  | 'invalid-address'
  | 'window-closed'
  | 'tearoff-failed'
  | 'tearoff-source-closed'
  | 'tearoff-page-lost'
  | 'nothing-to-undo'
  | 'engine-switch-failed'
  | 'engine-switch-cancelled'
  | 'engine-unavailable'
  | 'site-rule-save-failed'
  | 'no-site'
  | 'invalid-setting'
  | 'settings-save-failed'
  | 'bookmark-save-failed'
  | 'bookmark-missing'
  /** 放不下：拖进了自己的子孙、或目标不是文件夹（`checkPlacement()` 的判定结果）。 */
  | 'bookmark-placement'
  | 'storage-unavailable'
  | 'no-session'
  /** 统一能力层拒绝（A1-c）：详情看调用记录里的稳定码，界面只显示一句通用文案。 */
  | 'capability-denied'

export const browserFailureText: Record<BrowserFailureCode, string> = {
  'forbidden-sender': '当前页面无法操作浏览器外壳',
  'invalid-command': '无效的浏览器命令',
  'unknown-tab': '此标签页已关闭',
  'invalid-address': '请输入有效的 HTTP 或 HTTPS 网址',
  'window-closed': '窗口已关闭',
  'tearoff-failed': '无法在新窗口打开此标签页，已退回原窗口',
  'tearoff-source-closed': '新窗口未能创建，原窗口已关闭，标签已关闭',
  'tearoff-page-lost': '新窗口未能创建，标签页面已失效，标签已关闭',
  'nothing-to-undo': '没有可恢复的标签页',
  'engine-switch-failed': '引擎切换失败，已保留原引擎与原视图',
  'engine-switch-cancelled': '引擎切换已取消，未提交任何变更',
  'engine-unavailable': '原生 Flash 不可用，仍使用当前引擎',
  'site-rule-save-failed': '无法保存站点规则，原有设置未更改',
  'no-site': '当前页面没有可记忆的站点',
  'invalid-setting': '无效的设置项',
  'settings-save-failed': '设置未能保存，已保留原值',
  'bookmark-save-failed': '收藏未能保存，原有收藏未更改',
  'bookmark-missing': '这条收藏已不存在',
  'bookmark-placement': '不能把文件夹移到它自己或它的子文件夹里',
  'storage-unavailable': '设置存储不可用，本次无法保存',
  'no-session': '没有可恢复的上次会话',
  'capability-denied': '该操作被浏览器能力层拒绝'
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
  /**
   * 正在切向的引擎：两阶段切换的候选**已挂载并在加载**，但尚未提交。
   *
   * 只在切换过程中出现；`engine` 仍是被替换的那个（提交成功才更新）。界面用它给出
   * 「正在切换到 X」的回执，不必知道候选视图、代际与超时这些实现细节。
   */
  pendingEngine?: BrowserEngine
  engineSource: EngineSource
  /** 当前站点已记住的引擎（无规则时为空）。用于区分「规则存在但被手动覆盖」。 */
  pinnedEngine?: BrowserEngine
  /** 固定标签：排在最左、只显示站点图标、无关闭按钮（架构 §3「标签操作」）。 */
  pinned: boolean
  /** 页面音频是否被静音。 */
  muted: boolean
  /**
   * 内部页（`bao://newtab` / `bao://settings` / `bao://favorites`）：没有引擎、站点规则与页面权限。
   * 三种内部页同会话、不同 origin，所以「打开设置/收藏夹」可以覆盖当前的新标签页。
   */
  internal?: 'newtab' | 'settings' | 'favorites'
  /** 已休眠（视图被丢弃）：切回时重建并重新加载。 */
  discarded?: boolean
  /** 用户标记「保持活跃」：挂机/游戏标签，永不自动休眠。 */
  keepAwake?: boolean
  /**
   * 站点图标（`data:` URL）。没有就是没有——界面退回通用页形图标，不画占位方块。
   *
   * 为什么是 data URL 而不是图标地址：渲染层拿不到能发网络请求的会话（页面 preload 只暴露
   * 窄桥），把图标抓到主进程再内联，标签栏就不用为一行图标开一条 HTTP 通道。
   */
  favicon?: string
}

/**
 * 崩溃恢复提示（Chrome 的「恢复页面」气泡）。
 *
 * 只有**上次没有正常退出**且确实存有会话时才出现；正常退出后重启一律是新标签页，
 * 不打扰用户。出现时是工具栏最右那颗按钮下的**警示气泡**（叠加层视图，见
 * `docs/reports/2026-11-26-session-bubble.md`），不占布局高度、不推页面；
 * 恢复动作必须由用户显式点击触发。
 */
export interface BrowserSessionPrompt {
  /** 可恢复的标签数量（跨上次所有窗口）。 */
  tabs: number
  /** 那份会话的写入时刻（毫秒），用于文案与诊断。 */
  savedAt: number
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
  /** 崩溃恢复提示；用户回答（恢复/忽略）后消失。 */
  sessionPrompt?: BrowserSessionPrompt
  /**
   * 收藏夹全量投影（两个永久根 + 全部节点，顺序由 `position` 决定）。
   *
   * 为什么跟着每次状态广播走，而不是单开一条通道：外壳星标要**立刻**知道"当前页有没有
   * 收藏过"，收藏夹面板要立刻看到新增/删除的结果，两处都吃这份数据；节点是几百条量级的
   * 平面对象，跟着广播走的代价远小于再维护一条订阅生命周期（多一条通道就多一处可能不同步）。
   */
  bookmarks: BookmarkNode[]
  /**
   * 收藏夹横条此刻该不该占位置。
   *
   * 为什么是主进程算好的布尔、而不是让外壳拿 `settings.bookmarkBar` 和 `active.internal`
   * 自己算：这条判定还带着**时序**（导航途中要按住，见 `Tab.barHold`），而时序只有主进程
   * 知道。外壳只负责画，判定留在 `main` 的 `bookmarkBarShown()` 一处，规则本体仍是
   * `shared/bookmarks.ts` 的 `showsBookmarkBar()`。
   */
  bookmarkBarShown: boolean
  /**
   * 收藏夹树的展开状态（用户点箭头的文件夹 id，已按现有节点过滤）。
   *
   * 收藏夹是进程级数据，这条同样是"所有窗口一份"：飞窗与 `bao://favorites` 管理页共用，
   * 存在库的 `meta` 表里。`undefined` = 从来没记录过，界面用自己的默认展开集
   * （飞窗默认全收起、管理页默认展开两个根）。
   */
  bookmarksExpanded?: string[]
  /**
   * 有图标的站点：`origin → data URL`（收藏夹横条/面板按书签地址查这张表）。
   *
   * 只放真的拿到的那些——查不到就是查不到，界面画通用页形，不画占位方块。
   * 为什么按 origin：书签存的是完整地址，图标是站点级的（`https://a.com/x` 与 `https://a.com/y`
   * 共用一个图标，抓两次没有意义）。
   */
  favicons: Record<string, string>
  tabs: BrowserTab[]
}

export type BrowserResult =
  | { ok: true; state: BrowserState }
  | { ok: false; code: BrowserFailureCode; message: string }

export interface BrowserBridge {
  run(command: BrowserCommand): Promise<BrowserResult>
  subscribe(listener: (state: BrowserState) => void): () => void
}
