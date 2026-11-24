import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, shell, WebContentsView } from 'electron'
import { backgroundSmoke as background, hiddenSmoke as hidden } from './automation'
import type { Input, IpcMainInvokeEvent, MenuItemConstructorOptions, NavigationEntry, Rectangle, WebContents } from 'electron'
import { join } from 'node:path'
import { browserChannels, browserFailureText, INFOBAR_HEIGHT, TAB_BAR_HEIGHT, TOOLBAR_HEIGHT } from '../shared/browser'
import type { BrowserCommand, BrowserFailureCode, BrowserResult, BrowserSessionPrompt, BrowserState, BrowserTab } from '../shared/browser'
import { hostOf } from '../shared/engine'
import { isSameSite, siteBoundary } from '../shared/site'
import type { BrowserEngine, EngineSource } from '../shared/engine'
import { getInternalSession, getPageSession, getShellSession } from './sessions'
import { bindRuffleProtocol } from './ruffle'
import { registerPageView } from './page-views'
import * as engineRules from './engine-rules'
import { setSetting, settings as currentSettings, saveSession, storageStatus } from './storage'
import { bindInternalProtocol, internalKindOf, internalUrls, isInternalUrl, isNewTabUrl, isSettingsUrl, parseInternalAddress, SETTINGS_URL } from './internal-pages'
import type { InternalKind } from './internal-pages'
import { settingsChannels } from '../shared/settings'
import type { SettingsSnapshot } from '../shared/settings'
import { ntpChannels } from '../shared/ntp'
import type { NtpCommand, NtpCommandResult, NtpSnapshot } from '../shared/ntp'
import { importFlashPlugin } from './flash-plugin'
import { flashLoadedPath, flashStatus } from './plugins'
import { windowPalette } from '../shared/shell-theme'
import type { ShellTheme } from '../shared/shell-theme'
import { overlayChannels } from '../shared/overlay'
import { createShellOverlays } from './shell-overlays'
import { attachPopupChrome } from './popup-chrome'
import { activityLeases } from './activity-lease'
import { SESSION_VERSION, sessionTabCount } from '../shared/session'
import type { SessionSnapshot, SessionTab, SessionWindow } from '../shared/session'

const windowIcon = process.platform === 'win32'
  ? join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'assets', 'next-icon.ico')
  : undefined

/**
 * 标签（架构 §3 主进程与窗口、页面）。
 *
 * `id` 是**全局**稳定业务 ID：跨窗口移动后不变，因此不能按窗口计数。
 * `host` 指向当前拥有该标签的窗口；事件回调只读取 `host`，跨窗口移动时无需重挂监听。
 * `binding` 是 WebContents 绑定代际，替换或销毁时递增，旧代际的迟到事件据此作废。
 */
interface Tab {
  id: number
  /** 休眠（丢弃）时为空：省掉一整个渲染进程，切回时按 lastUrl 重建。 */
  view?: WebContentsView
  binding: number
  error: string
  failedUrl?: string
  notice?: BrowserTab['notice']
  initialTitle: string
  /** 当前引擎；来源由 `sourceOf()` 按当前 URL 与站点规则**派生**，避免跨站导航后留下陈旧值。 */
  engine: BrowserEngine
  manualOverride: boolean
  /** 固定标签：排在最左、只显示站点图标、不显示关闭按钮（架构 §3「标签操作」）。 */
  pinned: boolean
  /** 音频静音状态：存在标签上，引擎切换与崩溃重建后要迁移到新 WebContents。 */
  muted: boolean
  /**
   * 内部页标记（架构 §3 外壳）：`newtab`（`bao://newtab`）或 `settings`（`bao://settings`）。
   * 两种内部页同会话、不同 origin，因此「设置覆盖新标签页」可以就地导航。
   * 内部页不参与引擎切换/站点规则/下载，也没有页面权限。
   */
  internal?: InternalKind
  /** 休眠状态：视图已销毁，切回时重建。 */
  discarded?: boolean
  // 「保持活跃」不是标签字段：它是 `user` owner 的无期限活动租约（`activityLeases`）。
  // `BrowserState.keepAwake` 由租约现算（见 `keptAwake()`），单一事实源在租约表里。
  /** 休眠时展示用的缓存（视图没了就读不到）。 */
  lastUrl?: string
  lastTitle?: string
  /**
   * 该标签的第一个文档是网页，但它是从新标签页进来的：在最早一条历史按 Back 时回到
   * `bao://newtab`（Chrome 里 NTP 就是历史第 0 项）。
   *
   * 为什么用标记而不是把 NTP 塞进历史：从新标签页进入网页要换 WebContents（内部会话
   * 永不承载 http(s)，见 `leaveNewTab`），NTP 那条历史项留不下来。标记 + 重建 NTP 视图
   * 是等效的替代，代价是页面状态随 Back 丢失（Forward 重新加载）。
   */
  fromNewTab?: boolean
  /** 从新标签页 Back 回来后，Forward 要重开的网页地址。 */
  newTabForwardUrl?: string
  /** 进入后台的时刻（毫秒），用于 TTL 判定。 */
  backgroundSince?: number
  host?: TabHost
}

interface TabHost {
  notify(tab: Tab): void
  /** 按事件所属标签处理快捷键：跨窗移交后由新宿主处理（2026-11-23 审计 P1-4）。 */
  shortcut(tab: Tab, input: Input): boolean
}

interface WindowController extends TabHost {
  readonly shellUrl: string
  readonly flash: boolean
  snapshot(): BrowserState
  run(event: IpcMainInvokeEvent, command: BrowserCommand): BrowserResult | Promise<BrowserResult>
  readonly overlays: ReturnType<typeof createShellOverlays>
  detachTab(id: number): { tab: Tab; index: number } | undefined
  adoptTab(tab: Tab, index?: number): void
  isEmpty(): boolean
  /** 按事件所属标签处理快捷键：跨窗移交后由新宿主处理（2026-11-23 审计 P1-4）。 */
  shortcut(tab: Tab, input: Input): boolean
  bounds(): Rectangle
  closeWindow(): void
  /** 设置变化后重绘：标题栏 overlay 重新着色 + 重新投影（主题/默认引擎可能都变了）。 */
  refreshSettings(): void
  /** 设置变化后推给本窗口的内部页（`bao://settings` 用独立通道）。 */
  broadcastSettings(): void
  /** 该 WebContents 是否属于本窗口的标签（含内部页）。 */
  ownsContents(contentsId: number): boolean
  /** 内部设置页的可信判定：本窗口标签 ∧ 主帧 ∧ 文档 URL ∈ bao://settings/*。 */
  internalSender(event: IpcMainInvokeEvent): boolean
  /** 内部页读到的设置快照（含解析后的亮/暗）。 */
  internalSnapshot(): SettingsSnapshot
  /** 新标签页的可信判定：本窗口标签 ∧ 主帧 ∧ 文档 URL ∈ bao://newtab/*。 */
  ntpSender(event: IpcMainInvokeEvent): boolean
  /** 新标签页读到的状态（主题 + 设置子集 + 插件可用性）。 */
  ntpSnapshot(): NtpSnapshot
  /** 新标签页的两个动词：打开设置、在**本标签**导航。 */
  runNtp(event: IpcMainInvokeEvent, command: NtpCommand): NtpCommandResult
}

export interface BrowserWindowOptions {
  shellUrl: string
  /** 页面视图启用 PPAPI 插件（架构 §3 引擎）。 */
  flash?: boolean
  /** 未检测到插件时的期望路径（用于界面提示）。 */
  flashHint?: string
  /** 接管一个已存在的标签（跨窗口移动）。 */
  adopt?: Tab
  /** 首个标签打开的地址（命令行参数）。 */
  initialAddress?: string
  /**
   * 崩溃恢复：上次没有正常退出时留下的会话。
   *
   * 传进来只是**挂起**，窗口不会自动恢复——外壳顶部显示提示条，等用户点
   * 「恢复标签页」才真的把标签建出来（Chrome 的「恢复页面」气泡语义）。
   * 未决定之前会话不写盘，否则 800 ms 后的一次自动保存就会把待恢复的会话覆盖掉。
   */
  crashSession?: SessionSnapshot
  /**
   * 启动即恢复的会话：设置项 `session.startup = continue` 时由 `index.ts` 传入。
   *
   * 与 `crashSession` 互斥——这是用户主动选择的「继续上次会话」，不需要再问一次。
   */
  initialSession?: SessionSnapshot
  adoptIndex?: number
  x?: number
  y?: number
  width?: number
  height?: number
}

const TAB_LOAD_FAILED = '页面加载失败'
const TAB_CRASHED = '页面已停止响应，点击重新加载恢复'
/** 撤销关闭的保留条目数（架构 §3「撤销关闭」；只留导航栈，不留进程）。 */
const CLOSED_TAB_LIMIT = 10

/** 关闭标签时保留的恢复数据：E39 的 `getAllEntries()/restore()` 导航栈，以及引擎。 */
interface ClosedTab {
  entries: NavigationEntry[]
  index: number
  engine: BrowserEngine
  manualOverride: boolean
  /** 内部页也要能撤销关闭（语义同 Chrome：恢复的是同一个页，不是新标签）。 */
  internal?: InternalKind
  /** 从新标签页进入的网页标签：恢复后仍要能按 Back 回 NTP。 */
  fromNewTab?: boolean
  /** 休眠标签没有导航栈：记下地址，撤销关闭时按它重建（而不是开一个空白标签）。 */
  lastUrl?: string
}

const controllers = new Map<number, WindowController>()
/** 全局标签 ID 序列：跨窗口唯一（架构 §3「每个标签有稳定业务 ID」）。 */
let nextTabId = 1
let nextNoticeId = 1

/* ------------------------------------------------------------------ *
 * 会话恢复（M2）：每个窗口把自己的标签投影登记到这张表，节流后整份写入业务库。
 *
 * 为什么表在模块级而不是窗口内：会话是**进程级**数据（一次启动的多个窗口要一起写），
 * 而窗口会在退出过程中一个个销毁——表跟着窗口走，最后一个窗口关闭时就写不出完整会话了。
 * ------------------------------------------------------------------ */

/** 写盘节流：标题/加载状态会高频变化，但会话只需"最近的样子"。 */
const SESSION_SAVE_DEBOUNCE_MS = 800

const sessionWindows = new Map<number, SessionWindow>()
let sessionTimer: ReturnType<typeof setTimeout> | undefined
/** 退出中：此时窗口接连关闭，会话按"关闭前的样子"保留，不再逐个窗口删除。 */
let sessionQuitting = false
/**
 * 崩溃会话还没被用户回答（恢复/忽略）时为 true：这期间**不写盘**。
 *
 * 不挂起的话，启动后第一次 `publish()` 的 800 ms 节流写就会用"空白新标签页"覆盖掉
 * 待恢复的会话——提示条还在，内容已经没了。
 */
let sessionHeld = false

function writeSessionNow(): void {
  if (sessionTimer) {
    clearTimeout(sessionTimer)
    sessionTimer = undefined
  }
  // 挂起期间一个字节都不写：磁盘上那份崩溃会话是用户接下来可能恢复的唯一来源。
  if (sessionHeld) return
  const snapshot: SessionSnapshot = {
    version: SESSION_VERSION,
    savedAt: Date.now(),
    windows: [...sessionWindows.values()]
  }
  // 没有窗口（例如刚启动就被关闭的自动化窗口）时不写：写入空会话等于把上次的会话清掉。
  if (snapshot.windows.length === 0) return
  saveSession(snapshot)
}

/** 登记某个窗口的最新投影，并按节流写盘。 */
function scheduleSessionSave(shellContentsId: number, snapshot: SessionWindow): void {
  sessionWindows.set(shellContentsId, snapshot)
  if (sessionQuitting || sessionHeld || sessionTimer) return
  sessionTimer = setTimeout(() => {
    sessionTimer = undefined
    if (!sessionQuitting) writeSessionNow()
  }, SESSION_SAVE_DEBOUNCE_MS)
  sessionTimer.unref?.()
}

