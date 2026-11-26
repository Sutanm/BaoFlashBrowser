import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, shell, WebContentsView, webContents } from 'electron'
import { backgroundSmoke as background, hiddenSmoke as hidden } from './automation'
import type { Input, IpcMainInvokeEvent, MenuItemConstructorOptions, NavigationEntry, Rectangle, WebContents } from 'electron'
import { join } from 'node:path'
import { isWebAddress, placeholderTitle, resolveNavigation, sameDocument } from './address'
import { FlashPresenceCache, detectFlashContent } from './flash-probe'
import { browserChannels, browserFailureText, INFOBAR_HEIGHT, TAB_BAR_HEIGHT, TOOLBAR_HEIGHT } from '../shared/browser'
import type { BrowserCommand, BrowserFailureCode, BrowserResult, BrowserSessionPrompt, BrowserState, BrowserTab } from '../shared/browser'
import { hostOf } from '../shared/engine'
import { isSameSite, siteBoundary } from '../shared/site'
import type { BrowserEngine, EngineSource } from '../shared/engine'
import { HeartbeatMonitor } from './heartbeat'
import type { HeartbeatStats } from './heartbeat'
import { heartbeatChannels } from '../shared/heartbeat'
import { getInternalSession, getPageSession, getShellSession } from './sessions'
import { bindRuffleProtocol } from './ruffle'
import { registerPageView } from './page-views'
import * as engineRules from './engine-rules'
import { clearEngineRulesData, clearSessionData, setSetting, settings as currentSettings, saveSession, storageStatus } from './storage'
import { bindInternalProtocol, internalKindOf, internalUrls, isInternalUrl, isNewTabUrl, isSettingsUrl, parseInternalAddress, SETTINGS_URL } from './internal-pages'
import type { InternalKind } from './internal-pages'
import { settingsChannels } from '../shared/settings'
import type { PrewarmMode, SettingsSnapshot } from '../shared/settings'
import { ntpChannels } from '../shared/ntp'
import type { NtpCommand, NtpCommandResult, NtpSnapshot } from '../shared/ntp'
import { importFlashPlugin } from './flash-plugin'
import { flashLoadedPath, flashStatus } from './plugins'
import { shellThemes, windowPalette } from '../shared/shell-theme'
import type { ShellTheme } from '../shared/shell-theme'
import { overlayChannels } from '../shared/overlay'
import { createShellOverlays } from './shell-overlays'
import { attachPopupChrome } from './popup-chrome'
import { activityLeases } from './activity-lease'
import { tabRegistry } from './tab-registry'
import type { TabLifecycleKind } from './tab-registry'
import { CapabilityCallLog, validateCapabilityCall } from './capability-contract'
import type { CapabilityTabSnapshot, CapabilityWorld } from './capability-contract'
import { DEFAULT_PROFILE_ID, browserCodeFor, capabilityFailureText, isShellRef } from '../shared/capability'
import type { ActionContext, CapabilityInvocation } from '../shared/capability'
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
/**
 * 一次两阶段引擎切换的候选状态。
 *
 * 准备期间 `tab.view` / `tab.engine` 与账本里的绑定代际全部保持旧值；候选视图先按
 * `binding`（旧代际 + 1）绑定，事件在提交前因账本代际未变而全部作废。
 * 只有 `prepare` 成功且 token 仍是当前尝试时才允许提交；其余情况一律只清理候选。
 */
interface EngineAttempt {
  token: number
  engine: BrowserEngine
  source: EngineSource
  view: WebContentsView
  /** 候选视图将要使用的绑定代际（提交时由 `tabRegistry.commitReserved()` 生效）。 */
  binding: number
  cancelled: boolean
  cancelSignal: Promise<'cancelled'>
  cancel: () => void
}

interface Tab {
  id: number
  /** 休眠（丢弃）时为空：省掉一整个渲染进程，切回时按 lastUrl 重建。 */
  view?: WebContentsView
  // `binding` / `navigation` 代际不在标签上：由 `tabRegistry` 持有（A1-b），镜像字段已删除。
  /**
   * 导航代际：普通导航、重定向与同文档历史更新都会推进（由 	abRegistry.bumpNavigation() 推进）。
   *
   * 为什么它不在标签字段上：引擎切换的准备阶段旧页仍然可交互，用户可以在那时导航；
   * 提交时必须比对代际，否则会把用户刚导航到的页面换回快照里的旧地址（2026-11-26 审计复现）。
   * 代际只有一个权威（	abRegistry），标签上留一份副本迟早不一致。
   */
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
  /** 两阶段引擎切换：正在准备的候选视图（提交前 `view`/`engine`/`binding` 仍是旧值）。 */
  engineSwitch?: EngineAttempt
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
   * 最近一次**请求加载**的地址（`load()` 写入）。
   *
   * 与 `lastUrl`（休眠缓存）分开：文档还没提交时 `getURL()` 是空串，而库里/地址栏需要的
   * 是"用户要去的那个地址"。没有它会出现两个真实故障（2026-11-26）：
   * ① 地址栏回车后立刻被清空（投影 address 为空）→ 看起来"地址栏没反应"；
   * ② 会话投影里出现 `url: ''` 的标签 → `sanitizeSession` 整条丢弃 → 整份载荷被拒
   *   （`INVALID_PARAM`）。它只用于展示与恢复，**不参与加载决策**：`revive()` 仍走
   *   `lastUrl`，导航永远以 `getURL()` 为准。
   */
  requestedUrl?: string
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
  /**
   * 在**当前宿主窗口**开一个新标签（无 features 的 `window.open` / `target=_blank`）。
   *
   * 必须由事件发生时的 `tab.host` 解析，而不是创建视图时捕获的窗口：标签可以跨窗口
   * 移交，旧窗口也可能已经关闭。
   */
  openTab(url: string): void
}

interface WindowController extends TabHost {
  readonly shellUrl: string
  readonly flash: boolean
  snapshot(): BrowserState
  run(event: IpcMainInvokeEvent, command: BrowserCommand): BrowserResult | Promise<BrowserResult>
  readonly overlays: ReturnType<typeof createShellOverlays>
  detachTab(id: number): { tab: Tab; index: number } | undefined
  adoptTab(tab: Tab, index?: number, options?: { wake?: boolean }): void
  /** 心跳回执（主进程主动测外壳渲染线程是否还能干活）。 */
  heartbeatPong(seq: number): void
  heartbeatStats(): HeartbeatStats
  /** 清空心跳样本（诊断/测试用）。 */
  heartbeatReset(): void
  isEmpty(): boolean
  /** 窗口仍可接收标签：未请求关闭、未进入关闭流程、未销毁。 */
  isAlive(): boolean
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
  /** 新标签页的窄命令：打开设置、在本标签导航、切换主题。 */
  runNtp(event: IpcMainInvokeEvent, command: NtpCommand): NtpCommandResult
  /** 会话数据被用户清除：丢掉仍挂着的崩溃恢复提示（库里已经没有了）。 */
  forgetSessionPrompt(): void
  /** 规则/设置变化后重新投影（引擎来源胶囊要立刻按新规则重算）。 */
  refreshProjection(): void
  /**
   * 冒烟诊断：每个标签的**实际**视图、绑定代际与未提交候选。
   *
   * 只用于验证「提交/回退/清理」的真实现场；不进入 `BrowserState` 投影，也不经过 IPC。
   */
  debugState(): Array<{
    id: number
    engine: BrowserEngine
    binding: number
    viewId?: number
    viewAlive: boolean
    pendingEngine?: BrowserEngine
  }>
}

/**
 * 共享进程模式：浮层由外壳 `window.open` 产生并复用外壳的渲染进程。
 *
 * **默认开启**（实测常驻 +114 MB → +6 MB，冷路径端到端 218 ms → 144 ms）；`BAO_OVERLAY_SHARED=0`
 * 可以退回"每个浮层一个渲染进程"的老路径（故障域隔离，用于对照或排查）。
 *
 * 代价与兜底：故障域与事件循环都合并了（崩浮层 = 崩外壳，浮层长任务会卡住工具栏）。
 * 外壳 `render-process-gone` 会重载外壳文档自愈，标签由主进程状态重建。
 * 准入规则：浮层只能是外壳自己的同源文档，导航一律钉死。
 * 见 docs/discussions/2026-11-25-overlay-shared-process-demo.md
 */
const sharedOverlayMode = (): boolean => process.env.BAO_OVERLAY_SHARED !== '0'

/**
 * 预热策略（设置项 `overlay.prewarm`）的**唯一入口**。
 *
 * 为什么不让调用点各自读 `currentSettings().overlayPrewarm`：共享进程模式下
 * "预热"要由外壳文档执行（它才是 `window.open` 的发起者），主进程只回答"准不准"。
 * 策略一旦两处各读一次，就会出现"主进程以为预热了、渲染层却照旧冷开"这种对不上的状态
 * ——`overlay.prewarm=never` 在共享模式下长期被忽略，正是这么来的。
 *
 * `BAO_OVERLAY_PREWARM` 仅供测试/度量强制一档（与 `BAO_OVERLAY_SHARED` 同类）。
 * 只接受开/关两个值：中间档 `auto` 已于 2026-11-26 删除（见 `PREWARM_MODES`）。
 */