/**
 * 用户已经回答崩溃恢复提示：解除挂起，并把当前状态立刻写回（覆盖掉磁盘上的崩溃会话）。
 *
 * 立即写而不是等节流，是为了让"忽略"真的生效：下次启动不该再提示同一份会话。
 */
function releaseSessionHold(): void {
  if (!sessionHeld) return
  sessionHeld = false
  writeSessionNow()
}

/** 挂起会话写盘（`index.ts` 在把崩溃会话交给窗口之前调用）。 */
export function holdSession(): void {
  sessionHeld = true
}

/**
 * 立即写盘并在退出期间冻结会话（`index.ts` 在 `before-quit` 调用）。
 *
 * 冻结是必要的：随后的窗口 `closed` 会逐个到达，若那时仍按"窗口关闭即删除"处理，
 * 最终写出的会话会越来越少，用户重启后只能看到最后关闭的那个窗口。
 */
export function flushSession(): void {
  sessionQuitting = true
  writeSessionNow()
}

function fail(code: BrowserFailureCode): BrowserResult {
  return { ok: false, code, message: browserFailureText[code] }
}


/**
 * 解析 window.open 的 features（归档审计 P2：「弹窗窗口固定 1024×768」）。
 * 支持 width/height/left/top（含 screenx/screeny 别名），并夹到合理范围。
 */
function popupSize(details: { features?: string }): { width: number; height: number; x?: number; y?: number } {
  const features = details.features ?? ''
  const read = (name: string): number | undefined => {
    const match = new RegExp(`${name}\\s*=\\s*(\\d+)`, 'i').exec(features)
    return match ? Number(match[1]) : undefined
  }
  const width = Math.min(Math.max(read('width') ?? 1024, 320), 3840)
  const height = Math.min(Math.max(read('height') ?? 768, 240), 2160)
  const x = read('left') ?? read('screenx') ?? read('x')
  const y = read('top') ?? read('screeny') ?? read('y')
  return { width, height, x, y }
}

function isWebAddress(value: string): boolean {
  const url = URL.parse(value)
  return !!url && (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
}

/**
 * 判断标题是不是 Chromium 的「占位标题」（文档还没给出 `<title>` 时它等于 URL）。
 *
 * 内部页最容易撞上：标签一建好就有地址，标题先是 `bao://settings`（注意不带结尾斜杠），
 * 标签栏会闪一下地址。占位判定用「忽略结尾斜杠后相等」+「本身就是 bao: 地址」两条。
 */
function placeholderTitle(title: string, address: string): boolean {
  if (!title) return true
  if (/^bao:\/\//i.test(title)) return true
  const normalize = (value: string): string => value.replace(/\/+$/, '')
  return normalize(title) === normalize(address)
}
function parseAddress(input: string): string | undefined {
  const address = input.trim()
  if (!address || /\s/.test(address)) return
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(address)
  const hasPort = /^[^/:]+:\d+(?:[/?#]|$)/.test(address)
  const value = hasScheme && !hasPort ? address : `https://${address}`
  if (isWebAddress(value)) return new URL(value).href
}

function sameDocument(actual: string, expected: string): boolean {
  try {
    const left = new URL(actual)
    const right = new URL(expected)
    return left.protocol === right.protocol && left.host === right.host &&
      left.pathname.replace(/\/$/, '') === right.pathname.replace(/\/$/, '')
  } catch {
    return false
  }
}

/**
 * 站点近似（M1 用「注册域」的最后两段）。
 *
 * 4399 的启动链跨子域（`news.4399.com` → `my.4399.com`），按源严格比较会误拒；
 * 多段公共后缀（`co.uk` 等）与 IP 字面量的边界情况留待 M2 用 PSL 处理。
 */
function currentTheme(): ShellTheme {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/** 崩溃或销毁后的 WebContents 上部分读取会抛错，投影一律降级为默认值。 */
function safe<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}

/**
 * 每个窗口拥有自己的标签顺序、选中关系与 WebContents。
 * 关闭窗口时只释放该窗口拥有的资源，不触碰其它窗口（架构 §3 主进程与窗口）。
 */
export async function createBrowserWindow(options: BrowserWindowOptions): Promise<void> {
  const pageSession = getPageSession()
  // Ruffle 资源协议按页面会话绑定（每个会话一次）。
  bindRuffleProtocol(pageSession)
  // 内部页协议只绑内部会话（幂等）：页面会话里加载 `bao://` 会被直接拒绝。
  bindInternalProtocol(getInternalSession())
  const plugins = options.flash === true
  const shellUrl = options.shellUrl
  /**
   * 自动化窗口模式：跑冒烟时不显示或不激活原生窗口。
   *
   * 实测教训（2026-11-23）：`showInactive()` 之后再 `setPosition(-32000)` 不生效——
   * Windows 仍按创建时的默认位置摆放，窗口照旧出现在屏幕上。所以位置必须在
   * `BrowserWindow` 构造时就给定，并且再加一层 `setOpacity(0)`：窗口仍是"可见"状态
   * （渲染/合成不被节流，Ruffle 能出帧），但完全透明；同时跳过任务栏、禁用聚焦，
   * 并挂「被激活就 blur」的守卫。弹出窗口也要走同一套（否则它们照样弹出来）。
   */
  const placement = background
    ? { ...placeWindow(options), x: -32000, y: -32000 }
    : placeWindow(options)
  const window = new BrowserWindow({
    ...placement,
    // 自动化模式下窗口从**创建那一刻**就是透明且不进任务栏的：避免 show 的瞬间
    // 以 opacity 1 闪一下（实测：仅靠 showInactive 之后设 opacity 仍会短暂出现在屏幕上）。
    ...(background ? { opacity: 0 } : {}),
    ...(hidden || background ? { skipTaskbar: true, focusable: false } : {}),
    minWidth: 520,
    minHeight: 360,
    show: false,
    title: 'BaoFlashBrowser Next',
    icon: windowIcon,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      ...windowPalette[currentTheme()],
      height: TAB_BAR_HEIGHT
    },
    webPreferences: {
      session: getShellSession(),
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true
    }
  })

  const shellContentsId = window.webContents.id
  const overlays = createShellOverlays(window, shellUrl, sameDocument, (input) => (active ? handleShortcut(active, input) : false), currentTheme, () => !hidden && !background, () => currentSettings().overlayPrewarm)
  const tabs: Tab[] = []
  const recentlyClosed: ClosedTab[] = []
  let active: Tab | undefined
  let revision = 0
  let closing = false
  /** 崩溃会话：用户点「恢复」之前一直挂着，不自动建标签。 */
  let crashSession = options.crashSession

  /** 崩溃恢复提示条的投影；没有待决会话时为空（提示条随之消失，页面视图上移）。 */
  function sessionPromptOf(): BrowserSessionPrompt | undefined {
    if (!crashSession) return undefined
    const count = sessionTabCount(crashSession)
    if (count === 0) return undefined
    return { tabs: count, savedAt: crashSession.savedAt }
  }

  /** 站点规则决定初始引擎；插件不可用时回退到 Ruffle。 */
  function engineFor(address: string | undefined): { engine: BrowserEngine; source: EngineSource } {
    const resolved = engineRules.resolve(hostOf(address ?? ''))
    if (!plugins && resolved.engine === 'ppapi') return { engine: 'ruffle', source: resolved.source }
    return resolved
  }

  /**
   * 引擎来源**派生**值（架构 §3 引擎）。
   *
   * 2026-11-23 审计 P2：来源原来是存下来的快照，跨站导航时（引擎恰好没变）不会刷新，
   * 界面会显示上一个站点的来源。改成按「是否有手动覆盖 + 当前 URL 是否命中站点规则」
   * 现算，天然不会陈旧。
   */
  function sourceOf(tab: Tab): EngineSource {
    // 内部页没有站点概念：来源恒为默认（工具栏对它隐藏引擎胶囊）。
    if (tab.internal) return 'default'
    if (tab.manualOverride) return 'manual'
    const url = tab.failedUrl ?? tab.lastUrl ?? safe(() => tab.view?.webContents.getURL() ?? '', '')
    return engineRules.resolve(hostOf(url)).source
  }

  /** 用户「保持活跃」租约的显式 ID：同一标签重复标记是续租，不会叠加。 */
  function keepAwakeLeaseId(tab: Tab): string {
    return `keep-awake-${tab.id}`
  }

  /**
   * `BrowserState.keepAwake` 的**唯一来源**：该标签此刻是否持有有效的 `user` 租约。
   *
   * 界面语义不变（右键菜单勾选、标签栏的活跃标记），但数据不再存两份：
   * 用户标记 = `user` owner 的无期限 `preventsDiscard` 租约（架构 §7 规则 3）。
   */
  function keptAwake(tab: Tab): boolean {
    return activityLeases.hasOwner(tab.id, 'user')
  }

  function describe(tab: Tab): BrowserTab {
    // 休眠标签没有视图：用缓存字段展示（标题/地址），其它能力一律为假。
    if (!tab.view) {
      const address = tab.internal === 'newtab'
        ? ''
        : tab.internal === 'settings' ? (tab.lastUrl || SETTINGS_URL) : (tab.lastUrl ?? '')
      return {
        id: tab.id,
        title: tab.lastTitle || tab.initialTitle,
        address,
        canGoBack: tab.fromNewTab === true,
        canGoForward: false,
        loading: false,
        crashed: false,
        error: tab.error,
        notice: tab.notice,
        engine: tab.engine,
        engineSource: sourceOf(tab),
        pinned: tab.pinned,
        muted: tab.muted,
        internal: tab.internal,
        keepAwake: keptAwake(tab),
        discarded: true
      }
    }
    const contents = tab.view.webContents
    const destroyed = contents.isDestroyed()
    const crashed = !destroyed && contents.isCrashed()
    let url = ''
    let title = ''
    let canGoBack = false
    let canGoForward = false
    let loading = false
    if (!destroyed) {
      url = safe(() => contents.getURL(), '')
      title = safe(() => contents.getTitle(), '')
      if (!crashed) {
        const historyCanGoBack = safe(() => contents.navigationHistory.canGoBack(), false)
        const historyCanGoForward = safe(() => contents.navigationHistory.canGoForward(), false)
        // 新标签页不在页面视图的历史里（换过 WebContents），用标签标记补齐这一层：
        // 网页标签的最早一条历史再按 Back → 回到 NTP；回到 NTP 后 Forward → 重开那个网页。
        canGoBack = historyCanGoBack || (tab.internal === undefined && tab.fromNewTab === true)
        canGoForward = historyCanGoForward || (tab.internal === 'newtab' && !!tab.newTabForwardUrl)
        loading = safe(() => contents.isLoadingMainFrame(), false)
      }
    }
    // 内部页在首帧加载完成前也要显示自己的地址（Chrome 同样立刻显示 chrome://settings）；
    // 新标签页与 Chrome 一致：地址栏不显示 URL（空串 + 占位文案）。
    // 刚从休眠/崩溃恢复唤醒的标签在导航提交前 `getURL()` 是空串：回落到休眠前的地址，
    // 免得地址栏闪一下空白（此时 `lastUrl` 正是它要加载的那个地址）。
    const address = tab.failedUrl ?? (tab.internal === 'settings'
      ? (url || SETTINGS_URL)
      : tab.internal === 'newtab' ? '' : (url || tab.lastUrl || ''))
    const pin = engineRules.resolve(hostOf(address))
    return {
      id: tab.id,
      // 文档还没给出 <title> 时，Chromium 会把标题当成 URL——直接透出去会让标签栏
      // 闪一下 `bao://settings/`。所以「标题等于地址（忽略结尾斜杠）」或「标题本身就是
      // 内部地址」时回落到建标签时给的初始标题。2026-11-24 实测：内部设置页在页面加载
      // 完成前约 60–200 ms 处于这个状态，且 Chromium 给的占位标题不带结尾斜杠。
      // 文档还没给出 <title> 时，Chromium 会把标题当成 URL——直接透出去会让标签栏
      // 闪一下 `bao://settings/`。占位时回落到建标签时给的初始标题。
      // 2026-11-24 实测：内部设置页在首帧前约 60–200 ms 处于这个状态。
      title: address ? (placeholderTitle(title, address) ? tab.initialTitle : title) : tab.initialTitle,
      address,
      canGoBack,
      canGoForward,
      loading,
      crashed,
      error: tab.error,
      notice: tab.notice,
      engine: tab.engine,
      engineSource: sourceOf(tab),
      pinnedEngine: pin.source === 'site-rule' ? pin.engine : undefined,
      pinned: tab.pinned,
      muted: tab.muted,
      internal: tab.internal,
      keepAwake: keptAwake(tab)
    }
  }

  function state(): BrowserState {
    return {
      revision,
      theme: currentTheme(),
      settings: currentSettings(),
      activeId: active?.id ?? -1,
      undoCount: recentlyClosed.length,
      flash: plugins,
      flashHint: plugins ? undefined : options.flashHint,
      sessionPrompt: sessionPromptOf(),
      tabs: tabs.map(describe)
    }
  }

  function publish(): void {
    if (closing || !active || !tabs.includes(active)) return
    if (window.isDestroyed() || window.webContents.isDestroyed()) return
    revision += 1
    const snapshot = state()
    window.webContents.send(browserChannels.changed, snapshot)
    overlays.publish(snapshot)
    // 会话投影跟着外壳投影走：标题、地址、置顶、保持活跃任何一处变化都会在这里被登记，
    // 实际写盘由 `scheduleSessionSave()` 节流。
    if (!sessionQuitting) scheduleSessionSave(shellContentsId, sessionWindowSnapshot())
  }

  /** 内部页读到的快照：设置 + **解析后**的亮/暗 + 存储状态 + 插件可用性。 */
  function internalSnapshot(): SettingsSnapshot {
    return {
      settings: currentSettings(),
      theme: currentTheme(),
      storage: storageStatus(),
      flash: plugins
    }
  }

  function notify(tab: Tab): void {
    if (!tabs.includes(tab)) return
    if (active === tab) layout()
    publish()
  }

  function layout(): void {
    overlays.layout()
    if (!active) return
    const [width, height] = window.getContentSize()
    if (!active?.view) return
    // 崩溃恢复提示条占一条固定高度：页面视图必须让开，否则会被它压住一截。
    const infobar = sessionPromptOf() ? INFOBAR_HEIGHT : 0
    const y = TAB_BAR_HEIGHT + TOOLBAR_HEIGHT + infobar
    active.view.setBounds({ x: 0, y, width, height: Math.max(0, height - y) })
    // 失败时让外壳绘制带重试动作的内容页，不在工具栏里塞错误文字。
    active.view.setVisible(!active.error)
  }

  /**
   * 引擎决定视图的 preload 与插件开关（架构 §3 引擎）：
   * - `ppapi`：原生 Flash 插件，无页面 preload；
   * - `ruffle`：关闭插件，挂页面 preload 注入本地 Ruffle 运行时。
   * 两种引擎都保持 `sandbox: true` 与 `contextIsolation: true`（沙箱要求见内核补丁记录）。
   */
  function createPageView(engine: BrowserEngine): WebContentsView {
    // 插件不可用时一律走 Ruffle，避免出现「选了 PPAPI 却什么都不显示」。
    const ruffle = engine === 'ruffle' || !plugins
    const view = new WebContentsView({
      webPreferences: {
        session: pageSession,
        preload: ruffle ? join(__dirname, '../preload/page.js') : undefined,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        plugins: !ruffle,
        /**
         * Ruffle 需要把引导注入**每个子帧**：站点的客户端 SWF 常挂在跨源 iframe 里
         * （2026-11-22 淘米对照：`Couldn't load Ruffle into IFRAME[]: SecurityError`），
         * 父帧的注入被同源策略挡住；让 preload 进子帧后，每个帧各自实例化 Ruffle。
         * `nodeIntegration` 仍为 false，preload 只在隔离世界运行。
         */
        nodeIntegrationInSubFrames: ruffle
      }
    })
    // 登记页面视图：Ruffle 运行时只发给页面视图（架构 §3 IPC 校验发送者）。
    registerPageView(view.webContents.id)
    return view
  }

  /**
   * 内部页视图（`bao://newtab` / `bao://settings`）。
   *
   * 与页面视图**同一套沙箱**（`sandbox/contextIsolation/nodeIntegration`），只是换了会话、
   * preload 与协议；**刻意不调 `registerPageView()`**——内部页不是 Ruffle/broker 的页面视图，
   * 那两条特权通道对它保持关闭。
   *
   * 两种内部页共用同一个 preload：同一个 WebContents 会在两个文档之间就地导航，而 preload
   * 是按文档执行的——按 kind 换 preload 会让「NTP 就地变成设置页」后的设置页拿不到桥。
   * 权限不靠 preload 区分，靠主进程按「标签身份 ∧ 主帧 ∧ 文档 URL」判定（见 `internalSender`）。
   */
  function createInternalView(): WebContentsView {
    return new WebContentsView({
      webPreferences: {
        session: getInternalSession(),
        preload: join(__dirname, '../preload/internal.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        plugins: false,
        nodeIntegrationInSubFrames: false
      }
    })
  }

  /** 事件只按 `tab.host` 分发，跨窗口移动时无需重挂监听。 */
  /**
   * 页面级窗口策略（架构 §3 权限与会话「对弹窗、新窗口、导航及外部协议设显式策略」）。
   *
   * 只允许**同站**（协议一致 + 可注册域相同）的 http(s) 弹窗，其余（跨站、`file:`/
   * `about:blank`/自定义协议）拒绝；非 http(s) 的主帧导航与重定向一并拦截。
   *
   * **递归**：真实子窗口自己再开窗、再导航时，装的是同一套策略（2026-11-23 审计 P1-3：
   * 子窗口原先只登记 WebContents，完全没有策略）。子窗口继承 opener 的引擎偏好——
   * PPAPI 需要 `plugins: true`，Ruffle 需要页面 preload 与子帧注入。
   *
   * 用真实子窗口承载而不是新标签：`window.open` 的返回值与 `window.opener` 是 Flash
   * lobby→game 交接的常见通道，以标签承载会直接丢掉它们。
   */
  function guardContents(
    contents: WebContents,
    context: {
      engine: () => BrowserEngine
      openerUrl: () => string | undefined
      live: () => boolean
      /** 该标签允许的文档地址（页面 http(s) / 内部页仅 bao://settings/*）。 */
      allow: (url: string) => boolean
    }
  ): void {
    contents.setWindowOpenHandler((details) => {
      const { url } = details
      if (!context.live() || !context.allow(url)) return { action: 'deny' }
      const opener = siteBoundary(context.openerUrl())
      const target = siteBoundary(url)
      if (!isSameSite(opener, target)) {
        console.warn(`[popup] 拒绝非同站弹窗：${url}`)
        return { action: 'deny' }
      }
      const engine = context.engine()
      const ruffle = engine === 'ruffle' || !plugins
      console.info(`[popup] 允许同站弹窗：${url}（引擎 ${engine}）`)
      // 自绘 chrome（架构 A5）：frame:false，右上角浮一个小控制簇，不用 Windows 原生帧。
      const size = popupSize(details)
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: size.width,
          height: size.height,
          x: size.x,
          y: size.y,
          icon: windowIcon,
          // 自动化模式：弹窗从一开始就不显示（否则 Chromium 会在 did-create-window 之后
          // 再 show 一次，屏幕上闪一个窗口）。
          ...(hidden || background ? { show: false, skipTaskbar: true, focusable: false } : {}),
          ...(background ? { x: -32000, y: -32000, opacity: 0 } : {}),
          // 自绘 chrome：rame: false 去掉原生标题栏（Windows 仍保留 1px 的可调整边框，属正常）。
          frame: false,
          backgroundColor: '#ffffff',
          autoHideMenuBar: true,
          webPreferences: {
            session: pageSession,
            preload: ruffle ? join(__dirname, '../preload/page.js') : undefined,
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
            plugins: !ruffle,
            nodeIntegrationInSubFrames: ruffle
          }
        }
      }
    })

    /**
     * 子窗口同样要：① 登记为「页面视图」（否则 Ruffle 的同步 IPC 会把它拒掉）；
     * ② 装上同一套策略。`did-create-window` 在导航开始前触发，早于 preload 执行。
     */
    contents.on('did-create-window', (child) => {
      const childContents = child.webContents
      if (childContents.isDestroyed()) return
      // 自动化模式下弹窗同样不能出现在屏幕上。
      applyAutomationWindowMode(child)
      registerPageView(childContents.id)
      // 自绘 chrome：window.open 的窗口没有原生标题栏，控制簇由我们画。
      attachPopupChrome(child)
      const childEngine = context.engine()
      guardContents(childContents, {
        engine: () => childEngine,
        openerUrl: () => safe(() => childContents.getURL(), ''),
        live: () => !childContents.isDestroyed(),
        // 子窗口是页面弹窗，只可能是 http(s)。
        allow: isWebAddress
      })
    })

    contents.on('will-frame-navigate', (event) => {
      if (context.live() && event.isMainFrame && !context.allow(event.url)) event.preventDefault()
    })
    contents.on('will-redirect', (event) => {
      if (context.live() && event.isMainFrame && !context.allow(event.url)) event.preventDefault()
    })
  }

  function bind(tab: Tab, view: WebContentsView): void {
    const binding = tab.binding
    const contents = view.webContents
    const live = () => tab.view === view && tab.binding === binding && !contents.isDestroyed()

    contents.on('before-input-event', (event, input) => {
      if (!live() || event.defaultPrevented) return
    if (tab.host?.shortcut(tab, input)) event.preventDefault()
    })
    guardContents(contents, {
      engine: () => tab.engine,
      openerUrl: () => safe(() => contents.getURL(), ''),
      live,
      // 内部页在同一会话里可以在 `bao://newtab` 与 `bao://settings` 之间就地导航。
      allow: tab.internal ? isInternalUrl : isWebAddress
    })
    contents.on('did-start-loading', () => {
      if (!live()) return
      tab.error = ''
      tab.host?.notify(tab)
    })
    contents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
      if (!live() || !isMainFrame || code === -3) return
      tab.failedUrl = isWebAddress(url) ? url : undefined
      tab.error = TAB_LOAD_FAILED
      tab.host?.notify(tab)
    })
    contents.on('render-process-gone', () => {
      if (!live()) return
      tab.error = TAB_CRASHED
      tab.host?.notify(tab)
    })
    contents.on('did-stop-loading', () => {
      if (live()) tab.host?.notify(tab)
    })
    contents.on('did-navigate', (_event, url) => {
      if (!live()) return
      // 内部页身份以 URL 为准：任何来源的就地导航（地址栏、页内链接）都能被正确归类，
      // 避免「标签说是新标签页、文档已经是设置页」的陈旧值。
      if (tab.internal) {
        const kind = internalKindOf(url)
        if (kind && kind !== tab.internal) {
          tab.internal = kind
          tab.initialTitle = kind === 'newtab' ? '新标签页' : '设置'
        }
      }
      tab.failedUrl = undefined
      tab.host?.notify(tab)
    })
    contents.on('did-navigate-in-page', () => {
      if (live()) tab.host?.notify(tab)
    })
    contents.on('page-title-updated', () => {
      if (live()) tab.host?.notify(tab)
    })
  }

  function load(tab: Tab, url: string): void {
    if (!tab.view) return
    void tab.view.webContents.loadURL(url).catch(() => {})
  }

  /** `url === null` 表示不自动导航：撤销关闭与引擎切换要先把导航栈 restore 上去。 */
  function addTab(
    initialTitle: string,
    url: string | null,
    engine: BrowserEngine,
    source: EngineSource
  ): Tab {
    const view = createPageView(engine)
    const tab: Tab = {
      id: nextTabId++, view, binding: 1, error: '', initialTitle, engine, manualOverride: source === 'manual', pinned: false, muted: false, host: controller
    }
    tabs.push(tab)
    bind(tab, view)
    if (url !== null) load(tab, url)
    return tab
  }

  /**
   * 开一个内部页标签（`bao://newtab` / `bao://settings`）。
   *
   * 引擎字段只是占位：内部页没有引擎，也不参与站点规则；`describe()` 会把 `internal`
   * 带给渲染层，工具栏据此隐藏引擎胶囊。
   */
  function openInternalTab(kind: InternalKind): Tab {
    const view = createInternalView()
    const tab: Tab = {
      id: nextTabId++,
      view,
      binding: 1,
      error: '',
      initialTitle: kind === 'newtab' ? '新标签页' : '设置',
      engine: engineFor(undefined).engine,
      manualOverride: false,
      pinned: false,
      muted: false,
      host: controller,
      internal: kind
    }
    tabs.push(tab)
    bind(tab, view)
    load(tab, internalUrls[kind])
    return tab
  }

  /** 新建标签页：Chrome 的 `Ctrl+T`/「+」语义是**总是**新增一个 NTP，不复用。 */
  function openNewTab(): Tab {
    return openInternalTab('newtab')
  }

  /* ------------------------------------------------------------------ *
   * 崩溃恢复（M2）：只在上次异常退出、且用户点了「恢复标签页」之后才走这条路。
   * ------------------------------------------------------------------ */

  /**
   * 从会话条目建一个标签，但**不创建视图**，也不插进 `tabs`（插入顺序由调用方决定）。
   *
   * 只有会话里的活动标签会在恢复后立即加载，其余保持 `discarded` 状态（视图为空），
   * 切回时由 `select()` → `revive()` 重建并重新加载。
   */
  function createRestoredTab(entry: SessionTab): Tab {
    const tab: Tab = {
      id: nextTabId++,
      binding: 1,
      error: '',
      initialTitle: entry.title || (entry.internal === 'newtab' ? '新标签页' : entry.url),
      manualOverride: entry.manualOverride,
      pinned: entry.pinned,
      muted: entry.muted,
      internal: entry.internal,
      discarded: true,
      lastUrl: entry.url || undefined,
      lastTitle: entry.title || undefined,
      // BYOP：上次退出时用的是原生 Flash，本次启动却没有插件——按 Ruffle 恢复，
      // 否则会恢复出一个「引擎写着 ppapi 但插件不存在」的空页面。
      engine: entry.engine === 'ppapi' && !plugins ? 'ruffle' : entry.engine,
      host: controller
    }
    // 用户「保持活跃」跨重启保留：重建同一条 user 租约（架构 §7 规则 3）。
    if (entry.keepAwake) markKeepAwake(tab)
    return tab
  }

  /** 只有一个未动过的新标签页时才允许被恢复覆盖（Chrome 的「恢复页面」语义）。 */
  function isBlankNewTab(tab: Tab | undefined): boolean {
    if (!tab || tab.internal !== 'newtab' || !tab.view) return false
    return isNewTabUrl(safe(() => tab.view?.webContents.getURL() ?? '', ''))
  }

  /**
   * 把一份会话的标签建进当前窗口。
   *
   * 两条路共用：崩溃恢复（用户点「恢复标签页」）与「继续上次会话」（设置项
   * `session.startup = continue`）。多窗口会话会并回当前窗口（M2 首版不还原窗口布局）；
   * 固定标签仍插到最左前缀；只有一个**未动过**的空白新标签页时把它覆盖掉。
   */
  function applySession(session: SessionSnapshot): void {
    const blank = tabs.length === 1 && isBlankNewTab(tabs[0]) ? tabs[0] : undefined
    const entries = session.windows.flatMap((window) => window.tabs)
    const restored = entries.map(createRestoredTab)
    const pinnedRestored = restored.filter((tab) => tab.pinned)
    const others = restored.filter((tab) => !tab.pinned)
    tabs.unshift(...pinnedRestored)
    tabs.push(...others)

    const activeIndex = entries.findIndex((entry) => entry.active)
    const chosen = (activeIndex >= 0 ? restored[activeIndex] : undefined) ?? restored[0]
    if (chosen) select(chosen, true)
    if (blank && blank !== chosen) closeTab(blank)
  }

  /** 用户点了「恢复标签页」：建出崩溃会话的标签，并解除写盘挂起。 */
  function restoreCrashSession(): void {
    const session = crashSession
    if (!session) return
    crashSession = undefined
    applySession(session)
    // 用户已经回答，解除写盘挂起：当前状态（恢复后的标签）覆盖磁盘上的崩溃会话。
    releaseSessionHold()
    layout()
  }

  /** 用户点了「忽略」：丢弃崩溃会话，当前窗口保持原样。 */
  function dismissCrashSession(): void {
    if (!crashSession) return
    crashSession = undefined
    releaseSessionHold()
    publish()
    layout()
  }

  /** 本窗口的会话投影：只记恢复需要的最少字段（滚动位置、表单、导航栈一律不记）。 */
  function sessionWindowSnapshot(): SessionWindow {
    const projected: SessionTab[] = []
    for (const tab of tabs) {
      // 设置页不落盘：它是随时可重开的内部页，恢复它只会让用户多一个「设置」标签。
      if (tab.internal === 'settings') continue
      const liveUrl = safe(() => tab.view?.webContents.getURL() ?? '', '')
      const liveTitle = safe(() => tab.view?.webContents.getTitle() ?? '', '')
      const url = tab.internal === 'newtab' ? '' : (tab.failedUrl ?? (liveUrl || tab.lastUrl || ''))
      projected.push({
        url,
        title: liveTitle || tab.lastTitle || tab.initialTitle,
        engine: tab.engine,
        manualOverride: tab.manualOverride,
        pinned: tab.pinned,
        muted: tab.muted,
        keepAwake: keptAwake(tab),
        ...(tab.internal === 'newtab' ? { internal: 'newtab' as const } : {}),
        ...(tab === active ? { active: true } : {})
      })
    }
    return { tabs: projected }
  }

  /** 内部页就地导航（NTP ↔ 设置）：同一会话，历史项追加（与 Chrome 的 CURRENT_TAB 一致）。 */
  function controlInternal(tab: Tab, target: { kind: InternalKind; url: string }): void {
    tab.internal = target.kind
    tab.initialTitle = target.kind === 'newtab' ? '新标签页' : '设置'
    tab.error = ''
    tab.failedUrl = undefined
    tab.notice = undefined
    // 标签里发生了真实导航：从「新标签页 Back 回来」记下的 Forward 目标不再成立。
    tab.newTabForwardUrl = undefined
    // 休眠的内部页先重建视图（两种内部页共用 preload，权限按文档 URL 判定）。
    if (!tab.view) revive(tab)
    load(tab, target.url)
    if (active === tab) layout()
    publish()
  }

  /**
   * 打开内部单例页（当前只有设置页）。
   *
   * 对齐 Chrome 的 `ShowSingletonTabOverwritingNTP`（`chrome/browser/ui/singleton_tabs.cc:76-94`）：
   * ① 窗口内已有设置标签 → 切过去；
   * ② 当前标签正是新标签页 → **就地覆盖**，不新建标签；
   * ③ 都没有 → 新建前台标签。
   */
  function openSettingsTab(): Tab {
    const existing = tabs.find((item) => item.internal === 'settings')
    if (existing) {
      select(existing, true)
      return existing
    }
    const current = active
    if (current && current.internal === 'newtab') {
      controlInternal(current, { kind: 'settings', url: SETTINGS_URL })
      select(current, true)
      return current
    }
    const opened = openInternalTab('settings')
    select(opened, true)
    return opened
  }

  /**
   * 导航（外壳地址栏、设置页地址栏，以及后续 NTP realbox 共用）。
   *
   * 内部页的规则对齐 Chrome：
   * - `bao://newtab` / `bao://settings` → 就地切换，历史项追加；
   * - 新标签页里输入 http(s) → **同一个标签**换成页面视图（内部会话永不承载网页）；
   * - 设置页里输入 http(s) → 新开普通标签（既有 P2 决策：设置页原地不动）。
   */
  function navigateTab(tab: Tab | undefined, raw: unknown): BrowserResult {
    if (!tab) return fail('unknown-tab')
    const address = typeof raw === 'string' ? raw : ''
    if (tab.internal) {
      const internal = parseInternalAddress(address)
      if (internal) {
        const current = safe(() => tab.view?.webContents.getURL() ?? '', '')
        if (internal.kind !== tab.internal || internal.url !== current) controlInternal(tab, internal)
        return { ok: true, state: state() }
      }
      const opened = parseAddress(address)
      if (!opened) return fail('invalid-address')
      if (tab.internal === 'settings') {
        const resolved = engineFor(opened)
        select(addTab('新标签页', opened, resolved.engine, resolved.source), true)
      } else {
        leaveNewTab(tab, opened)
      }
      return { ok: true, state: state() }
    }
    const url = parseAddress(address)
    if (!url) return fail('invalid-address')
    // 站点规则只决定「初始」引擎：用户在这个标签上手动切换过，就沿用他的选择。
    const resolved = tab.manualOverride
      ? { engine: tab.engine, source: 'manual' as EngineSource }
      : engineFor(url)
    if (resolved.engine !== tab.engine) {
      swapView(tab, resolved.engine, resolved.source)
      load(tab, url)
      return { ok: true, state: state() }
    }
    const contents = tab.view?.webContents
    if (!contents) {
      // 休眠标签：唤醒后再导航。
      revive(tab)
      load(tab, url)
      return { ok: true, state: state() }
    }
    if (contents.isDestroyed() || contents.isCrashed()) {
      rebuild(tab, url)
      return { ok: true, state: state() }
    }
    void contents.loadURL(url).catch(() => {})
    focusContents(contents)
    return { ok: true, state: state() }
  }

  /**
   * 新标签页 → 网页：同一个标签换成页面视图。
   *
   * 内部会话永远不承载 http(s)（否则网页能 `fetch('bao://settings/…')`），所以这里没有
   * 「原地导航」这个选项；NTP 也不在这条新历史里——由 `fromNewTab` + `returnToNewTab`
   * 补出「Back 回 NTP」（`docs/discussions/2026-11-24-new-tab-page-alignment.md` §7 D1）。
   */
  function leaveNewTab(tab: Tab, url: string): void {
    // 手动切过引擎的标签，Forward 回来要沿用同一个引擎。
    const resolved = tab.manualOverride
      ? { engine: tab.engine, source: 'manual' as EngineSource }
      : engineFor(url)
    // 先清内部身份：`swapView` 才会建页面视图并走站点规则。
    tab.internal = undefined
    tab.initialTitle = '新标签页'
    tab.fromNewTab = true
    tab.newTabForwardUrl = undefined
    swapView(tab, resolved.engine, resolved.source)
    load(tab, url)
  }

  /**
   * 网页标签的 Back 走到最早一条历史：回到新标签页（重建内部视图）。
   *
   * 旧 WebContents 连同页面状态一起丢弃；Forward 用 `newTabForwardUrl` 重新加载同一地址
   * （这是「NTP 不在页面视图历史里」的既定代价，见方案 §7 D1）。
   */
  function returnToNewTab(tab: Tab): void {
    const url = safe(() => tab.view?.webContents.getURL() ?? '', '')
    tab.newTabForwardUrl = url || undefined
    tab.internal = 'newtab'
    tab.initialTitle = '新标签页'
    tab.error = ''
    tab.failedUrl = undefined
    tab.notice = undefined
    swapView(tab, tab.engine, tab.manualOverride ? 'manual' : 'default')
    load(tab, internalUrls.newtab)
    // 与 Chrome 一致：Back 回到 NTP 后焦点落回地址栏（视图已经是 NTP，交给外壳）。
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.focus()
    if (active === tab) layout()
    publish()
  }

  /**
   * 「后台窗口永不抢前台」合同（沿用旧项目 `focusActive()` 的做法，2026-11-23）：
   * 只有窗口本身已经是前台窗口时，才把焦点交给它的 WebContents。
   *
   * 没有这道闸门时，`select()/swapView()/navigate()` 里的 `webContents.focus()` 会把
   * 一个后台窗口（自动化、或被别的窗口盖住的窗口）拉到前台——用户正在别处打字就被打断。
   */
  function focusContents(contents: WebContents): void {
    if (window.isDestroyed() || !window.isFocused()) return
    if (!contents.isDestroyed()) contents.focus()
  }

  /** 后台标签休眠阈值：10 分钟（开关见设置项 `tab.discard`）。 */
  // 默认 10 分钟；BAO_DISCARD_TTL_MS / BAO_DISCARD_SWEEP_MS 仅供测试缩短时间片。
  // TODO(M3)：TTL 做成设置项 tab.discardTtl（5/10/30 分钟），见 docs/reports/2026-11-24-tab-discard.md §4。
  const DISCARD_TTL_MS = Number(process.env.BAO_DISCARD_TTL_MS ?? 10 * 60_000)
  /** 扫描周期：30 秒。 */
  const DISCARD_SWEEP_MS = Number(process.env.BAO_DISCARD_SWEEP_MS ?? 30_000)

  /** 让标签进入休眠：销毁它的视图（省掉一整个渲染进程），只保留元数据。 */
  function discardTab(tab: Tab): void {
    const view = tab.view
    if (!view) return
    tab.lastUrl = safe(() => view.webContents.getURL(), tab.lastUrl ?? '')
    tab.lastTitle = safe(() => view.webContents.getTitle(), tab.lastTitle ?? '')
    if (window.contentView.children.includes(view)) window.contentView.removeChildView(view)
    tab.binding += 1
    tab.view = undefined
    tab.discarded = true
    tab.backgroundSince = undefined
    tab.error = ''
    tab.notice = undefined
    if (!view.webContents.isDestroyed()) view.webContents.close()
    publish()
  }

  /** 唤醒休眠标签：重建视图并按休眠前的地址重新加载（引擎沿用当前值）。
   *  TODO(M3)：可选恢复导航栈与滚动位置，见 docs/reports/2026-11-24-tab-discard.md §4。 */
  function revive(tab: Tab): void {
    if (tab.view) return
    const view = tab.internal ? createInternalView() : createPageView(tab.engine)
    tab.view = view
    tab.binding += 1
    tab.discarded = false
    bind(tab, view)
    const url = tab.lastUrl || (tab.internal ? internalUrls[tab.internal] : '')
    if (url) load(tab, url)
    publish()
  }

  /**
   * 定时扫描：把「后台超过 TTL」的标签置为休眠。
   *
   * 守卫（任何一条命中都不休眠）：当前标签、内部页、置顶标签、有效活动租约、正在出声、非 http(s)。
   * 出声这一条是硬要求：挂机型页面（游戏/自动化）几乎都有声音或需要持续运行，
   * 用户也可以在设置里把整个机制关掉（`tab.discard = never`）。
   *
   * 「用户保持活跃」不再单独判断：它是 `user` owner 的租约，和下载 / 会话恢复 / DevTools
   * 走同一条 `blocksDiscard()` 判定（架构 §7 规则 4）。谁在租约表里，就谁说了算。
   */
  // TODO(M3)：守卫链预留给「自动判定挂机」（长时间无交互 + 持续音频输出），见同一份报告的 §4。
  function sweepDiscard(): void {
    if (closing || window.isDestroyed()) return
    const now = Date.now()
    // 先回收过期租约再判定：owner 崩溃或忘记释放时，标签不会被永久锁活。
    activityLeases.sweepExpired(now)
    if (currentSettings().tabDiscard === 'never') return
    for (const tab of tabs) {
      if (!tab.view || tab === active || tab.internal || tab.pinned) continue
      if (activityLeases.blocksDiscard(tab.id, now)) {
        // 租约期间不计入后台时长：休眠资格从租约结束时刻重新计时，
        // 否则「挂了 1 小时的标签被下载租约保护 2 分钟」会在租约一结束就被立刻丢弃。
        tab.backgroundSince = now
        continue
      }
      const contents = tab.view.webContents
      if (contents.isDestroyed() || contents.isCrashed()) continue
      if (safe(() => contents.isCurrentlyAudible(), false)) continue
      if (!isWebAddress(safe(() => contents.getURL(), ''))) continue
      if (tab.backgroundSince === undefined) {
        tab.backgroundSince = now
        continue
      }
      if (now - tab.backgroundSince < DISCARD_TTL_MS) continue
      discardTab(tab)
    }
  }

  /** 切换活动标签时维护「后台起点」：新活动标签清零，旧活动标签重新计时。 */
  function markBackground(tab: Tab | undefined): void {
    if (!tab) return
    tab.backgroundSince = undefined
  }

  function select(tab: Tab, focus = true): void {
    // 休眠标签先唤醒：重建视图 + 重新加载，再走正常的切换流程。
    if (!tab.view) revive(tab)
    const view = tab.view
    if (!view) return
    if (active !== tab) {
      const previous = active
      if (previous && previous.view && window.contentView.children.includes(previous.view)) {
        window.contentView.removeChildView(previous.view)
      }
      active = tab
      // 新活动标签清零；刚离开的那个从此刻开始计「后台时间」。
      markBackground(tab)
      if (previous) previous.backgroundSince = Date.now()
      window.contentView.addChildView(view)
      overlays.setActivePage(view.webContents)
      layout()
    }
    if (focus) {
      // 新标签页与 Chrome 一致：焦点进地址栏（外壳收到状态后聚焦输入框），而不是页面。
      if (tab.internal === 'newtab') {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.focus()
      } else {
        focusContents(view.webContents)
      }
    }
    publish()
  }

  /**
   * 换一个 WebContents（同引擎重建或换引擎）。旧代际事件立即作废。
   * 用于渲染进程崩溃恢复与引擎切换（架构 §3 页面、§3 引擎、§6 M1）。
   */
  function swapView(tab: Tab, engine: BrowserEngine, source: EngineSource): WebContentsView {
    const previous = tab.view
    // 内部页重建仍是内部页：不能因为崩溃/快捷键把它换成页面视图。
    const view = tab.internal ? createInternalView() : createPageView(engine)
    tab.binding += 1
    tab.view = view
    tab.engine = engine
    tab.manualOverride = source === 'manual'
    tab.error = ''
    tab.failedUrl = undefined
    tab.notice = undefined
    bind(tab, view)
    // 静音状态跟着标签走：切引擎重建 WebContents 后必须重新应用（审计 P2）。
    if (tab.muted && !view.webContents.isDestroyed()) view.webContents.setAudioMuted(true)
    const measured = active === tab
    if (measured) {
      window.contentView.addChildView(view)
      overlays.setActivePage(view.webContents)
      layout()
    }
    if (previous && window.contentView.children.includes(previous)) window.contentView.removeChildView(previous)
    if (previous && !previous.webContents.isDestroyed()) previous.webContents.close()
    if (measured && !overlays.panelVisible()) focusContents(view.webContents)
    return view
  }

  function rebuild(tab: Tab, url: string): void {
    swapView(tab, tab.engine, tab.manualOverride ? 'manual' : 'default')
    load(tab, url)
  }

  /** 引擎切换：新 WebContents 换引擎，再恢复导航栈（架构 §3 引擎）。 */
  function switchEngine(tab: Tab, engine: BrowserEngine): void {
    if (tab.engine === engine) return
    if (!tab.view) revive(tab)
    const contents = tab.view?.webContents
    if (!contents) return
    const entries = contents.isDestroyed() ? [] : safe(() => contents.navigationHistory.getAllEntries(), [])
    const index = contents.isDestroyed()
      ? 0
      : safe(() => contents.navigationHistory.getActiveIndex(), Math.max(entries.length - 1, 0))
    const failedUrl = tab.failedUrl
    swapView(tab, engine, 'manual')
    if (failedUrl && entries.length === 0) load(tab, failedUrl)
    else void restoreHistory(tab, entries, index, '无法恢复完整历史，已尝试重新打开页面')
  }

  /**
   * 恢复导航栈。`restore()` 只能还原 URL 与滚动/表单状态，POST 体等无法还原 ——
   * 失败时退回最后一个已知地址并给出可理解的恢复动作（架构 §3 引擎）。
   */
  async function restoreHistory(
    tab: Tab,
    entries: NavigationEntry[],
    index: number,
    failure: string
  ): Promise<void> {
    if (entries.length === 0) {
      if (tab.internal) load(tab, internalUrls[tab.internal])
      return
    }
    const view = tab.view
    if (!view) return
    try {
      await view.webContents.navigationHistory.restore({ entries, index })
    } catch (error) {
      if (tab.view !== view || view.webContents.isDestroyed()) return
      const fallback = entries[index]?.url || entries.at(-1)?.url
      tab.notice = { id: nextNoticeId++, message: failure }
      if (fallback) load(tab, fallback)
      tab.host?.notify(tab)
      console.error('无法恢复导航栈。', error)
    }
  }

  /** 把当前标签的引擎记为站点规则（架构 §3 引擎「用户手动切换时可确认记为站点规则」）。 */
  function rememberActiveEngine(tab: Tab): BrowserResult {
    const host = hostOf(tab.failedUrl ?? tab.lastUrl ?? safe(() => tab.view?.webContents.getURL() ?? '', ''))
    if (!host) return fail('no-site')
    if (!engineRules.remember(host, tab.engine)) return fail('site-rule-save-failed')
    tab.manualOverride = false
    publish()
    return { ok: true, state: state() }
  }

  /** 取消当前站点的引擎规则，回到「手动切换」状态（记住要可撤销）。 */
  function forgetActiveEngine(tab: Tab): BrowserResult {
    const host = hostOf(tab.failedUrl ?? tab.lastUrl ?? safe(() => tab.view?.webContents.getURL() ?? '', ''))
    if (!host) return fail('no-site')
    if (!engineRules.forget(host)) return fail('site-rule-save-failed')
    tab.manualOverride = true
    publish()
    return { ok: true, state: state() }
  }

  /** 复制标签页：同 URL、同引擎，作为新标签插到末尾并激活（架构 §3「标签操作」）。 */
  function duplicateTab(tab: Tab): void {
    // 内部页复制出同类内部页：用页面视图去加载 `bao://` 会直接失败（协议只在内部会话）。
    const copy = tab.internal
      ? openInternalTab(tab.internal)
      : addTab(
          tab.initialTitle,
          safe(() => tab.view?.webContents.getURL() ?? tab.lastUrl ?? '', '') || null,
          tab.engine,
          sourceOf(tab)
        )
    // 复制标签继承「保持活跃」标记（挂机场景复制出来的标签同样不该被休眠）：
    // 租约按 tabId 归属，副本必须**新申请**一条自己的，而不是共享原标签的。
    if (keptAwake(tab)) setKeepAwake(copy, true)
    // 也从新标签页起步：复制出来同样能按 Back 回 NTP。
    copy.fromNewTab = tab.fromNewTab
    select(copy, true)
  }

  /**
   * 固定 / 取消固定标签。
   *
   * 固定标签始终排在未固定标签之前（与浏览器习惯一致）：固定时插到最后一条固定标签之后，
   * 取消固定时插到第一条未固定标签之前，保持相对顺序。
   */
  function setPinned(tab: Tab, pinned: boolean): void {
    if (tab.pinned === pinned) return
    const index = tabs.indexOf(tab)
    if (index < 0) return
    tabs.splice(index, 1)
    tab.pinned = pinned
    if (pinned) {
      let insertAt = 0
      for (let cursor = 0; cursor < tabs.length; cursor += 1) {
        if (tabs[cursor].pinned) insertAt = cursor + 1
      }
      tabs.splice(insertAt, 0, tab)
    } else {
      const firstUnpinned = tabs.findIndex((item) => !item.pinned)
      tabs.splice(firstUnpinned < 0 ? tabs.length : firstUnpinned, 0, tab)
    }
    publish()
  }

  /** 静音 / 取消静音：状态记在标签上，重建后由 `swapView` 迁移。 */
  function toggleMuted(tab: Tab): void {
    tab.muted = !tab.muted
    const contents = tab.view?.webContents
    if (contents && !contents.isDestroyed()) contents.setAudioMuted(tab.muted)
    publish()
  }

  /** 标签右键菜单：原生菜单，光标位置弹出（比自绘菜单更贴合系统习惯）。 */
  function showTabMenu(tab: Tab): void {
    const contents = tab.view?.webContents
    const muted = !!contents && !contents.isDestroyed() && safe(() => contents.isAudioMuted(), false)
    // 内部页没有引擎/静音/复制语义：只留重载、关闭与撤销。
    const template: MenuItemConstructorOptions[] = tab.internal
      ? [
          { label: '重新加载', click: () => reloadTab(tab) },
          { type: 'separator' },
          { label: '关闭标签页', click: () => closeTab(tab) },
          { label: '撤销关闭的标签页', enabled: recentlyClosed.length > 0, click: () => void undoClose() }
        ]
      : [
          { label: '重新加载', click: () => reloadTab(tab) },
          { label: '复制标签页', click: () => duplicateTab(tab) },
          { type: 'separator' },
          { label: tab.pinned ? '取消固定标签页' : '固定标签页', click: () => setPinned(tab, !tab.pinned) },
          { label: muted ? '取消静音' : '静音标签页', click: () => toggleMuted(tab) },
          {
            label: keptAwake(tab) ? '允许自动休眠' : '保持活跃（不自动休眠）',
            type: 'checkbox',
            checked: keptAwake(tab),
            click: () => setKeepAwake(tab, !keptAwake(tab))
          },
          { type: 'separator' },
          { label: '关闭标签页', click: () => closeTab(tab) },
          { label: '撤销关闭的标签页', enabled: recentlyClosed.length > 0, click: () => void undoClose() }
        ]
    Menu.buildFromTemplate(template).popup({ window })
  }

  /**
   * 给标签挂上用户「保持活跃」租约（幂等：显式 leaseId 让重复标记变成续租）。
   *
   * 单独拆出来是因为有两个生产者：右键菜单（`setKeepAwake`）和会话恢复
   * （历史会话里标记过的标签要在重启后重新拿到同一条租约）。
   */
  function markKeepAwake(tab: Tab): void {
    activityLeases.acquire({
      leaseId: keepAwakeLeaseId(tab),
      tabId: tab.id,
      owner: 'user',
      preventsDiscard: true,
      reason: '用户标记「保持活跃」（右键菜单）'
    })
    tab.backgroundSince = undefined
  }

  /**
   * 用户标记「保持活跃」：挂机/游戏标签不被自动休眠；取消标记后重新开始计时。
   *
   * 标记 = `user` owner 的无期限 `preventsDiscard` 租约（架构 §7 规则 3）。
   * 取消标记释放该标签上的全部 `user` 租约，而不是按 ID 删一条：即使有其他入口
   * 申请过 user 租约，用户关掉开关也应该整体生效。
   */
  function setKeepAwake(tab: Tab, value: boolean): void {
    if (value) {
      markKeepAwake(tab)
    } else {
      activityLeases.releaseOwner(tab.id, 'user')
      // 取消标记后从此刻重新计休眠时间（而不是沿用标记前的时间戳）。
      tab.backgroundSince = tab === active ? undefined : Date.now()
    }
    publish()
  }

  function reloadTab(tab: Tab): void {
    if (!tab.view) {
      // 休眠标签：重新加载等价于唤醒。
      revive(tab)
      return
    }
    const contents = tab.view.webContents
    const url = contents.isDestroyed() ? '' : safe(() => contents.getURL(), '')
    const fallback = tab.failedUrl || url || (tab.internal ? internalUrls[tab.internal] : '')
    if (contents.isDestroyed() || contents.isCrashed()) {
      if (fallback) rebuild(tab, fallback)
      return
    }
    if (tab.failedUrl) load(tab, tab.failedUrl)
    else contents.reload()
  }

  /**
   * 该标签值不值得放进「最近关闭」。
   *
   * 对齐 Chrome 的 `IsTabInteresting`（`components/sessions/core/tab_restore_service_helper.cc:1098-1109`）：
   * 只有一条导航、且就是新标签页的标签不入栈——「撤销关闭」恢复它没有任何信息量。
   * 有历史的 NTP（例如 NTP → 设置 → 后退回 NTP）仍然要能恢复。
   */
  function isRestorable(entries: NavigationEntry[]): boolean {
    if (entries.length > 1) return true
    return !!entries[0] && !isNewTabUrl(entries[0].url)
  }

  function rememberClosed(tab: Tab): void {
    // 休眠标签没有导航栈可留：只记引擎，撤销关闭时按 URL 重建。
    if (!tab.view) {
      if (tab.lastUrl && !isNewTabUrl(tab.lastUrl)) {
        recentlyClosed.push({
          entries: [], index: 0, engine: tab.engine, manualOverride: tab.manualOverride,
          internal: tab.internal, fromNewTab: tab.fromNewTab, lastUrl: tab.lastUrl
        })
        if (recentlyClosed.length > CLOSED_TAB_LIMIT) recentlyClosed.shift()
      }
      return
    }
    const contents = tab.view.webContents
    if (contents.isDestroyed()) return
    const entries = safe(() => contents.navigationHistory.getAllEntries(), [])
    if (entries.length === 0 || !isRestorable(entries)) return
    recentlyClosed.push({
      entries,
      index: safe(() => contents.navigationHistory.getActiveIndex(), entries.length - 1),
      engine: tab.engine,
      manualOverride: tab.manualOverride,
      internal: tab.internal,
      fromNewTab: tab.fromNewTab
    })
    if (recentlyClosed.length > CLOSED_TAB_LIMIT) recentlyClosed.shift()
  }

  function closeTab(tab: Tab): void {
    const index = tabs.indexOf(tab)
    if (index < 0) return
    const wasActive = active === tab
    rememberClosed(tab)
    tabs.splice(index, 1)
    // 标签关闭就清空它的全部租约：不然租约表会随着「标记过保持活跃的标签」一直长。
    activityLeases.releaseTab(tab.id)
    tab.binding += 1
    tab.host = undefined
    if (tab.view && window.contentView.children.includes(tab.view)) window.contentView.removeChildView(tab.view)
    if (active === tab) active = undefined
    if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    if (wasActive) {
      const next = tabs[index] ?? tabs[index - 1]
      select(next ?? openNewTab(), true)
    }
    publish()
  }

  /** 撤销关闭：新建 WebContents 并用 E39 导航栈恢复（架构 §3「撤销关闭」）。 */
  function undoClose(): BrowserResult {
    const closed = recentlyClosed.pop()
    if (!closed) return fail('nothing-to-undo')
    // 内部页撤销关闭要重建**内部视图**，否则会变成"内部标签里跑页面语义"。
    const tab = closed.internal
      ? openInternalTab(closed.internal)
      : addTab('新标签页', null, closed.engine, closed.manualOverride ? 'manual' : 'default')
    tab.fromNewTab = closed.fromNewTab
    select(tab, true)
    if (closed.entries.length === 0 && closed.lastUrl) {
      // 休眠标签没有导航栈：按关闭前的地址重建（与 Chrome 一样重新加载，不恢复页面状态）。
      load(tab, closed.lastUrl)
    } else {
      void restoreHistory(tab, closed.entries, closed.index,
        closed.entries[closed.index]?.url ? '无法恢复完整历史，已打开最后一个地址' : '无法恢复此前关闭的标签页')
    }
    return { ok: true, state: state() }
  }

  /** 标签排序：只改顺序，不动 WebContents（架构 §3「排序」）。 */
  /**
   * 移动标签（拖动排序）。
   *
   * 固定标签必须保持在最左的前缀里（审计 P2：原实现允许把未固定标签拖到固定标签之前，
   * 打破固定前缀）。目标位置按分组夹取，再夹到数组范围内。
   */
  function moveTab(tab: Tab, index: number): void {
    const from = tabs.indexOf(tab)
    if (from < 0 || !Number.isFinite(index)) return
    const pinnedCount = tabs.filter((item) => item.pinned).length
    const low = tab.pinned ? 0 : pinnedCount
    const high = tab.pinned ? Math.max(pinnedCount - 1, 0) : tabs.length - 1
    const to = Math.min(Math.max(Math.trunc(index), low), high)
    if (to === from) return
    tabs.splice(from, 1)
    tabs.splice(to, 0, tab)
    publish()
  }

  function cycleTab(step: number): void {
    if (!active || tabs.length < 2) return
    const index = tabs.indexOf(active)
    select(tabs[(index + step + tabs.length) % tabs.length])
  }

  /**
   * 标签级快捷键由主进程处理：页面视图获得焦点时渲染层的 keydown 收不到，
   * 只有 `before-input-event` 能覆盖「焦点在网页里」的情况（架构 §3 标签合同、§6 M1 输入）。
   */
  function handleShortcut(tab: Tab, input: Input): boolean {
    if (input.type !== 'keyDown') return false
    // F11 / Esc 是窗口级动作，不受 Ctrl 修饰键影响（架构 §3 标签合同的 F11 验证项）。
    if (input.key === 'F11') {
      window.setFullScreen(!window.isFullScreen())
      return true
    }
    if (input.key === 'Escape' && window.isFullScreen()) {
      window.setFullScreen(false)
      return true
    }
    if (!input.control || input.alt || input.meta) return false
    // Ctrl+, ：设置页（Chrome/Edge 同款入口）。
    if (input.key === ',' || input.code === 'Comma') {
      openSettingsTab()
      return true
    }
    if (input.key === 'Tab') {
      cycleTab(input.shift ? -1 : 1)
      return true
    }
    const key = input.key.toLowerCase()
    if (key === 't') {
      if (input.shift) undoClose()
      else select(openNewTab(), true)
      return true
    }
    if (key === 'w') {
      // 用事件对应的标签，而不是本窗口的 active：跨窗移交后事件仍由原监听器触发，
      // 只有按 `tab.host` 分发才不会关错窗口的标签（2026-11-23 审计 P1-4）。
      if (tabs.includes(tab)) closeTab(tab)
      return true
    }
    // Ctrl+Shift+I：页面视图的原生 DevTools（架构 §4「原生 DevTools 优先」）。
    if (key === 'i' && input.shift) {
      if (tabs.includes(tab)) toggleDevTools(tab)
      return true
    }
    return false
  }

  /** 切换当前标签页面的 DevTools。默认应用菜单被移除后这是唯一入口。 */
  function toggleDevTools(tab: Tab): void {
    if (!tab.view) return
    const contents = tab.view.webContents
    if (contents.isDestroyed()) return
    if (contents.isDevToolsOpened()) contents.closeDevTools()
    else contents.openDevTools({ mode: 'bottom' })
  }

  /** 摘除标签但保留其 WebContents：跨窗口移动时页面状态与插件内存态不变。 */
  function detachTab(id: number): { tab: Tab; index: number } | undefined {
    const index = tabs.findIndex((tab) => tab.id === id)
    if (index < 0) return undefined
    const [tab] = tabs.splice(index, 1)
    const wasActive = active === tab
    tab.host = undefined
    if (tab.view && window.contentView.children.includes(tab.view)) window.contentView.removeChildView(tab.view)
    if (wasActive) {
      active = undefined
      const next = tabs[index] ?? tabs[index - 1]
      if (next) select(next, false)
      else overlays.setActivePage(undefined)
    }
    publish()
    return { tab, index }
  }

  function adoptTab(tab: Tab, index = 0): void {
    // 不递增 binding：现有监听器仍然有效，只是改按新宿主分发。
    tab.host = controller
    tab.error = ''
    tabs.splice(Math.min(index, tabs.length), 0, tab)
    select(tab, true)
  }

  const controller: WindowController = {
    shellUrl,
    flash: plugins,
    overlays,
    snapshot: state,
    notify,
    isEmpty: () => tabs.length === 0,
    bounds: () => window.getBounds(),
    closeWindow: () => {
      if (!window.isDestroyed()) window.destroy()
    },
    detachTab,
    adoptTab,
    shortcut: handleShortcut,
    refreshSettings: () => {
      updateWindowControls()
      // 预热策略切换要立刻生效：改成「常驻」马上升温，改成「不预热」立刻释放（auto 交给 TTL）。
      const policy = currentSettings().overlayPrewarm
      if (policy === 'always') overlays.prewarm()
      else if (policy === 'never') overlays.retire()
    },
    broadcastSettings,
    ownsContents,
    internalSender,
    internalSnapshot,
    ntpSender,
    ntpSnapshot: ntpState,
    runNtp,
    run
  }

  function activeTab(): Tab | undefined {
    return active
  }

  async function run(event: IpcMainInvokeEvent, command: BrowserCommand): Promise<BrowserResult> {
    if (closing) return fail('window-closed')
    const sender = overlays.sender(event)
    if (!sender) return fail('forbidden-sender')
    if (!command || typeof command !== 'object' || typeof command.type !== 'string') {
      return fail('invalid-command')
    }
    if (sender !== 'shell' && command.type !== 'snapshot') {
      const engineAction = command.type === 'set-engine' || command.type === 'remember-engine' || command.type === 'forget-engine'
      // 齿轮飞窗（quick）只允许「写设置」和「打开设置页」；引擎面板只允许引擎操作，
      // 外加「打开设置页」（插件缺失时点 Flash 档要跳到设置页的导入入口）。
      const settingsAction = command.type === 'set-setting' || command.type === 'open-settings'
      const fromPanel = sender === 'panel' && overlays.panelVisible() &&
        (engineAction || command.type === 'open-settings')
      const fromQuick = sender === 'quick' && overlays.quickVisible() && settingsAction
      if (!fromPanel && !fromQuick) return fail('forbidden-sender')
    }

    switch (command.type) {
      case 'snapshot':
        break
      case 'add':
        select(openNewTab(), true)
        break
      case 'open-settings':
        openSettingsTab()
        break
      case 'select':
      case 'close': {
        const tab = tabs.find(({ id }) => id === command.id)
        if (!tab) return fail('unknown-tab')
        if (command.type === 'select') select(tab)
        else closeTab(tab)
        break
      }
      case 'duplicate':
      case 'pin':
      case 'mute':
      case 'tab-menu': {
        const tab = tabs.find(({ id }) => id === command.id)
        if (!tab) return fail('unknown-tab')
        if (command.type === 'duplicate') duplicateTab(tab)
        else if (command.type === 'pin') setPinned(tab, !tab.pinned)
        else if (command.type === 'mute') toggleMuted(tab)
        else showTabMenu(tab)
        break
      }
      case 'keep-awake': {
        const tab = tabs.find(({ id }) => id === command.id)
        if (!tab) return fail('unknown-tab')
        setKeepAwake(tab, command.value)
        break
      }
      // 崩溃恢复的两个回答（只有外壳能发，sender 校验在前面已经收窄）。
      case 'restore-session':
        if (!crashSession) return fail('no-session')
        restoreCrashSession()
        break
      case 'dismiss-session':
        if (!crashSession) return fail('no-session')
        dismissCrashSession()
        break
      case 'tearoff':
        return tearOffTab(controller, command)
      case 'undo-close':
        return undoClose()
      case 'set-engine': {
        const tab = activeTab()
        if (!tab) return fail('unknown-tab')
        // 内部页没有引擎：静默换视图会让设置页变成网页容器。
        if (tab.internal) return fail('invalid-command')
        if (command.engine !== 'ppapi' && command.engine !== 'ruffle') return fail('invalid-command')
        if (command.engine === 'ppapi' && !plugins) return fail('engine-unavailable')
        try {
          switchEngine(tab, command.engine)
        } catch (error) {
          console.error('无法切换渲染引擎。', error)
          return fail('engine-switch-failed')
        }
        break
      }
      case 'remember-engine':
      case 'forget-engine': {
        const tab = activeTab()
        if (!tab) return fail('unknown-tab')
        if (tab.internal) return fail('no-site')
        return command.type === 'remember-engine' ? rememberActiveEngine(tab) : forgetActiveEngine(tab)
      }
      /**
       * 设置写入（架构 §4 数据）。
       *
       * 顺序是刻意的：先落库（失败就返回稳定错误码、**不应用**），成功后才广播。
       * 反过来的话，磁盘满/只读时会变成「界面变了但重启后自己变回去」。
       */
      case 'set-setting': {
        const outcome = setSetting(command.key, command.value)
        if (outcome === 'invalid') return fail('invalid-setting')
        if (outcome === 'unavailable') return fail('storage-unavailable')
        if (outcome === 'save-failed') return fail('settings-save-failed')
        refreshAllWindows()
        break
      }
      case 'move': {
        const tab = tabs.find(({ id }) => id === command.id)
        if (!tab) return fail('unknown-tab')
        moveTab(tab, command.index)
        break
      }
      case 'navigate':
        return navigateTab(activeTab(), command.address)
      case 'back': {
        const tab = activeTab()
        if (!tab) return fail('unknown-tab')
        if (tab.internal) {
          if (!tab.view) return fail('unknown-tab')
          tab.view.webContents.navigationHistory.goBack()
          break
        }
        const contents = tab.view?.webContents
        const canGoBack = !!contents && !contents.isDestroyed() &&
          safe(() => contents.navigationHistory.canGoBack(), false)
        // 最早一条历史再往后退：这个标签是从新标签页进来的 → 回到 NTP。
        if (!canGoBack && tab.fromNewTab) {
          returnToNewTab(tab)
          break
        }
        if (!contents) return fail('unknown-tab')
        contents.navigationHistory.goBack()
        break
      }
      case 'forward': {
        const tab = activeTab()
        if (!tab) return fail('unknown-tab')
        if (tab.internal === 'newtab' && tab.newTabForwardUrl) {
          const view = tab.view
          const canForward = !!view && safe(() => view.webContents.navigationHistory.canGoForward(), false)
          if (!canForward) {
            leaveNewTab(tab, tab.newTabForwardUrl)
            break
          }
        }
        if (!tab.view) return fail('unknown-tab')
        tab.view.webContents.navigationHistory.goForward()
        break
      }
      case 'reload': {
        const tab = activeTab()
        if (!tab) return fail('unknown-tab')
        reloadTab(tab)
        break
      }
      default:
        return fail('invalid-command')
    }
    return { ok: true, state: state() }
  }

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('before-input-event', (event, input) => {
    if (overlays.escape(input) || (active && handleShortcut(active, input))) event.preventDefault()
  })
  window.webContents.on('will-frame-navigate', (event) => event.preventDefault())
  window.webContents.on('will-redirect', (event) => event.preventDefault())

  function updateWindowControls(): void {
    if (closing || window.isDestroyed()) return
    window.setTitleBarOverlay({
      ...windowPalette[currentTheme()],
      height: TAB_BAR_HEIGHT
    })
    publish()
  }

  /** 设置变化后推给本窗口的内部页：设置页拿设置快照，新标签页拿 NTP 快照。 */
  function broadcastSettings(): void {
    const settingsSnapshot = internalSnapshot()
    const ntpSnapshot = ntpState()
    for (const tab of tabs) {
      const contents = tab.view?.webContents
      if (!contents || contents.isDestroyed()) continue
      if (tab.internal === 'settings') contents.send(settingsChannels.changed, settingsSnapshot)
      else if (tab.internal === 'newtab') contents.send(ntpChannels.changed, ntpSnapshot)
    }
  }

  function ownsContents(contentsId: number): boolean {
    return tabs.some((tab) => tab.view?.webContents.id === contentsId)
  }

  /**
   * 内部设置页的可信判定（三条件同时成立）：
   * ① 是本窗口亲自创建的内部页标签视图；② 是主帧；③ 文档 URL ∈ `bao://settings/*`。
   *
   * 普通页面三条都过不了：它不在标签的 `internal` 集合里，也已被 `guardContents`
   * 的 allow 拦在 `bao://` 之外；`registerPageView` / `overlays.sender` 两条既有特权
   * 通道对它同样是关闭的。
   */
  function internalSender(event: IpcMainInvokeEvent): boolean {
    if (closing) return false
    const tab = tabs.find((item) => item.internal === 'settings' && item.view?.webContents.id === event.sender.id)
    if (!tab) return false
    const frame = event.senderFrame
    if (!frame || frame !== event.sender.mainFrame) return false
    return isSettingsUrl(frame.url)
  }

  /**
   * 新标签页的可信判定（与设置页同构的三条件）：
   * ① 是本窗口亲自创建的新标签页视图；② 是主帧；③ 文档 URL ∈ `bao://newtab/*`。
   */
  function ntpSender(event: IpcMainInvokeEvent): boolean {
    if (closing) return false
    const tab = tabs.find((item) => item.internal === 'newtab' && item.view?.webContents.id === event.sender.id)
    if (!tab) return false
    const frame = event.senderFrame
    if (!frame || frame !== event.sender.mainFrame) return false
    return isNewTabUrl(frame.url)
  }

  /** 新标签页读到的状态：设置子集 + 解析后的主题 + 插件可用性。 */
  function ntpState(): NtpSnapshot {
    const settings = currentSettings()
    return {
      theme: currentTheme(),
      settings: {
        themeMode: settings.themeMode,
        defaultEngine: settings.defaultEngine,
        locale: settings.locale
      },
      flash: plugins,
      flashHint: plugins ? undefined : options.flashHint,
      storage: storageStatus()
    }
  }

  /**
   * 新标签页的两个动词。
   *
   * 两个动作都会让发送方文档消失（设置页覆盖 NTP，或 NTP 换成页面视图），所以先返回
   * IPC 结果、再用 `setImmediate` 执行——否则回复会打在已销毁的帧上。
   */
  function runNtp(event: IpcMainInvokeEvent, command: NtpCommand): NtpCommandResult {
    const tab = tabs.find((item) => item.internal === 'newtab' && item.view?.webContents.id === event.sender.id)
    if (!tab || !isNewTabUrl(safe(() => tab.view?.webContents.getURL() ?? '', ''))) {
      return { ok: false, code: 'forbidden-sender' }
    }
    if (!command || typeof command !== 'object' || typeof command.type !== 'string') {
      return { ok: false, code: 'invalid-command' }
    }
    if (command.type === 'open-settings') {
      setImmediate(() => { if (!closing) openSettingsTab() })
      return { ok: true }
    }
    if (command.type === 'navigate') {
      const url = parseAddress(typeof command.address === 'string' ? command.address : '')
      if (!url) return { ok: false, code: 'invalid-address' }
      setImmediate(() => { if (!closing && tabs.includes(tab)) navigateTab(tab, url) })
      return { ok: true }
    }
    return { ok: false, code: 'invalid-command' }
  }

  /**
   * 系统主题变化（`themeSource: 'system'` 时由操作系统触发）：
   * 外壳/叠加层重绘 + 内部页也要拿到新的解析主题，否则设置页会停在上一个亮/暗。
   */
  function onNativeThemeUpdated(): void {
    updateWindowControls()
    broadcastSettings()
    // 叠加层常驻（合并视图后一直存在），主题变化必须主动推给它；
    // 之前靠「打开飞窗时顺带 publish」偶然生效，并行/预热的时序一变就漏。
    publish()
  }

  nativeTheme.on('updated', onNativeThemeUpdated)
  window.on('resize', layout)
  // 后台标签休眠扫描：每 30 秒一次；开关在设置里（`tab.discard = never` 时整个机制停用，
  // 挂机/自动化场景需要后台标签一直运行）。
  const discardTimer = setInterval(sweepDiscard, DISCARD_SWEEP_MS)
  window.on('closed', () => {
    // 最早抓一次会话投影：后面会逐个关闭 WebContents，标题/地址会退化成空值。
    const finalSession = sessionWindowSnapshot()
    clearInterval(discardTimer)
    closing = true
    controllers.delete(shellContentsId)
    overlays.dispose()
    nativeTheme.off('updated', onNativeThemeUpdated)
    for (const tab of tabs) {
      tab.binding += 1
      tab.host = undefined
      // 窗口关闭只清理**仍属于本窗口**的标签租约：拖出中的标签已从 `tabs` 摘除，
      // 它的租约必须跟着 tabId 活到新窗口（架构 §7：租约按稳定业务身份归属）。
      activityLeases.releaseTab(tab.id)
      if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    }
    tabs.length = 0
    active = undefined
    // 会话固化：还有别的窗口时，本窗口应从会话里消失；退出过程中或最后一个窗口时保留
    // （Windows 上关掉最后一个窗口就是退出，保留它下次才能恢复）。
    sessionWindows.set(shellContentsId, finalSession)
    if (!sessionQuitting && sessionWindows.size > 1) sessionWindows.delete(shellContentsId)
    writeSessionNow()
  })

  controllers.set(shellContentsId, controller)

  if (options.adopt) {
    // 两阶段接管（2026-11-23 审计 P1-4）：接管放到外壳加载成功之后。
    // 原先先接管再 loadURL，一旦窗口创建/加载失败，`window.on('closed')` 会把
    // 被移交标签的 WebContents 一起关掉，源窗口再想接回时页面已经没了。
  } else if (options.initialAddress) {
    // 命令行带了地址：首个标签按站点规则决定引擎后直接打开（此时不会提示恢复会话）。
    const resolved = engineFor(options.initialAddress)
    const opened = addTab('新标签页', options.initialAddress, resolved.engine, resolved.source)
    select(opened, true)
  } else if (options.initialSession && sessionTabCount(options.initialSession) > 0) {
    // 设置项 `session.startup = continue`：用户主动要求每次恢复，不再提示。
    applySession(options.initialSession)
  } else {
    // 启动只开一个标签页：正常退出后重启**不恢复**会话，崩溃恢复也要等用户点提示条。
    // 多标签由「新建标签页」、崩溃恢复与冒烟测试覆盖。
    select(openNewTab(), false)
  }

  try {
    await window.loadURL(shellUrl)
    if (options.adopt) adoptTab(options.adopt, options.adoptIndex ?? 0)
    if (hidden) {
      // 保持 show:false：屏幕与任务栏都不出现（代价：Ruffle 出帧会被节流）。
    } else if (background) {
      applyAutomationWindowMode(window)
    } else {
      window.show()
      // 预热飞窗：这里外壳文档已经加载完（上面的 await loadURL），立刻建隐藏的叠加层视图，
      // 用户看到窗口、把鼠标移过去时它通常已经热了。自动化模式不预热——那会给
      // 「页面视图计数」类断言多一个子视图。飞窗只有一个视图（panel/quick 共用），预热一次就够。
      // 预热策略（设置项 overlay.prewarm）：
      // - always：窗口创建即常驻（最快，占 ~100 MB）；
      // - auto（默认）：入口悬停时预热，空闲 5 分钟回收；
      // - never：完全不预热，用到才建。
      // BAO_NO_PREWARM=1 只用于度量。
      if (!closing && !window.isDestroyed() && process.env.BAO_NO_PREWARM !== '1' &&
          currentSettings().overlayPrewarm === 'always') overlays.prewarm()
    }
  } catch (error) {
    closing = true
    controllers.delete(shellContentsId)
    if (!window.isDestroyed()) window.destroy()
    throw error
  }
}