function overlayPrewarmPolicy(): PrewarmMode {
  const forced = process.env.BAO_OVERLAY_PREWARM
  if (forced === 'always' || forced === 'never') return forced
  return currentSettings().overlayPrewarm
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
/**
 * 两阶段引擎切换：候选视图等待「加载完成」的上限。
 *
 * 这不是成功判据（成功只认 did-finish-load），只是防止页面永远不触发加载事件时
 * 把标签卡在准备态；超时按准备失败处理，旧视图继续可用。
 */
const ENGINE_PREPARE_TIMEOUT_MS = 15_000

type EnginePrepareOutcome =
  | { status: 'prepared' }
  | { status: 'degraded'; url: string }
  | { status: 'failed'; reason: string }

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

/**
 * 统一能力层的调用记录（A1-c）。进程级单例：审计要看的是"整个浏览器发生过什么"，
 * 不是"某个窗口发生过什么"。A5 的审计导出会在这里接。
 */
const capabilityCalls = new CapabilityCallLog()
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
/**
 * 崩溃恢复提示「还没被回答」时为 true（模块级，跨窗口）。
 *
 * 为什么不能用窗口内的 `crashSession` 判断：用户可以直接关掉带提示的窗口——那一刻
 * `crashSession` 随窗口销毁，但磁盘上那份待恢复会话**一条都没少**。退出时若据此写
 * `clean`，下次启动就不再提示，随后一次写盘就把原 URL 覆盖没了（2026-11-26 审计）。
 */
let restorePromptPending = false

/** 是否有待恢复会话仍在等用户决定（`index.ts` 的退出标记据此决定写 `pending` 还是 `clean`）。 */
export function sessionRestorePending(): boolean {
  return restorePromptPending
}

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
  // 投影侧已经把「不可恢复的标签」滤掉了（见 `sessionWindowSnapshot()`），所以这里数的
  // 就是**校验后的**数量：与 `writeSession()` 的判据同源，不会出现"有标签但全被拒"。
  const tabCount = snapshot.windows.reduce((total, window) => total + window.tabs.length, 0)
  if (tabCount === 0) {
    /**
     * 本次**没有任何可恢复的标签**（典型：只开着设置页，它不落盘；或唯一那个标签还停在
     * 首帧前的空地址上）。
     *
     * 这里不能"什么都不做"：`writeSession()` 会以「载荷未通过校验」拒绝空投影，磁盘上那份
     * 旧会话原样留下，下次启动就会提示恢复用户早就关掉的标签（2026-11-26 审计）。
     * 正确语义是**清掉**它——「没有可恢复的标签」和「保存失败」必须能区分。
     */
    if (!clearSessionData()) {
      console.error('[session] 会话已空，但旧载荷清除失败；下次启动可能重现已关闭的标签。')
    }
    return
  }
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
  // 挂起要连**排队中的**写盘一起取消，否则刚挂起就被一次迟到的节流写穿透。
  if (sessionTimer) {
    clearTimeout(sessionTimer)
    sessionTimer = undefined
  }
}

/**
 * 清除已保存的会话（设置页「数据」分区的分类清理）。
 *
 * 三件事缺一不可：
 * 1. 删库里的会话载荷与退出标记（`clearSessionData`）；
 * 2. 挂起本次运行的会话记录——否则 800 ms 后的一次节流写会把当前标签又写回去，
 *    用户看到"清除了但还在"；
 * 3. 清掉仍挂着的崩溃恢复提示：那份会话在内存里，留着会出现"库里已删、按钮还在"的矛盾。
 *
 * 返回 false 只表示存储不可用或写入失败（UI 据此提示），不影响正在浏览的标签。
 */