/**
 * 自动化窗口模式：把窗口做成「可见但完全不可见」。
 *
 * - 未打包构建 + `BAO_SMOKE_BACKGROUND=1`：跳过任务栏、透明（opacity 0）、不可聚焦、
 *   `showInactive()`（不激活）；仍然是一次正常 show，所以渲染/合成不被节流。
 * - `BAO_SMOKE_HIDDEN=1`：直接隐藏（更安静，但 Ruffle 出帧会被节流）。
 *
 * 关掉焦点是刻意的：`webContents.focus()`（切标签、引擎切换）会激活窗口，所以还挂了
 * 「被激活就 blur」的守卫，保证整轮跑动中前台焦点不被打断。
 */
function applyAutomationWindowMode(window: BrowserWindow): void {
  if (!background || window.isDestroyed()) return
  window.on('focus', () => {
    if (!window.isDestroyed()) window.blur()
  })
  window.showInactive()
}

/** 新窗口落在拖放点附近，并夹到最近的显示器工作区内。 */
function placeWindow(options: BrowserWindowOptions): { x?: number; y?: number; width: number; height: number } {
  const width = options.width ?? 1100
  const height = options.height ?? 760
  if (options.x === undefined || options.y === undefined) return { width, height }
  const { workArea } = screen.getDisplayNearestPoint({ x: options.x, y: options.y })
  return {
    width: Math.min(width, workArea.width),
    height: Math.min(height, workArea.height),
    x: Math.min(Math.max(options.x - 120, workArea.x), workArea.x + workArea.width - Math.min(width, workArea.width)),
    y: Math.min(Math.max(options.y - 16, workArea.y), workArea.y + workArea.height - Math.min(height, workArea.height))
  }
}

/**
 * 把标签拖出窗口（架构 §3「拖出窗口」、审计 §3 跨窗口移交）。
 * 同一 WebContents 换宿主，页面状态与插件内存态保留；新建窗口失败时退回原窗口。
 */
async function tearOffTab(
  source: WindowController,
  command: Extract<BrowserCommand, { type: 'tearoff' }>
): Promise<BrowserResult> {
  const bounds = source.bounds()
  const inside = command.screenX >= bounds.x && command.screenX < bounds.x + bounds.width &&
    command.screenY >= bounds.y && command.screenY < bounds.y + bounds.height
  if (inside) return { ok: true, state: source.snapshot() }

  const detached = source.detachTab(command.id)
  if (!detached) return fail('unknown-tab')

  try {
    await createBrowserWindow({
      shellUrl: source.shellUrl,
      flash: source.flash,
      adopt: detached.tab,
      adoptIndex: detached.index,
      x: command.screenX,
      y: command.screenY,
      width: bounds.width,
      height: bounds.height
    })
  } catch (error) {
    // 两阶段接管后正常路径下视图仍然存活；仍加一道守卫，避免把已销毁的页面挂回去。
    if (detached.tab.view?.webContents.isDestroyed()) {
      console.error('跨窗口移动失败，且被移交页面已销毁。', error)
      return fail('tearoff-failed')
    }
    source.adoptTab(detached.tab, detached.index)
    console.error('跨窗口移动失败，标签已退回原窗口。', error)
    return fail('tearoff-failed')
  }

  if (source.isEmpty()) source.closeWindow()
  return { ok: true, state: source.snapshot() }
}