export function clearStoredSession(): boolean {
  if (!clearSessionData()) return false
  holdSession()
  for (const controller of controllers.values()) controller.forgetSessionPrompt()
  return true
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

// 地址解析、占位标题、同文档判定在 `./address`（纯函数 + 单测）：它们的边界值得被单独钉住，
// 而不是靠 30 个 smoke 文件才发现改错了。

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
  // 冒烟故障注入点：只在跨窗口接管路径生效（不影响普通启动/弹窗）。
  await injectAdoptFault(options)
  const pageSession = getPageSession()
  // Ruffle 资源协议按页面会话绑定（每个会话一次）。
  bindRuffleProtocol(pageSession)
  // 内部页协议只绑内部会话（幂等）：页面会话里加载 `bao://` 会被直接拒绝。
  // 第三个参数是首帧引导数据：`bao://` 的 HTML 在返回前就带上主题变量与快照，
  // 于是第一帧就是真页面（不再需要 `newtab.html` 里手抄的骨架与配色副本）。
  bindInternalProtocol(getInternalSession(), (kind) => ({
    theme: currentTheme(),
    snapshot: kind === 'settings' ? internalSnapshot() : ntpState()
  }))
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
  const overlays = createShellOverlays(window, shellUrl, sameDocument, (input) => (active ? handleShortcut(active, input) : false), currentTheme, () => !hidden && !background, overlayPrewarmPolicy, sharedOverlayMode)
  const tabs: Tab[] = []
  const recentlyClosed: ClosedTab[] = []
  let active: Tab | undefined
  let revision = 0
  /** 两阶段引擎切换的尝试序号：只有当前尝试允许提交。 */
  let engineSequence = 0
  let closing = false
  /** 已经收到 `close`（窗口正在关闭）：此时不能再把标签回挂进来。 */
  let closeRequested = false
  /** 崩溃会话：用户点「恢复」之前一直挂着，不自动建标签。 */
  let crashSession = options.crashSession
  // 有待恢复会话 = 提示待回答（跨窗口；见模块级 `restorePromptPending`）。
  if (crashSession) restorePromptPending = true

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

  /**
   * 地址栏与会话投影要显示的地址（单一实现，两处共用）。
   *
   * 三个真实约束叠在这里：
   * 1. 文档还没提交（首帧前、DNS 未返回）时 `getURL()` 是**空串** → 用 `requestedUrl`；
   * 2. 已经在一个页面上、又发起了新导航且尚未提交时，`getURL()` 是**旧文档**的地址 →
   *    仍要显示 `requestedUrl`，否则地址栏停在旧地址，看起来"回车没反应"（2026-11-26 实测）；
   * 3. 历史前进/后退不经过 `load()`，所以 `requestedUrl` 会在**提交时**清掉
   *    （见 `did-navigate`）——否则 Back 之后地址栏会一直显示上一次输入的地址。
   *
   * 内部页按 Chrome 的语义：设置页立刻显示 `bao://settings/`，新标签页不显示地址。
   */
  function displayAddress(tab: Tab, liveUrl: string): string {
    if (tab.failedUrl) return tab.failedUrl
    if (tab.internal === 'settings') return liveUrl || SETTINGS_URL
    if (tab.internal === 'newtab') return ''
    const requested = tab.requestedUrl && tab.requestedUrl !== liveUrl ? tab.requestedUrl : ''
    return requested || liveUrl || tab.lastUrl || ''
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
    const address = displayAddress(tab, url)
    const pin = engineRules.resolve(hostOf(address))
    /**
     * 标题的「占位」判定只认**已提交文档**的地址，不能用 `address`。
     *
     * `displayAddress()` 在导航未提交时给的是**目标地址**，而此刻 Chromium 的临时标题是
     * `loading`（英文占位）——拿目标地址去比判定不出占位，标签栏就会显示一个 `loading`。
     * 用已提交的地址（或休眠前的 `lastUrl`）比较，行为与本次改动之前一致。
     */
    const committed = tab.failedUrl ?? (url || tab.lastUrl || '')
    return {
      id: tab.id,
      // 文档还没给出 <title> 时，Chromium 会把标题当成 URL——直接透出去会让标签栏
      // 闪一下 `bao://settings/`。所以「标题等于地址（忽略结尾斜杠）」或「标题本身就是
      // 内部地址」时回落到建标签时给的初始标题。2026-11-24 实测：内部设置页在页面加载
      // 完成前约 60–200 ms 处于这个状态，且 Chromium 给的占位标题不带结尾斜杠。
      title: committed ? (placeholderTitle(title, committed) ? tab.initialTitle : title) : tab.initialTitle,
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

  /** 内部页读到的快照：设置 + **解析后**的亮/暗 + 存储状态 + 插件可用性 + 版本信息。 */
  function internalSnapshot(): SettingsSnapshot {
    return {
      settings: currentSettings(),
      theme: currentTheme(),
      storage: storageStatus(),
      flash: plugins,
      runtime: { app: app.getVersion(), electron: process.versions.electron, chromium: process.versions.chrome }
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
    const view = new WebContentsView({
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
    // WebContents 的默认底色是纯白；在内部页 HTML/CSS 到达前先铺最终 Fluent 页面色，
    // 避免新标签页经历「白 → 临时色 → 页面色」三段跳。这里必须用解析后的当前主题，
    // 不能只看系统 prefers-color-scheme（用户可能在设置里强制亮色或暗色）。
    view.setBackgroundColor(shellThemes[currentTheme()].colorNeutralBackground2)
    return view
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
   * 新窗口的形态按 Chrome 语义区分（2026-11-24 修订，见
   * `docs/reports/2026-11-24-popup-vs-newtab.md`）：
   * - **没有 `features`**（`<a target="_blank">`、`window.open(url)`）：开**新标签**。
   *   这是用户点链接最常见的路径，用弹窗承载会让每次点链接都多一个窗口；
   * - **有 `features`**（`window.open(url, name, 'width=…')`）或表单 `target=_blank` 的 POST：
   *   用**真实子窗口**承载，保留 `window.opener` 与返回值——Flash 大厅→游戏的交接通道，
   *   POST 体也无法用 GET 重放。弹窗继续沿用 M1 的同站限制。
   */
  function guardContents(
    contents: WebContents,
    context: {
      engine: () => BrowserEngine
      openerUrl: () => string | undefined
      live: () => boolean
      /**
       * 导航策略是否生效。默认等于 `live`；两阶段引擎切换的候选视图在提交前也要遵守
       * 同一套主帧导航/重定向白名单（否则准备期是一段没有策略的窗口）。
       */
      guarded?: () => boolean
      /** 该标签允许的文档地址（页面 http(s) / 内部页仅 bao://settings/*）。 */
      allow: (url: string) => boolean
      /** 在所属窗口开新标签（无 features 的新窗口请求走这条路）。 */
      openTab: (url: string) => void
    }
  ): void {
    contents.setWindowOpenHandler((details) => {
      const { url } = details
      if (!context.live() || !context.allow(url)) return { action: 'deny' }
      // 没有 features、也不是 POST 表单：按 Chrome 语义开新标签（不建窗口）。
      const features = (details.features ?? '').trim()
      if (features === '' && !details.postBody && details.disposition !== 'new-window') {
        context.openTab(url)
        return { action: 'deny' }
      }
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
        allow: isWebAddress,
        /**
         * 子弹窗不是标签，没有自己的宿主：它里面点 `target=_blank` 时**继承 opener 的
         * 当前宿主**（opener 标签可能已经被拖到另一个窗口，旧窗口甚至已关闭）。
         * 弹窗本身的允许/拒绝策略（同站、features 形态）完全不变。
         */
        openTab: (url) => context.openTab(url)
      })
    })

    contents.on('will-frame-navigate', (event) => {
      const guarded = (context.guarded ?? context.live)()
      if (guarded && event.isMainFrame && !context.allow(event.url)) event.preventDefault()
    })
    contents.on('will-redirect', (event) => {
      const guarded = (context.guarded ?? context.live)()
      if (guarded && event.isMainFrame && !context.allow(event.url)) event.preventDefault()
    })
  }

  /**
   * 标签身份与代际（A1-b）：**唯一账本**是 `tabRegistry`，标签上不再有 `binding` /
   * `navVersion` 字段。
   *
   * 为什么删掉字段而不是留一份镜像：两处存同一事实，出岔子时不报错、只会静默丢事件
   * （2026-11-26 实测：引擎切换提交后镜像停在旧代际，`live()` 恒假，该标签所有页面事件
   * 被忽略，表现为「点链接不开窗」）。代际推进同时发出生命周期事件（架构 §7 规则 9）。
   */
  function registerTab(tab: Tab): void {
    tabRegistry.create({ tabId: tab.id, windowId: window.id })
  }

  /**
   * 代际读取。标签不在账本里（已关闭）返回 0：任何捕获到的代际都不会等于 0，
   * 于是那个视图的事件自然全部作废——不需要额外的「已关闭」标记。
   */
  function bindingOf(tab: Tab): number {
    return tabRegistry.snapshot(tab.id)?.bindingId ?? 0
  }

  function navigationOf(tab: Tab): number {
    return tabRegistry.snapshot(tab.id)?.navigationId ?? 0
  }

  /**
   * `bind()` 自足：拿到视图的标签必须先在账本里。
   * 否则 `live()` 恒为假、该页面的事件被**静默**忽略（点击不开窗、加载态不更新，且不报错）。
   */
  function ensureRegistered(tab: Tab): void {
    if (!tabRegistry.snapshot(tab.id)) registerTab(tab)
  }

  function advanceBinding(tab: Tab, kind: TabLifecycleKind): void {
    tabRegistry.bumpBinding(tab.id, kind)
  }

  function advanceNavigation(tab: Tab): void {
    tabRegistry.bumpNavigation(tab.id)
  }

  /**
   * 给视图装事件。`generation` 缺省时取**当前**代际。
   *
   * 注意顺序：先 `ensureRegistered` 再读代际。写成参数默认值 `binding = bindingOf(tab)`
   * 会在登记之前求值（未登记 → 0），之后 `live()` 永远为假——又是一次静默丢事件。
   */
  function bind(tab: Tab, view: WebContentsView, generation?: number): void {
    ensureRegistered(tab)
    const binding = generation ?? bindingOf(tab)
    const contents = view.webContents
    const live = () => tab.view === view && bindingOf(tab) === binding && !contents.isDestroyed()

    contents.on('before-input-event', (event, input) => {
      if (!live() || event.defaultPrevented) return
    if (tab.host?.shortcut(tab, input)) event.preventDefault()
    })
    guardContents(contents, {
      engine: () => tab.engine,
      openerUrl: () => safe(() => contents.getURL(), ''),
      live,
      // 候选视图（尚未提交）也执行同一套主帧导航/重定向白名单。
      guarded: () => live() || tab.engineSwitch?.view === view,
      // 内部页在同一会话里可以在 `bao://newtab` 与 `bao://settings` 之间就地导航。
      allow: tab.internal ? isInternalUrl : isWebAddress,
      // 跨窗口移交后 `tab.host` 已经指向新窗口：这里必须**现解析**，不能用本闭包捕获的窗口。
      openTab: (url) => tab.host?.openTab(url)
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
    contents.on('did-start-navigation', (details) => {
      // 任何主帧导航（含重定向、fragment、pushState）都推进版本：引擎切换准备期间旧页仍可
      // 交互，提交前必须能发现"用户已经导航过"，否则会把他的新页面换回快照里的旧地址。
      if (!live() || !details.isMainFrame) return
      advanceNavigation(tab)
    })
    contents.on('did-navigate', (_event, url) => {
      if (!live()) return
      advanceNavigation(tab)
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
      // 提交之后 `getURL()` 就是权威：清掉"正在请求的地址"，否则历史前进/后退会让地址栏
      // 一直停在上一次输入的地址上（`displayAddress()` 只在两者不同时才用它）。
      tab.requestedUrl = undefined
      tab.host?.notify(tab)
    })
    contents.on('did-navigate-in-page', () => {
      if (!live()) return
      advanceNavigation(tab)
      tab.host?.notify(tab)
    })
    contents.on('page-title-updated', () => {
      if (live()) tab.host?.notify(tab)
    })
  }

  function load(tab: Tab, url: string): void {
    // 先把"要去的地址"记下来：文档提交前 `getURL()` 是空串，地址栏与会话投影都要用它顶替。
    tab.requestedUrl = url
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
      id: nextTabId++, view, error: '', initialTitle, engine, manualOverride: source === 'manual', pinned: false, muted: false, host: controller
    }
    tabs.push(tab)
    registerTab(tab)
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
    registerTab(tab)
    bind(tab, view)
    load(tab, internalUrls[kind])
    return tab
  }

  /** 新建标签页：Chrome 的 `Ctrl+T`/「+」语义是**总是**新增一个 NTP，不复用。 */
  function openNewTab(): Tab {
    return openInternalTab('newtab')
  }

  /**
   * 在**本窗口**开一个新标签并导航过去（`<a target="_blank">`、不带 features 的 `window.open`）。
   *
   * 与 `addTab` 的唯一区别是它可能从 `setWindowOpenHandler` 里同步调用：那里窗口可能
   * 已经在关闭，所以先拦掉；引擎按站点规则/默认值解析（新标签没有"继承上一个引擎"的语义）。
   */
  function openUrlInNewTab(url: string): void {
    if (closing || window.isDestroyed() || !isWebAddress(url)) return
    const resolved = engineFor(url)
    const opened = addTab('新标签页', url, resolved.engine, resolved.source)
    select(opened, true)
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
    for (const restoredTab of restored) registerTab(restoredTab)

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
    restorePromptPending = false
    applySession(session)
    // 用户已经回答，解除写盘挂起：当前状态（恢复后的标签）覆盖磁盘上的崩溃会话。
    releaseSessionHold()
    layout()
  }

  /** 用户点了「忽略」：丢弃崩溃会话，当前窗口保持原样。 */
  function dismissCrashSession(): void {
    if (!crashSession) return
    crashSession = undefined
    restorePromptPending = false
    releaseSessionHold()
    publish()
    layout()
  }

  /**
   * 会话数据被清除时调用：丢掉挂起的崩溃会话，提示条随之消失。
   *
   * 这里**不**解除写盘挂起——清除的语义是"本次运行不再记录会话"，
   * 解除挂起会让 800 ms 后的节流写把当前标签又写回去。
   */
  function forgetSessionPrompt(): void {
    if (!crashSession) return
    crashSession = undefined
    restorePromptPending = false
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
      // 文档还没提交（首帧前 / DNS 未返回 / 已提交旧文档但新导航在途）时以 requestedUrl 为准，
      // 否则投影里会出现 `url: ''` 的标签（被校验器整条丢弃）。
      const url = tab.internal === 'newtab' ? '' : displayAddress(tab, liveUrl)
      /**
       * 不可恢复的标签**不进投影**。
       *
       * 判据必须与 `shared/session.ts` 的 `sanitizeSessionTab()` 一致（`isWebAddress` 就是
       * 那条规则的实现）：校验器会整条丢弃非 http(s) 的标签，而 `writeSessionNow()` 判断
       * "空投影→清库"时数的是**这里的**标签数。两边不一致时，一个"普通但地址还不合法"的
       * 标签会让整份载荷被拒（`INVALID_PARAM`），本次运行从此不再写会话。2026-11-26 实测：
       * 从新标签页输入中文 → 导航长时间不提交文档 → 每次写盘都失败。宁可少一条投影，
       * 也不要让写盘抛异常。
       */
      if (tab.internal !== 'newtab' && !isWebAddress(url)) continue
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
    // 用户在准备期间输入新地址：导航优先，取消未提交的引擎切换（不覆盖这次导航）。
    cancelEngineSwitch(tab)
    const address = typeof raw === 'string' ? raw : ''
    // 输入解析只有一处（`resolveNavigation`）：像地址就导航，其余按默认搜索引擎搜索。
    // 内部地址（`bao://settings` 等）必须**先**判，否则会被当成关键词搜出去。
    const engine = currentSettings().searchEngine
    if (tab.internal) {
      const internal = parseInternalAddress(address)
      if (internal) {
        const current = safe(() => tab.view?.webContents.getURL() ?? '', '')
        if (internal.kind !== tab.internal || internal.url !== current) controlInternal(tab, internal)
        return { ok: true, state: state() }
      }
      const opened = resolveNavigation(address, engine)
      if (!opened) return fail('invalid-address')
      if (tab.internal === 'settings') {
        const resolved = engineFor(opened)
        select(addTab('新标签页', opened, resolved.engine, resolved.source), true)
      } else {
        leaveNewTab(tab, opened)
      }
      return { ok: true, state: state() }
    }
    const url = resolveNavigation(address, engine)
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
    load(tab, url)
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

  /**
   * 休眠判定的诊断钩子（ADR-0004 §5）：`BAO_DISCARD_TRACE` 指定文件，未设置时是空操作。
   *
   * 误杀时的第一个问题永远是「它为什么觉得可以睡」，所以理由必须落在**具体命中项**上。
   */
  function traceDiscard(line: string): void {
    const file = process.env.BAO_DISCARD_TRACE
    if (!file) return
    const { appendFileSync } = require('node:fs') as typeof import('node:fs')
    try { appendFileSync(file, `${Date.now()} ${line}\n`) } catch { /* ignore */ }
  }

  /** 每个标签上一次被拒绝的原因：同一原因只记一次，避免 30 秒一轮刷屏。 */
  const discardBlocked = new Map<number, string>()

  function noteDiscardBlocked(tab: Tab, reason: string, detail = ''): void {
    if (discardBlocked.get(tab.id) === reason) return
    discardBlocked.set(tab.id, reason)
    traceDiscard(`tab=${tab.id} 拒绝休眠：${reason} engine=${tab.engine}${detail}`)
  }

  /**
   * 这个标签的**页面上**有没有 Flash 内容（ADR-0004 §2 硬门禁）。
   *
   * 判定逻辑、缓存语义与三个历史坑（不用引擎判定、阴性不缓存、跨帧遍历、fail-closed）
   * 都在 `./flash-probe`，那里是纯模块、有单测，A1 的 Capability 校验层（`flash-content`）
   * 必须复用同一份实现。这里只做接线：把「取主帧」这件唯一需要 Electron 的事做成闭包传进去。
   */
  const flashPresence = new FlashPresenceCache()

  function flashContentOf(tab: Tab, contents: WebContents): Promise<boolean> {
    return detectFlashContent({
      tabId: tab.id,
      binding: bindingOf(tab),
      cache: flashPresence,
      // 主帧已 detach 或 WebContents 已销毁时 getter 会抛：交给纯层按「有 Flash」处理。
      frames: () => {
        try {
          return contents.mainFrame?.framesInSubtree
        } catch {
          return undefined
        }
      }
    })
  }

  /** 让标签进入休眠：销毁它的视图（省掉一整个渲染进程），只保留元数据。 */
  function discardTab(tab: Tab): void {
    cancelEngineSwitch(tab)
    const view = tab.view
    if (!view) return
    tab.lastUrl = safe(() => view.webContents.getURL(), tab.lastUrl ?? '')
    tab.lastTitle = safe(() => view.webContents.getTitle(), tab.lastTitle ?? '')
    if (window.contentView.children.includes(view)) window.contentView.removeChildView(view)
    advanceBinding(tab, 'tab-discarded')
    tab.view = undefined
    tab.discarded = true
    tab.backgroundSince = undefined
    tab.error = ''
    tab.notice = undefined
    discardBlocked.delete(tab.id)
    flashPresence.forget(tab.id)
    traceDiscard(`tab=${tab.id} 休眠 engine=${tab.engine} url=${tab.lastUrl}`)
    if (!view.webContents.isDestroyed()) view.webContents.close()
    publish()
  }

  /**
   * 把标签的**逻辑**静音状态应用到视图的 WebContents。
   *
   * 静音状态存在标签上（`Tab.muted`），不是 WebContents 上：休眠会销毁 WebContents，
   * 会话恢复/引擎切换/崩溃重建会换一个新的，所以每个新建或重建视图的入口都必须
   * 调一次，否则会出现「界面显示静音、实际没静音」。
   */
  function applyMuted(tab: Tab, view: WebContentsView): void {
    const contents = view.webContents
    if (contents.isDestroyed()) return
    contents.setAudioMuted(tab.muted)
  }

  /** 唤醒休眠标签：重建视图并按休眠前的地址重新加载（引擎沿用当前值）。
   *  TODO(M3)：可选恢复导航栈与滚动位置，见 docs/reports/2026-11-24-tab-discard.md §4。 */
  function revive(tab: Tab): void {
    if (tab.view) return
    const view = tab.internal ? createInternalView() : createPageView(tab.engine)
    tab.view = view
    advanceBinding(tab, 'tab-revived')
    tab.discarded = false
    bind(tab, view)
    // 静音跟着标签走：休眠丢掉了 WebContents，醒来必须重新应用（与 swapView 同一条规则）。
    applyMuted(tab, view)
    const url = tab.lastUrl || (tab.internal ? internalUrls[tab.internal] : '')
    if (url) load(tab, url)
    publish()
  }

  /**
   * 定时扫描：把「后台超过 TTL」的标签置为休眠。
   *
   * 守卫（任何一条命中都不休眠）：当前标签、内部页、置顶标签、有效活动租约、正在加载、
   * 含 Flash 内容、正在出声、非 http(s)。
   *
   * 中间两条是 [ADR-0004](../../../docs/adr/0004-liveness-over-memory-reclaim.md) 的硬门禁：
   * **游戏连续性 > 自动化可重复性 > 内存回收**。含 Flash 内容的标签永不自动休眠（游戏状态只在
   * 内存里，销毁视图就丢存档）；加载中被睡会连首屏都拿不回来。"不出声"对游戏是噪声而不是信号
   * ——菜单/读条/回合制等待都可以长时间没音频，所以它只对普通网页有意义。
   *
   * 「用户保持活跃」不再单独判断：它是 `user` owner 的租约，和下载 / 会话恢复 / DevTools
   * 走同一条 `blocksDiscard()` 判定（架构 §7 规则 4）。谁在租约表里，就谁说了算。
   */
  // TODO(M3)：守卫链预留给「自动判定挂机」（长时间无交互 + 持续音频输出），见同一份报告的 §4。
  /** 扫描不可重入：Flash 判定是异步的，两轮重叠会重复探测、重复决策。 */
  let sweepInFlight = false

  async function sweepDiscard(): Promise<void> {
    if (sweepInFlight || closing || window.isDestroyed()) return
    sweepInFlight = true
    try {
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
        // 正在做两阶段引擎切换的标签先不睡：切换是用户/自动化**刚发起**的动作，而
        // `discardTab()` 第一件事就是 `cancelEngineSwitch()`——睡掉它等于把用户的操作取消掉。
        // 候选准备最长 15 s，睡晚一轮没有代价。
        if (tab.engineSwitch) {
          noteDiscardBlocked(tab, 'engine-switch-pending')
          continue
        }
        // ADR-0004 硬门禁①：加载中的标签不睡（否则连首屏都回不来，更别说页面里的游戏）。
        if (contents.isLoading()) {
          noteDiscardBlocked(tab, 'loading')
          continue
        }
        if (safe(() => contents.isCurrentlyAudible(), false)) continue
        if (!isWebAddress(safe(() => contents.getURL(), ''))) continue
        if (tab.backgroundSince === undefined) {
          tab.backgroundSince = now
          continue
        }
        if (now - tab.backgroundSince < DISCARD_TTL_MS) continue
        // ADR-0004 硬门禁②：含 Flash 内容的标签永不自动休眠。
        // 只有**真要睡**的标签才付这次跨帧探测：探测放在 TTL 之后，才不会被"早期阴性"骗过
        // （页面可以在首次探测之后才插入播放器）。阳性结果由绑定代际粘住。
        if (await flashContentOf(tab, contents)) {
          noteDiscardBlocked(tab, 'flash-content', ` url=${safe(() => contents.getURL(), '')}`)
          continue
        }
        // 探测是异步的：期间标签可能被切换、导航、重建或销毁，提交前重新校验。
        if (closing || tab.view?.webContents !== contents || tab === active) continue
        if (contents.isDestroyed() || contents.isLoading()) continue
        discardTab(tab)
      }
    } finally {
      sweepInFlight = false
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
    // 其它换视图路径（崩溃重建、跨引擎导航）优先于未提交的引擎切换：先取消候选。
    cancelEngineSwitch(tab)
    const previous = tab.view
    // 内部页重建仍是内部页：不能因为崩溃/快捷键把它换成页面视图。
    const view = tab.internal ? createInternalView() : createPageView(engine)
    advanceBinding(tab, 'tab-rebuilt')
    tab.view = view
    tab.engine = engine
    tab.manualOverride = source === 'manual'
    tab.error = ''
    tab.failedUrl = undefined
    tab.notice = undefined
    bind(tab, view)
    // 静音状态跟着标签走：切引擎重建 WebContents 后必须重新应用（审计 P2）。
    applyMuted(tab, view)
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

  /**
   * 引擎切换（两阶段）：先准备候选视图并等它**真的加载完成**，成功后才提交；
   * 开始新的切换、崩溃重建、休眠、关闭或跨窗口移交都会取消未提交的候选。
   *
   * 结果语义（与文案一一对应）：
   * - `ok`：已提交。若导航栈恢复不了但已用当前地址重开，会带一条 notice（“已切换但降级”），
   *   不会声称回退；
   * - `engine-switch-failed`：**未提交**，旧视图/引擎/代际全部保持不变；
   * - `engine-switch-cancelled`：被新请求/关闭/移交取代，只清理候选。
   *
   * 不承诺恢复 POST 体、Flash 运行时内存态：这些当前接口没有可靠恢复手段。
   */
  async function switchEngine(tab: Tab, engine: BrowserEngine): Promise<BrowserResult> {
    if (tab.engine === engine) {
      // 切回当前引擎 = 取消在途候选；当前页面从未被替换。
      cancelEngineSwitch(tab)
      return { ok: true, state: state() }
    }
    // 新的切换请求取代旧准备：旧候选只清理，不提交。
    cancelEngineSwitch(tab)
    if (!tabs.includes(tab)) return fail('unknown-tab')
    if (!tab.view) revive(tab)
    const oldView = tab.view
    if (!oldView) return fail('engine-switch-failed')

    const oldContents = oldView.webContents
    const destroyed = oldContents.isDestroyed()
    const entries = destroyed ? [] : safe(() => oldContents.navigationHistory.getAllEntries(), [])
    const index = destroyed
      ? 0
      : safe(() => oldContents.navigationHistory.getActiveIndex(), Math.max(entries.length - 1, 0))
    const currentUrl = destroyed ? '' : safe(() => oldContents.getURL(), '')
    const fallbackUrl = tab.failedUrl ?? (isWebAddress(currentUrl) ? currentUrl : '')

    const attempt = createEngineAttempt(tab, engine, 'manual')
    // 准备期间旧页仍可交互：记下此刻的导航版本，提交前必须仍然一致。
    const navVersion = navigationOf(tab)
    const outcome = await Promise.race([
      prepareEngineCandidate(attempt, entries, index, fallbackUrl),
      attempt.cancelSignal
    ])

    if (outcome === 'cancelled') {
      if (tab.engineSwitch === attempt) cancelEngineSwitch(tab)
      return fail('engine-switch-cancelled')
    }
    // 准备期间可能已被新请求取代、标签被关闭/移交，旧视图被重建，或**用户在旧页上导航过**。
    const stillCurrent = tab.engineSwitch === attempt && !attempt.cancelled &&
      tabs.includes(tab) && tab.view === oldView && navigationOf(tab) === navVersion
    if (!stillCurrent) {
      if (tab.engineSwitch === attempt) cancelEngineSwitch(tab)
      if (navigationOf(tab) !== navVersion) {
        // 导航已经生效，用户看到的页面比快照新：不能拿旧栈把它换回去。
        console.error('引擎切换已取消：准备期间旧页发生了导航，提交会覆盖更新的页面。')
      }
      return fail('engine-switch-cancelled')
    }
    if (outcome.status === 'failed') {
      cancelEngineSwitch(tab)
      console.error(`引擎切换未提交（${outcome.reason}），保留原引擎与页面。`)
      return fail('engine-switch-failed')
    }

    commitEngineAttempt(tab, attempt, outcome.status === 'degraded' ? outcome.url : undefined)
    return { ok: true, state: state() }
  }

  /** 取消未提交的引擎切换：只关闭候选，已提交状态不动。 */
  function cancelEngineSwitch(tab: Tab): boolean {
    const attempt = tab.engineSwitch
    if (!attempt) return false
    tab.engineSwitch = undefined
    attempt.cancelled = true
    attempt.cancel()
    closeView(attempt.view)
    return true
  }

  function closeView(view: WebContentsView | undefined): void {
    const contents = view?.webContents
    if (contents && !contents.isDestroyed()) contents.close()
  }

  /** 建候选视图：按「旧代际 + 1」绑定，事件在提交前全部作废（账本代际尚未推进）。 */
  function createEngineAttempt(tab: Tab, engine: BrowserEngine, source: EngineSource): EngineAttempt {
    const view = createPageView(engine)
    const binding = tabRegistry.reserveBinding(tab.id) ?? 1
    bind(tab, view, binding)
    applyMuted(tab, view)
    let cancel = () => {}
    const cancelSignal = new Promise<'cancelled'>((resolve) => {
      cancel = () => resolve('cancelled')
    })
    const attempt: EngineAttempt = {
      token: ++engineSequence,
      engine,
      source,
      view,
      binding,
      cancelled: false,
      cancelSignal,
      cancel
    }
    tab.engineSwitch = attempt
    return attempt
  }

  /**
   * 等候选视图**真实的加载结果**：`did-finish-load` 才算成功。
   * `did-fail-load`（非 -3）、渲染进程崩溃、销毁或超时都按失败返回。
   */
  function createLoadWaiter(contents: WebContents): {
    promise: Promise<'loaded' | 'failed'>
    cancel: () => void
  } {
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let settle: (outcome: 'loaded' | 'failed') => void = () => {}
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      try {
        contents.removeListener('did-finish-load', onFinish)
        contents.removeListener('did-fail-load', onFail)
        contents.removeListener('render-process-gone', onGone)
        contents.removeListener('destroyed', onDestroyed)
      } catch {
        // 已销毁的 emitter 不再接受监听器操作。
      }
    }
    const finish = (outcome: 'loaded' | 'failed') => {
      if (done) return
      done = true
      cleanup()
      settle(outcome)
    }
    const onFinish = () => finish('loaded')
    // -3 = ERR_ABORTED：被后续导航取代，交给后续事件判断。
    const onFail = (_event: Electron.Event, code: number, _description: string, _url: string, isMainFrame: boolean) => {
      if (isMainFrame && code !== -3) finish('failed')
    }
    const onGone = () => finish('failed')
    const onDestroyed = () => finish('failed')
    const promise = new Promise<'loaded' | 'failed'>((resolve) => {
      settle = resolve
    })
    contents.on('did-finish-load', onFinish)
    contents.on('did-fail-load', onFail)
    contents.on('render-process-gone', onGone)
    contents.once('destroyed', onDestroyed)
    timer = setTimeout(() => finish('failed'), ENGINE_PREPARE_TIMEOUT_MS)
    timer.unref?.()
    return { promise, cancel: () => finish('failed') }
  }

  /** 候选“加载完成”之外再确认确实落在可承载的页面地址上（避免把空白/错误页当成功）。 */
  function candidateAddressReady(contents: WebContents): boolean {
    return isWebAddress(safe(() => contents.getURL(), ''))
  }

  /** 冒烟一次性开关：读走即删除，避免影响后续切换。 */
  function takeEngineFault(name: string): boolean {
    if (process.env[name] !== '1') return false
    delete process.env[name]
    return true
  }

  /**
   * 准备候选视图。成功只认“导航真实完成”（did-finish-load）：
   * - 有导航栈 → `restore()` 后等加载完成；
   * - `restore()` 失败 → 用当前地址重开，成功则返回 `degraded`（已提交但历史降级）；
   * - 没有可恢复地址的空白页 → 视图本身即准备完成。
   */
  async function prepareEngineCandidate(
    attempt: EngineAttempt,
    entries: NavigationEntry[],
    index: number,
    fallbackUrl: string
  ): Promise<EnginePrepareOutcome> {
    const contents = attempt.view.webContents
    const delay = Number(process.env.BAO_ENGINE_SWITCH_PREPARE_DELAY_MS ?? 0)
    if (Number.isFinite(delay) && delay > 0) await new Promise((done) => setTimeout(done, delay))
    if (attempt.cancelled) return { status: 'failed', reason: 'cancelled' }

    // 注入：让候选真实加载一个不可达地址，验证失败分支只清理候选、旧视图保持可用。
    if (takeEngineFault('BAO_ENGINE_SWITCH_FAIL')) {
      const waiter = createLoadWaiter(contents)
      void contents.loadURL('http://127.0.0.1:1/').catch(() => {})
      const outcome = await Promise.race([waiter.promise, attempt.cancelSignal])
      waiter.cancel()
      return outcome === 'loaded' ? { status: 'prepared' } : { status: 'failed', reason: 'load' }
    }

    let restoreFailed = takeEngineFault('BAO_ENGINE_SWITCH_RESTORE_FAIL')
    if (!restoreFailed && entries.length > 0) {
      const waiter = createLoadWaiter(contents)
      /**
       * `restore()` 自己可能一直不返回（审计 P2：Electron 39 没有给恢复独立的截止时间）。
       * 所以**先把调用挂上**，再和「加载完成 / 取消 / 15 s 超时」赛跑：超时后即使 `restore()`
       * 仍然挂着，切换也会结束并清掉候选，不会永久占着 `engineSwitch`（那会连带卡住休眠门禁
       * 和后续切换）。
       */
      const restoreCall = contents.navigationHistory.restore({ entries, index }).then(
        () => 'ok' as const,
        (error: unknown) => {
          // restore() 会异步拉起导航；失败时旧页面仍在，改用当前地址重开。
          console.error('引擎切换：导航栈恢复调用失败，尝试按当前地址重新打开。', error)
          return 'error' as const
        }
      )
      const first = await Promise.race([restoreCall, waiter.promise, attempt.cancelSignal])
      if (first === 'cancelled') {
        waiter.cancel()
        return { status: 'failed', reason: 'cancelled' }
      }
      if (first === 'failed') {
        waiter.cancel()
        return { status: 'failed', reason: 'restore-load' }
      }
      if (first === 'error') {
        waiter.cancel()
        restoreFailed = true
      } else {
        // 'ok'（restore 已返回）或 'loaded'（加载先完成）：都还要等加载真正结束。
        const outcome = await Promise.race([waiter.promise, attempt.cancelSignal])
        waiter.cancel()
        if (outcome === 'cancelled') return { status: 'failed', reason: 'cancelled' }
        if (outcome !== 'loaded') return { status: 'failed', reason: 'restore-load' }
        return candidateAddressReady(contents)
          ? { status: 'prepared' }
          : { status: 'failed', reason: 'restore-load' }
      }
    }

    if (attempt.cancelled) return { status: 'failed', reason: 'cancelled' }
    if (!fallbackUrl) {
      return restoreFailed ? { status: 'failed', reason: 'no-fallback' } : { status: 'prepared' }
    }
    const waiter = createLoadWaiter(contents)
    void contents.loadURL(fallbackUrl).catch(() => {})
    const outcome = await Promise.race([waiter.promise, attempt.cancelSignal])
    waiter.cancel()
    if (outcome === 'loaded' && candidateAddressReady(contents)) {
      return restoreFailed ? { status: 'degraded', url: fallbackUrl } : { status: 'prepared' }
    }
    return { status: 'failed', reason: restoreFailed ? 'fallback-load' : 'load' }
  }

  /** 提交候选：此刻才切视图、推进绑定代际、更新引擎并关闭旧视图。 */
  function commitEngineAttempt(tab: Tab, attempt: EngineAttempt, degradedUrl?: string): void {
    const previous = tab.view
    const view = attempt.view
    tab.engineSwitch = undefined
    // 提交预留代际：账本先推进（并发出 engine-committed 事件），镜像无条件跟上。
    // 注意 `commitReserved` 返回 true 才是正常路径——写成 `if (!commit) 同步镜像` 会让
    // 镜像永远停在旧代际，`live()` 从此恒为假，页面事件全部被忽略（2026-11-26 实测）。
    tabRegistry.commitReserved(tab.id, attempt.binding, 'engine-committed')
    tab.view = view
    tab.engine = attempt.engine
    tab.manualOverride = attempt.source === 'manual'
    tab.error = ''
    tab.failedUrl = undefined
    tab.notice = degradedUrl
      ? { id: nextNoticeId++, message: `已切换引擎，但导航历史未能恢复，已重新打开 ${degradedUrl}` }
      : undefined
    // 准备期间用户可能改过静音：提交时再对齐一次。
    applyMuted(tab, view)
    if (active === tab) {
      window.contentView.addChildView(view)
      overlays.setActivePage(view.webContents)
      layout()
    }
    if (previous && window.contentView.children.includes(previous)) window.contentView.removeChildView(previous)
    closeView(previous)
    if (active === tab && !overlays.panelVisible()) focusContents(view.webContents)
    publish()
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
    // 读标签的**逻辑**静音状态而不是当前 WebContents：休眠标签根本没有 WebContents，
    // 按实际值取会把「已静音」显示成「静音标签页」，点下去反而取消静音。
    const muted = tab.muted
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
    // 重新加载优先于未提交的引擎切换：避免提交时用旧导航栈覆盖这次加载。
    cancelEngineSwitch(tab)
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
    // 关闭优先于未提交的引擎切换：先取消候选，避免它变成孤儿。
    cancelEngineSwitch(tab)
    const wasActive = active === tab
    rememberClosed(tab)
    tabs.splice(index, 1)
    // 标签关闭就清空它的全部租约：不然租约表会随着「标记过保持活跃的标签」一直长。
    activityLeases.releaseTab(tab.id)
    tabRegistry.close(tab.id)
    advanceBinding(tab, 'tab-closed')
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
    // 移交时取消未提交的引擎切换：候选视图不跟着标签走，直接清理。
    cancelEngineSwitch(tab)
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

  /**
   * 接管一个标签（跨窗口移交成功、或目标窗初始化失败后的回挂）。
   *
   * `index` 只是调用方在**另一个窗口**里看到的旧位置，不能盲信：等待期间源窗口可能
   * 排序、固定或关闭过。真正落位按本窗口**当前**的固定分组夹取——固定标签只进最左
   * 前缀，未固定标签不能插到固定前缀之前。
   */
  function adoptTab(tab: Tab, index = 0, options: { wake?: boolean } = {}): void {
    // 不递增 binding：现有监听器仍然有效，只是改按新宿主分发。
    tab.host = controller
    tab.error = ''
    const requested = Number.isFinite(index) ? Math.trunc(index) : 0
    const pinnedCount = tabs.filter((item) => item.pinned).length
    const at = tab.pinned
      ? Math.min(Math.max(requested, 0), pinnedCount)
      : Math.min(Math.max(requested, pinnedCount), tabs.length)
    tabs.splice(at, 0, tab)
    // 跨窗口移交：身份与代际都不变，只换归属窗口（拖出标签不是重建页面）。
    tabRegistry.migrate(tab.id, window.id)
    /**
     * `wake: false` 用于**失败回挂**：休眠标签本来就没有视图，`select()` 会顺手 `revive()`
     * 把它唤醒并重新加载——那不是"退回原窗口"，是白丢一次休眠（2026-11-26 审计）。
     * 只把元数据与租约挂回去，等用户切到它时再按正常路径唤醒。
     */
    if (options.wake === false) {
      publish()
      return
    }
    select(tab, true)
  }

  /** 冒烟诊断：真实视图 id、绑定代际与未提交候选（不进入 UI 投影）。 */
  /**
   * 外壳渲染线程心跳（2026-11-25 演示 §7.7-1）。
   *
   * 共享进程把工具栏与浮层放进同一条渲染主线程，长任务会互相排队；而被占住的主线程**无法**
   * 回答任何 IPC，所以"有没有卡"只能由主进程主动测。回执的往返时间就等于被阻塞的时长。
   *
   * 开关：开发态默认开（test 里要用），成品只在 `BAO_HEARTBEAT=1` 时开。
   * 诊断写入 `BAO_HEARTBEAT_TRACE`（未设置时只 `console.warn` 一次）。
   */
  const heartbeatEnabled = !app.isPackaged || process.env.BAO_HEARTBEAT === '1'
  const heartbeatStallMs = Number(process.env.BAO_HEARTBEAT_STALL_MS ?? 200)
  const heartbeat = new HeartbeatMonitor({ stallMs: heartbeatStallMs })
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  let heartbeatWarned = false

  function traceHeartbeat(line: string): void {
    const file = process.env.BAO_HEARTBEAT_TRACE
    if (!file) return
    const { appendFileSync } = require('node:fs') as typeof import('node:fs')
    try {
      appendFileSync(file, `${Date.now()} ${line}\n`)
    } catch {
      // 诊断写盘失败不影响浏览。
    }
  }

  function startHeartbeat(): void {
    if (!heartbeatEnabled || heartbeatTimer) return
    const interval = Number(process.env.BAO_HEARTBEAT_INTERVAL_MS ?? 100)
    heartbeatTimer = setInterval(() => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) return
      window.webContents.send(heartbeatChannels.ping, heartbeat.tick())
    }, interval)
    heartbeatTimer.unref?.()
  }

  function stopHeartbeat(): void {
    if (!heartbeatTimer) return
    clearInterval(heartbeatTimer)
    heartbeatTimer = undefined
  }
  function debugState(): ReturnType<WindowController['debugState']> {
    return tabs.map((tab) => {
      const contents = tab.view?.webContents
      return {
        id: tab.id,
        engine: tab.engine,
        binding: bindingOf(tab),
        viewId: contents?.id,
        viewAlive: Boolean(contents && !contents.isDestroyed()),
        pendingEngine: tab.engineSwitch?.engine
      }
    })
  }

  const controller: WindowController = {
    heartbeatPong(seq: number): void {
      const rtt = heartbeat.onPong(seq)
      if (rtt === undefined || rtt <= heartbeatStallMs) return
      traceHeartbeat(`stall rtt=${Math.round(rtt)}ms`)
      // 长任务期间每 10 次告警一次，避免刷屏。
      if (!heartbeatWarned || heartbeat.stats().stalls % 10 === 0) {
        heartbeatWarned = true
        console.warn(`[heartbeat] 外壳渲染线程被阻塞约 ${Math.round(rtt)} ms（阈值 ${heartbeatStallMs} ms）`)
      }
    },
    heartbeatStats: () => heartbeat.stats(),
    heartbeatReset: () => heartbeat.reset(),
    shellUrl,
    flash: plugins,
    overlays,
    snapshot: state,
    notify,
    isEmpty: () => tabs.length === 0,
    isAlive: () => !closing && !closeRequested && !window.isDestroyed(),
    bounds: () => window.getBounds(),
    closeWindow: () => {
      if (!window.isDestroyed()) window.destroy()
    },
    detachTab,
    adoptTab,
    openTab: (url) => openUrlInNewTab(url),
    shortcut: handleShortcut,
    refreshSettings: () => {
      updateWindowControls()
      // 预热开关切换要立刻生效：打开就马上升温，关掉就立刻释放已建好的文档。
      if (overlayPrewarmPolicy() === 'always') overlays.prewarm()
      else overlays.release()
    },
    broadcastSettings,
    ownsContents,
    internalSender,
    internalSnapshot,
    ntpSender,
    ntpSnapshot: ntpState,
    runNtp,
    forgetSessionPrompt,
    refreshProjection: () => {
      if (active) publish()
    },
    debugState,
    run
  }

  function activeTab(): Tab | undefined {
    return active
  }

  /**
   * 校验器要的「当前事实」：先把目标标签的快照算好，再交给纯校验器。
   *
   * 为什么在这里算而不是在校验器里：Flash 判定必须跨帧执行脚本（异步），而校验器是纯同步的。
   * 快照是**校验那一刻**的真相，包含它才能让「含 Flash 内容的标签不得销毁」这条门禁生效。
   */
  async function capabilityWorld(invocation: CapabilityInvocation): Promise<CapabilityWorld> {
    const target = invocation.target
    const tabId = target && !isShellRef(target) ? target.tabId : undefined
    const tab = tabId === undefined ? undefined : tabs.find((entry) => entry.id === tabId)
    const identity = tab ? tabRegistry.snapshot(tab.id) : undefined
    let snapshot: CapabilityTabSnapshot | undefined
    if (tab && identity) {
      const contents = tab.view?.webContents
      const alive = Boolean(contents && !contents.isDestroyed())
      // Flash 判定只对「销毁 WebContents」的动作有意义（ADR-0004 门禁在 `tab.discard` 上）。
      // 其他动作一律不探：那是一次跨帧脚本执行，给每次点击加这个延迟只会让 UI 变慢
      // （2026-11-26 实测：导航被拖慢后，地址栏 Enter 与后续动作之间出现可见的时间窗）。
      const needsFlashProbe = invocation.action.name === 'tab.discard'
      const flashContent = needsFlashProbe && alive && contents ? await flashContentOf(tab, contents) : false
      snapshot = {
        tabId: tab.id,
        bindingId: identity.bindingId,
        navigationId: identity.navigationId,
        loading: alive && contents ? safe(() => contents.isLoadingMainFrame(), false) : false,
        flashContent
      }
    }
    return {
      tab: (id) => (snapshot && snapshot.tabId === id ? snapshot : undefined),
      blockedByLease: (id) => activityLeases.blocksDiscard(id),
      // 外壳元素表随指认 UI 落地；在那之前任何 ShellRef 都会被判为"不存在"，这是对的。
      shellElement: () => false
    }
  }

  /**
   * 外壳动作的上下文。UI 适配层的职责就是这一行（架构 §5 规则 2）：
   * 把「当前活动标签」翻译成显式 `tabId`，并把操作者标成 `human-ui`。
   */
  function uiContext(): ActionContext {
    return { actor: 'human-ui', profileId: DEFAULT_PROFILE_ID }
  }

  /**
   * 统一能力入口（A1-c）：**校验 → 记录 → 分发**。
   *
   * 执行仍然走本控制器已有的函数（`setKeepAwake` / `closeTab` / `navigateTab` …）：动作实现
   * 依赖闭包状态（标签表、视图、窗口），搬出去等于重写；这一片先把「谁能做什么」的判定与审计
   * 接上。UI 不再直接改状态，而是走这里——这就是架构 §5 规则 6「人类与自动化共用同一条执行
   * 路径」的落点。
   */
  async function runCapability(invocation: CapabilityInvocation): Promise<BrowserResult> {
    const world = await capabilityWorld(invocation)
    const decision = validateCapabilityCall(invocation, world)
    capabilityCalls.append(invocation, decision)
    if (!decision.ok) {
      // 界面对不上能力的 21 个码：能对上的映射回去，其余统一 `capability-denied`，
      // 细节留在调用记录的稳定码里（message 也带上）。
      return { ok: false, code: browserCodeFor(decision.code), message: `${decision.message}（${decision.code}）` }
    }
    const tab = decision.tabId === undefined ? undefined : tabs.find((entry) => entry.id === decision.tabId)
    if (!tab) return fail('unknown-tab')
    // 分发一律**幂等**：能力动作携带的是"要变成什么"（value / index），不是"翻转一下"。
    // UI 与自动化共用这条路径时，翻转语义在重试下会变成两次翻转。
    switch (invocation.action.name) {
      case 'tab.activate':
        select(tab)
        return { ok: true, state: state() }
      case 'tab.close':
        closeTab(tab)
        return { ok: true, state: state() }
      case 'tab.reload':
        reloadTab(tab)
        return { ok: true, state: state() }
      case 'tab.move':
        moveTab(tab, invocation.action.index)
        return { ok: true, state: state() }
      case 'tab.duplicate':
        duplicateTab(tab)
        return { ok: true, state: state() }
      case 'tab.pin':
        if (tab.pinned !== invocation.action.value) setPinned(tab, invocation.action.value)
        return { ok: true, state: state() }
      case 'tab.mute':
        if (tab.muted !== invocation.action.value) toggleMuted(tab)
        return { ok: true, state: state() }
      case 'tab.keepAwake':
        setKeepAwake(tab, invocation.action.value)
        return { ok: true, state: state() }
      case 'tab.navigate':
        return navigateTab(tab, invocation.action.address)
      case 'tab.setEngine':
        return switchEngine(tab, invocation.action.engine)
      case 'tab.tearoff':
        return tearOffTab(controller, {
          type: 'tearoff',
          id: tab.id,
          screenX: invocation.action.screenX,
          screenY: invocation.action.screenY
        })
      default:
        return fail('invalid-command')
    }
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
        // A1-c：标签动作统一走能力入口（校验 → 记录 → 分发）。
        return runCapability({
          context: uiContext(),
          action: { name: command.type === 'select' ? 'tab.activate' : 'tab.close' },
          target: { tabId: tab.id }
        })
      }
      case 'duplicate':
      case 'pin':
      case 'mute':
      case 'tab-menu': {
        const tab = tabs.find(({ id }) => id === command.id)
        if (!tab) return fail('unknown-tab')
        // 右键菜单只是外壳交互（不改变浏览器状态），不进能力层。
        if (command.type === 'tab-menu') {
          showTabMenu(tab)
          break
        }
        return runCapability({
          context: uiContext(),
          action: command.type === 'duplicate'
            ? { name: 'tab.duplicate' }
            : command.type === 'pin'
              ? { name: 'tab.pin', value: !tab.pinned }
              : { name: 'tab.mute', value: !tab.muted },
          target: { tabId: tab.id }
        })
      }
      case 'keep-awake': {
        const tab = tabs.find(({ id }) => id === command.id)
        if (!tab) return fail('unknown-tab')
        // A1-c：外壳不再直接改租约表，而是走统一能力入口（校验 + 记录 + 分发）。
        return runCapability({
          context: { actor: 'human-ui', profileId: DEFAULT_PROFILE_ID },
          action: { name: 'tab.keepAwake', value: command.value },
          target: { tabId: tab.id, expectedBindingId: bindingOf(tab), expectedNavigationId: navigationOf(tab) }
        })
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
        // 拖出是显式动作（ADR-0004 §3b：不需要 save→ack），但同样要过能力层的身份与策略校验。
        return runCapability({
          context: uiContext(),
          action: { name: 'tab.tearoff', screenX: command.screenX, screenY: command.screenY },
          target: { tabId: command.id }
        })
      case 'undo-close':
        return undoClose()
      case 'set-engine': {
        const tab = activeTab()
        if (!tab) return fail('unknown-tab')
        // 内部页没有引擎：静默换视图会让设置页变成网页容器。
        if (tab.internal) return fail('invalid-command')
        if (command.engine !== 'ppapi' && command.engine !== 'ruffle') return fail('invalid-command')
        if (command.engine === 'ppapi' && !plugins) return fail('engine-unavailable')
        return runCapability({
          context: uiContext(),
          action: { name: 'tab.setEngine', engine: command.engine },
          target: { tabId: tab.id }
        })
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
        return runCapability({
          context: uiContext(),
          action: { name: 'tab.move', index: command.index },
          target: { tabId: tab.id }
        })
      }
      case 'navigate': {
        const tab = activeTab()
        if (!tab) return fail('unknown-tab')
        return runCapability({
          context: uiContext(),
          action: { name: 'tab.navigate', address: command.address },
          target: { tabId: tab.id }
        })
      }
      case 'back': {
        const tab = activeTab()
        if (!tab) return fail('unknown-tab')
        cancelEngineSwitch(tab)
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
        cancelEngineSwitch(tab)
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
        return runCapability({
          context: uiContext(),
          action: { name: 'tab.reload' },
          target: { tabId: tab.id }
        })
      }
      default:
        return fail('invalid-command')
    }
    return { ok: true, state: state() }
  }

  // 共享进程模式（proto）：放行外壳自己发起的叠加层 window.open，其余一律拒绝。
  window.webContents.setWindowOpenHandler((details) => {
    if (!overlays.isOverlayUrl(details.url)) return { action: 'deny' }
    return {
      action: 'allow',
      createWindow: (options) => {
        // Electron 在运行时把 guest 放进 options.webContents，但类型定义里没有这个字段。
        const guest = (options as unknown as { webContents: Electron.WebContents }).webContents
        // 静默创建（2026-11-25）：浮层文档是"后台预热"建出来的，用户此刻可能在别的应用里打字。
        // 记录这一瞬间的焦点，adopt 之后如果被 guest 抢走就还回去。
        const seed = { window: BrowserWindow.getFocusedWindow(), contents: webContents.getFocusedWebContents() }
        if (!overlays.adoptShared(guest)) {
          guest.close()
          return guest
        }
        restoreSeedFocus(seed, guest)
        return guest
      }
    }
  })
  window.webContents.on('before-input-event', (event, input) => {
    if (overlays.escape(input) || (active && handleShortcut(active, input))) event.preventDefault()
  })
  window.webContents.on('will-frame-navigate', (event) => event.preventDefault())
  window.webContents.on('will-redirect', (event) => event.preventDefault())

  /**
   * 外壳渲染进程自愈。
   *
   * 共享飞窗把工具栏和浮层放进了同一个渲染进程（常驻 +114 MB → +6 MB），代价是故障域合并：
   * 浮层里一次崩溃/OOM 会连工具栏一起带走（实测：崩浮层 → 外壳 `isCrashed: true`，
   * 只剩一个窗口壳）。标签页面是各自独立的 WebContents，不受牵连；所以恢复只需要重载外壳
   * 文档，标签、引擎、租约这些状态都在主进程里，重载后由 `snapshot` 重建。
   *
   * 限流：60 秒内最多重载 3 次——崩溃循环时反复闪屏比停住更糟。
   */
  const shellCrashes: number[] = []
  window.webContents.on('render-process-gone', (_event, details) => {
    if (closing || closeRequested || window.isDestroyed()) return
    if (details.reason === 'clean-exit') return
    const now = Date.now()
    shellCrashes.push(now)
    while (shellCrashes.length > 0 && now - shellCrashes[0] > 60_000) shellCrashes.shift()
    // 外壳没了，浮层视图的「打开」状态对不上（共享模式下它已随进程一起死），先按关闭处理。
    overlays.release()
    if (shellCrashes.length > 3) return
    traceSelfHeal(details.reason)
    window.webContents.reload()
    // 常驻档在自愈重载后要自己回来：重载前浮层已按关闭处理，新文档不会替用户悬停。
    window.webContents.once('did-finish-load', () => {
      if (!window.isDestroyed() && overlayPrewarmPolicy() === 'always') overlays.prewarm()
    })
  })

  /**
   * 自愈的诊断钩子（仅测试用）：把「崩溃 → 重载 → 工具栏回来没有」写进文件。
   *
   * 为什么用文件而不是断言：渲染进程崩溃后，Playwright 的 Page 句柄永久失效
   * （`Target crashed`，也不会再发 `window` 事件），测试驱动没法从页面侧确认恢复。
   * 所以由主进程自己写证据，测试只读文件。环境变量 `BAO_SELFHEAL_TRACE` 未设置时是空操作。
   */
  function traceSelfHeal(reason: string): void {
    const file = process.env.BAO_SELFHEAL_TRACE
    if (!file) return
    const { appendFileSync } = require('node:fs') as typeof import('node:fs')
    const write = (line: string): void => {
      try { appendFileSync(file, `${Date.now()} ${line}\n`) } catch { /* ignore */ }
    }
    write(`gone reason=${reason}`)
    window.webContents.once('did-finish-load', () => {
      void window.webContents.executeJavaScript('({ gear: Boolean(document.querySelector(".gear-button")), tabs: document.querySelectorAll(".tab").length })')
        .then((value) => write(`recovered ${JSON.stringify(value)}`))
        .catch((error) => write(`recover-failed ${String((error as Error).message)}`))
    })
  }

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
   * 新标签页的窄命令。
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
      const url = resolveNavigation(
        typeof command.address === 'string' ? command.address : '',
        currentSettings().searchEngine
      )
      if (!url) return { ok: false, code: 'invalid-address' }
      setImmediate(() => { if (!closing && tabs.includes(tab)) navigateTab(tab, url) })
      return { ok: true }
    }
    if (command.type === 'set-theme') {
      const outcome = setSetting('theme.mode', (command as { mode?: unknown }).mode)
      if (outcome === 'invalid') return { ok: false, code: 'invalid-setting' }
      if (outcome === 'unavailable') return { ok: false, code: 'storage-unavailable' }
      if (outcome === 'save-failed') return { ok: false, code: 'settings-save-failed' }
      refreshAllWindows()
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
  // 关闭一旦开始就标记出来：跨窗口移交的回挂路径据此拒绝把标签塞进正在关闭的窗口。
  window.on('close', () => {
    closeRequested = true
  })
  // 后台标签休眠扫描：每 30 秒一次；开关在设置里（`tab.discard = never` 时整个机制停用，
  // 挂机/自动化场景需要后台标签一直运行）。
  const discardTimer = setInterval(() => { void sweepDiscard() }, DISCARD_SWEEP_MS)
  // 心跳：开发态默认开（前台/隐藏冒烟都用它做长任务门槛），成品只在 `BAO_HEARTBEAT=1` 时开。
  startHeartbeat()
  window.on('closed', () => {
    // 最早抓一次会话投影：后面会逐个关闭 WebContents，标题/地址会退化成空值。
    const finalSession = sessionWindowSnapshot()
    clearInterval(discardTimer)
    stopHeartbeat()
    closing = true
    controllers.delete(shellContentsId)
    overlays.dispose()
    nativeTheme.off('updated', onNativeThemeUpdated)
    for (const tab of tabs) {
      cancelEngineSwitch(tab)
      tabRegistry.close(tab.id)
      advanceBinding(tab, 'tab-closed')
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
    // 预热飞窗（**在 show 之前**）：外壳文档已经加载完（上面的 await loadURL），此时窗口还不可见，
    // 用户不可能正在输入，所以"建浮层文档"与"用户打字"这两件事不可能重叠。
    // 这条顺序是被实测逼出来的：放到 show 之后、空闲时刻建时，开窗恰好落进"用户填好地址、
    // 还没敲回车"的窗口，回车会被吞掉（见 docs/discussions/2026-11-25-overlay-shared-process-demo.md §7.4）。
    // 自动化模式不预热——那会给「页面视图计数」类断言多一个 webContents。
    // 预热开关（设置项 overlay.prewarm，见 overlayPrewarmPolicy）：开=文档启动后常驻
    // （共享模式每窗口 5–9 MB；第一次点开就是热的）；关=完全不预热，用到才建。
    // 共享模式下 `prewarm()` 只是把"现在就建"推给外壳文档（`overlay-prewarm` 事件），
    // 主进程不自己建——但闸门（canPrewarm / 策略）仍在这里，所以必须调。
    // BAO_NO_PREWARM=1 只用于度量。
    if (!hidden && !background && !closing && !window.isDestroyed() &&
        process.env.BAO_NO_PREWARM !== '1' && overlayPrewarmPolicy() === 'always') overlays.prewarm()
    if (hidden) {
      // 保持 show:false：屏幕与任务栏都不出现（代价：Ruffle 出帧会被节流）。
    } else if (background) {
      applyAutomationWindowMode(window)
    } else {
      window.show()
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

/**
 * 静默创建浮层文档之后把焦点还回去。
 *
 * 实测（2026-11-25，`app/scripts/probe-overlay-focus*.cjs`）：`window.open` + `createWindow`
 * 把 guest 接成 WebContentsView 的做法**不会**改变 OS 激活，也不会移动 WebContents 焦点——
 * 前台悬停预热、后台空闲、以及"用户正在记事本里打字"三种场景下，
 * `BrowserWindow.getFocusedWindow()` / `win.isFocused()` / `webContents.getFocusedWebContents()`
 * 全程不变，按键照常落进原来的输入框。
 *
 * 那为什么还要这一手：这条链路上游**具备**抢焦点的能力（Chromium
 * `WebContentsImpl::CreateNewWindow` 在 `!renderer_started_hidden` 时会先 `widget_view->Show()`
 * 再 `contents_to_load->Focus()`，见 web_contents_impl.cc:5408/5529），当前只是被 Electron 的
 * WCV 宿主形态挡掉了。常驻预热把这个动作挪到了"用户没在操作本窗口"的时刻，一旦上游形态变化
 * （例如 guest 退回真窗口），代价就是随机吞键这种最难复现的故障。所以这里加一道确定性还原：
 * 只在外壳窗口仍 active、且焦点确实被 guest 拿走时才动手，绝不把后台窗口拉到前台。
 */
function restoreSeedFocus(
  seed: { window: BrowserWindow | null; contents: WebContents | null },
  guest: WebContents
): void {
  const owner = seed.window
  if (!owner || owner.isDestroyed() || !owner.isFocused()) return
  if (webContents.getFocusedWebContents() !== guest) return
  const target = seed.contents && !seed.contents.isDestroyed() ? seed.contents : owner.webContents
  if (!target.isDestroyed()) target.focus()
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
 * 目标窗没建成、且无处可回挂时的确定性清理。
 *
 * 只关 WebContents、释放租约并断开宿主，不写撤销栈：标签的页面已经不可用/没有窗口
 * 可承载，留一条「撤销关闭」只会恢复出空白。任何一步都不依赖源窗口仍然存在。
 */
function discardDetachedTab(tab: Tab): void {
  // 标签已没有窗口可承载：账本先注销（它不会再被任何窗口列出），代际推进只剩
  // 「作废在飞事件」的意义，所以仍然保留。
  tabRegistry.close(tab.id)
  tab.host = undefined
  activityLeases.releaseTab(tab.id)
  const view = tab.view
  tab.view = undefined
  tab.discarded = true
  // 页面可能已经被外部销毁（此时 `view.webContents` 取不到）：只关还活着的那一个。
  const contents = view?.webContents
  if (contents && !contents.isDestroyed()) contents.close()
}

/**
 * 把标签拖出窗口（架构 §3「拖出窗口」、审计 §3 跨窗口移交）。
 *
 * 同一 WebContents 换宿主，页面状态与插件内存态保留。目标窗口初始化是异步的，等待期间
 * 源窗口可能被排序、改固定甚至关闭，所以失败分支必须显式区分：
 * - 源窗口还能接收标签 → 按**当前**固定分组回挂；
 * - 源窗口已关闭 / 页面已失效 → 清理 WebContents 与租约，绝不回挂到已销毁窗口。
 */
async function tearOffTab(
  source: WindowController,
  command: Extract<BrowserCommand, { type: 'tearoff' }>
): Promise<BrowserResult> {
  if (!source.isAlive()) return fail('window-closed')
  const bounds = source.bounds()
  const inside = command.screenX >= bounds.x && command.screenX < bounds.x + bounds.width &&
    command.screenY >= bounds.y && command.screenY < bounds.y + bounds.height
  if (inside) return { ok: true, state: source.snapshot() }

  const detached = source.detachTab(command.id)
  if (!detached) return fail('unknown-tab')
  const tab = detached.tab

  try {
    await createBrowserWindow({
      shellUrl: source.shellUrl,
      flash: source.flash,
      adopt: tab,
      adoptIndex: detached.index,
      x: command.screenX,
      y: command.screenY,
      width: bounds.width,
      height: bounds.height
    })
  } catch (error) {
    // 显式失败分支：先判断源窗口此刻还能不能接回这个标签。
    if (!source.isAlive()) {
      discardDetachedTab(tab)
      console.error('跨窗口移动失败，原窗口已关闭，标签已清理。', error)
      return fail('tearoff-source-closed')
    }
    /**
     * 休眠标签**本来就没有视图**：这不是"页面丢了"，而是"要重建"。按失效处理会直接丢掉
     * 用户的标签（连同租约与会话），2026-11-26 审计就是这条。回挂时不要唤醒它。
     */
    if (tab.discarded && !tab.view) {
      source.adoptTab(tab, detached.index, { wake: false })
      console.error('跨窗口移动失败，标签处于休眠态，按元数据退回原窗口。', error)
      return fail('tearoff-failed')
    }
    // `view.webContents` 在页面被外部销毁后可能已经取不到：一律按「页面已失效」处理。
    const contents = tab.view?.webContents
    if (!contents || contents.isDestroyed()) {
      discardDetachedTab(tab)
      console.error('跨窗口移动失败，被移交页面已失效，标签已清理。', error)
      return fail('tearoff-page-lost')
    }
    // 回挂按源窗口**当前**的分组落位（adoptTab 内部夹取），不使用旧索引硬插。
    source.adoptTab(tab, detached.index)
    console.error('跨窗口移动失败，标签已退回原窗口。', error)
    return fail('tearoff-failed')
  }

  // 成功路径同样要防「源窗口在等待期间已经关闭」：`closeWindow()` 对已销毁窗口是空操作。
  if (source.isAlive() && source.isEmpty()) source.closeWindow()
  return { ok: true, state: source.snapshot() }
}

/**
 * 冒烟专用故障注入，只作用于**跨窗口接管**（`options.adopt`）：
 *
 * - `BAO_TEAROFF_INIT_DELAY_MS`：把目标窗口初始化拖长，给「等待期间源窗口排序 / 改固定 /
 *   关闭」留出确定的时间窗，避免测试靠猜时序；
 * - `BAO_TEAROFF_INIT_FAIL=1`：初始化直接失败（一次性消费，避免影响后续窗口）。
 *
 * 不用真实故障或超时来碰运气；生产环境不设置这两个变量时行为完全不变。
 */
async function injectAdoptFault(options: BrowserWindowOptions): Promise<void> {
  if (!options.adopt) return
  const delay = Number(process.env.BAO_TEAROFF_INIT_DELAY_MS ?? 0)
  if (Number.isFinite(delay) && delay > 0) await new Promise((done) => setTimeout(done, delay))
  if (process.env.BAO_TEAROFF_INIT_FAIL === '1') {
    delete process.env.BAO_TEAROFF_INIT_FAIL
    throw new Error('注入：目标窗口初始化失败')
  }
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
  /**
   * 心跳回执：按**发送者 WebContents** 路由回它所属的窗口。
   *
   * 只有外壳文档带这个 preload（页面视图与共享浮层 guest 都没有），所以不需要额外的来源校验；
   * 序号配对在 `HeartbeatMonitor` 里做，孤儿回执直接丢弃。
   */
  ipcMain.on(heartbeatChannels.pong, (event, seq: unknown) => {
    if (typeof seq !== 'number') return
    controllers.get(event.sender.id)?.heartbeatPong(seq)
  })
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
   * 清除已保存的会话（设置页「数据」分区的分类清理）。
   *
   * 与设置写通道同构：只有本窗口的内部设置页主帧能调。返回 `false` 表示存储不可用
   * 或写入失败（页面据此提示），不影响已打开的标签。
   */
  ipcMain.handle(settingsChannels.sessionClear, (event) => {
    const controller = controllerFor(event)
    if (!controller || !controller.internalSender(event)) return false
    return clearStoredSession()
  })

  /**
   * 清除全部站点引擎规则（「数据」分区的第二档）。
   *
   * 与会话清理不同，这里不动标签：已打开的标签保持当前引擎，只把"来源"重新算成默认。
   * 清完要让每个窗口重新投影一次，否则引擎胶囊会停在"站点已记住 Ruffle"上。
   */
  ipcMain.handle(settingsChannels.engineRulesClear, (event) => {
    const controller = controllerFor(event)
    if (!controller || !controller.internalSender(event)) return false
    if (!clearEngineRulesData()) return false
    refreshAllWindows()
    for (const item of controllers.values()) item.refreshProjection()
    return true
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

/**
 * 冒烟诊断钩子（仅未打包）：
 * - `__baoActivityLeases`：租约表，验证跨窗口移交/引擎切换清理后不留下租约；
 * - `__baoEngineDiagnostics()`：每个窗口每个标签的真实视图 id、绑定代际和未提交候选，
 *   用来断言两阶段引擎切换的提交/回退/清理，而不是只看 UI 提示。
 *
 * 不经过 IPC、不进入成品构建，也不改变任何产品行为。
 */
if (!app.isPackaged) {
  const globals = globalThis as unknown as Record<string, unknown>
  globals.__baoActivityLeases = activityLeases
  globals.__baoHeartbeatReset = () => {
    for (const controller of controllers.values()) controller.heartbeatReset()
  }
  globals.__baoEngineDiagnostics = () => [...controllers.entries()].map(([shellContentsId, controller]) => ({
    shellContentsId,
    tabs: controller.debugState(),
    heartbeat: controller.heartbeatStats()
  }))
  /** 统一能力层的调用记录（A1-c 的诊断面：断言外壳动作真的过了能力入口）。 */
  globals.__baoCapabilityCalls = () => capabilityCalls.list()
}