let registered = false

/** 设置是进程级的：一处改动后所有窗口都要重绘（主题/标题栏 overlay/默认引擎）。 */
function refreshAllWindows(): void {
  for (const controller of controllers.values()) {
    controller.refreshSettings()
    controller.broadcastSettings()
  }
}

function controllerFor(event: IpcMainInvokeEvent): WindowController | undefined {
  const shell = controllers.get(event.sender.id)
  if (shell) return shell
  for (const controller of controllers.values()) {
    if (controller.overlays.sender(event)) return controller
    // 内部设置页（WebContentsView）：按"本窗口的标签表"认领，拖出窗口后仍然成立。
    if (controller.ownsContents(event.sender.id)) return controller
  }
}

/** 全局只注册一次命令通道，按发送者窗口路由；窗口关闭不注销该通道。 */
export function registerBrowserIpc(): void {
  if (registered) return
  registered = true
  ipcMain.handle(browserChannels.command, (event, command: unknown) => {
    const controller = controllerFor(event)
    if (!controller) return fail('forbidden-sender')
    return controller.run(event, command as BrowserCommand)
  })
  ipcMain.handle(overlayChannels.command, (event, command: unknown) =>
    controllerFor(event)?.overlays.command(event, command) ?? false)

  /**
   * 内部设置页的窄通道（架构 §4 数据 + §3 IPC）。
   *
   * 和 `browser:command` 分开注册是刻意的：这个通道**只**接受内部页主帧，
   * 外壳/叠加层/页面都拿不到它；反过来内部页也拿不到 `baoBrowser`。
   */
  ipcMain.handle(settingsChannels.read, (event) => {
    const controller = controllerFor(event)
    if (!controller || !controller.internalSender(event)) return undefined
    return controller.internalSnapshot()
  })
  ipcMain.handle(settingsChannels.write, (event, payload: unknown) => {
    const controller = controllerFor(event)
    if (!controller || !controller.internalSender(event)) {
      return { ok: false, code: 'forbidden-sender' }
    }
    const record = (payload ?? {}) as { key?: unknown; value?: unknown }
    const outcome = setSetting(record.key, record.value)
    if (outcome === 'invalid') return { ok: false, code: 'invalid-setting' }
    if (outcome === 'unavailable') return { ok: false, code: 'storage-unavailable' }
    if (outcome === 'save-failed') return { ok: false, code: 'settings-save-failed' }
    refreshAllWindows()
    return { ok: true, snapshot: controller.internalSnapshot() }
  })

  /**
   * 新标签页的窄通道（`bao://newtab`）。
   *
   * 与设置页同构：只接受本窗口新标签页的主帧；设置页、外壳与网页都拿不到这个通道。
   */
  ipcMain.handle(ntpChannels.read, (event) => {
    const controller = controllerFor(event)
    if (!controller || !controller.ntpSender(event)) return undefined
    return controller.ntpSnapshot()
  })
  ipcMain.handle(ntpChannels.command, (event, command: unknown) => {
    const controller = controllerFor(event)
    if (!controller || !controller.ntpSender(event)) return { ok: false, code: 'forbidden-sender' }
    return controller.runNtp(event, command as NtpCommand)
  })

  /**
   * Flash 插件状态 / 导入 / 定位（BYOP）。
   *
   * 只有内部设置页能调；对话框与调用哪个路径都由主进程决定（页面拿不到任意文件路径）。
   * 导入只把文件复制到 `<userData>/flash/`，插件注册发生在下一次启动，所以结果里带
   * `restartRequired`。「打开所在文件夹」只接受主进程自己解析出来的路径。
   */
  // 叠加层耗时度量（临时）：只有外壳能读，用来决定「悬停预热」是否值得。
  ipcMain.handle(overlayChannels.metrics, (event) => {
    const controller = controllerFor(event)
    if (!controller || controller.overlays.sender(event) !== 'shell') return undefined
    return controller.overlays.metrics()
  })
  ipcMain.handle(overlayChannels.metricsReset, (event) => {
    const controller = controllerFor(event)
    if (!controller || controller.overlays.sender(event) !== 'shell') return false
    return controller.overlays.resetMetrics()
  })
  ipcMain.handle(settingsChannels.flashStatus, (event) => {
    const controller = controllerFor(event)
    if (!controller || !controller.internalSender(event)) return undefined
    return flashStatus()
  })
  ipcMain.handle(settingsChannels.flashReveal, (event) => {
    const controller = controllerFor(event)
    if (!controller || !controller.internalSender(event)) return false
    // 路径只来自主进程解析结果：页面传什么都不采信。
    const status = flashStatus()
    if (!status.found) return false
    shell.showItemInFolder(status.path)
    return true
  })
  ipcMain.handle(settingsChannels.flashImport, async (event) => {
    const controller = controllerFor(event)
    if (!controller || !controller.internalSender(event)) return { ok: false, code: 'forbidden-sender' }
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: '选择 Flash 插件',
      properties: ['openFile'],
      filters: process.platform === 'win32'
        ? [{ name: 'Flash 插件', extensions: ['dll'] }]
        : [{ name: 'Flash 插件', extensions: ['so', 'dylib'] }]
    }
    const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, code: 'cancelled' }
    return importFlashPlugin(picked.filePaths[0], flashLoadedPath())
  })
}
