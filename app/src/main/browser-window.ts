import { BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, WebContentsView } from 'electron'
import { backgroundSmoke as background, hiddenSmoke as hidden } from './automation'
import type { Input, IpcMainInvokeEvent, MenuItemConstructorOptions, NavigationEntry, Rectangle, WebContents } from 'electron'
import { join } from 'node:path'
import { browserChannels, browserFailureText, TAB_BAR_HEIGHT, TOOLBAR_HEIGHT } from '../shared/browser'
import type { BrowserCommand, BrowserFailureCode, BrowserResult, BrowserState, BrowserTab } from '../shared/browser'
import { hostOf } from '../shared/engine'
import { isSameSite, siteBoundary } from '../shared/site'
import type { BrowserEngine, EngineSource } from '../shared/engine'
import { getInternalSession, getPageSession, getShellSession } from './sessions'
import { bindRuffleProtocol } from './ruffle'
import { registerPageView } from './page-views'
import * as engineRules from './engine-rules'
import { setSetting, settings as currentSettings, storageStatus } from './storage'
import { bindInternalProtocol, isSettingsUrl, parseSettingsAddress, SETTINGS_URL } from './internal-pages'
import { settingsChannels } from '../shared/settings'
import type { SettingsSnapshot } from '../shared/settings'
import { importFlashPlugin } from './flash-plugin'
import { flashStatus } from './plugins'
import { START_PAGE } from './start-page'
import { windowPalette } from '../shared/shell-theme'
import type { ShellTheme } from '../shared/shell-theme'
import { overlayChannels } from '../shared/overlay'
import { createShellOverlays } from './shell-overlays'
import { attachPopupChrome } from './popup-chrome'

/**
 * 标签（架构 §3 主进程与窗口、页面）。
 *
 * `id` 是**全局**稳定业务 ID：跨窗口移动后不变，因此不能按窗口计数。
 * `host` 指向当前拥有该标签的窗口；事件回调只读取 `host`，跨窗口移动时无需重挂监听。
 * `binding` 是 WebContents 绑定代际，替换或销毁时递增，旧代际的迟到事件据此作废。
 */
interface Tab {
  id: number
  view: WebContentsView
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
   * 内部页标记（架构 §3 外壳）：M2 只有设置页 `bao://settings`。
   * 内部页不参与引擎切换/站点规则/下载，也没有页面权限。
   */
  internal?: 'settings'
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
  internal?: 'settings'
}

const controllers = new Map<number, WindowController>()
/** 全局标签 ID 序列：跨窗口唯一（架构 §3「每个标签有稳定业务 ID」）。 */
let nextTabId = 1
let nextNoticeId = 1

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
  const overlays = createShellOverlays(window, shellUrl, sameDocument, (input) => (active ? handleShortcut(active, input) : false))
  const tabs: Tab[] = []
  const recentlyClosed: ClosedTab[] = []
  let active: Tab | undefined
  let revision = 0
  let closing = false

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
    if (tab.manualOverride) return 'manual'
    const url = tab.failedUrl ?? safe(() => tab.view.webContents.getURL(), '')
    return engineRules.resolve(hostOf(url === START_PAGE ? '' : url)).source
  }

  function describe(tab: Tab): BrowserTab {
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
        canGoBack = safe(() => contents.navigationHistory.canGoBack(), false)
        canGoForward = safe(() => contents.navigationHistory.canGoForward(), false)
        loading = safe(() => contents.isLoadingMainFrame(), false)
      }
    }
    // 内部页在首帧加载完成前也要显示自己的地址（Chrome 同样立刻显示 chrome://settings）。
    const address = tab.failedUrl ?? (tab.internal ? (url || SETTINGS_URL) : (url === START_PAGE ? '' : url))
    const pin = engineRules.resolve(hostOf(address))
    return {
      id: tab.id,
      title: address ? title || address : tab.initialTitle,
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
      internal: tab.internal
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
      tabs: tabs.map(describe)
    }
  }

  function publish(): void {    if (closing || !active || !tabs.includes(active)) return
    if (window.isDestroyed() || window.webContents.isDestroyed()) return
    revision += 1
    const snapshot = state()
    window.webContents.send(browserChannels.changed, snapshot)
    overlays.publish(snapshot)
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
    const y = TAB_BAR_HEIGHT + TOOLBAR_HEIGHT
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
   * 内部页视图（`bao://settings`）。
   *
   * 与页面视图**同一套沙箱**（`sandbox/contextIsolation/nodeIntegration`），只是换了会话、
   * preload 与协议；**刻意不调 `registerPageView()`**——内部页不是 Ruffle/broker 的页面视图，
   * 那两条特权通道对它保持关闭。
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
      allow: tab.internal ? isSettingsUrl : isWebAddress
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
    contents.on('did-navigate', () => {
      if (!live()) return
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
    void tab.view.webContents.loadURL(url).catch(() => {})
  }

  /** `url === null` 表示不自动导航：撤销关闭与引擎切换要先把导航栈 restore 上去。 */
  function addTab(
    initialTitle = '新标签页',
    url: string | null = START_PAGE,
    engine: BrowserEngine = engineFor(url ?? undefined).engine,
    source: EngineSource = engineFor(url ?? undefined).source
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
   * 开一个内部页标签（`bao://settings`）。
   *
   * 引擎字段只是占位：内部页没有引擎，也不参与站点规则；`describe()` 会把 `internal`
   * 带给渲染层，工具栏据此隐藏引擎胶囊。
   */
  function openInternalTab(): Tab {
    const view = createInternalView()
    const tab: Tab = {
      id: nextTabId++,
      view,
      binding: 1,
      error: '',
      initialTitle: '设置',
      engine: engineFor(undefined).engine,
      manualOverride: false,
      pinned: false,
      muted: false,
      host: controller,
      internal: 'settings'
    }
    tabs.push(tab)
    bind(tab, view)
    load(tab, SETTINGS_URL)
    return tab
  }

  /** Edge 语义：已存在就切过去，不存在才新建（P3：每窗口最多一个设置标签）。 */
  function openSettingsTab(): Tab {
    const existing = tabs.find((item) => item.internal === 'settings')
    if (existing) {
      select(existing, true)
      return existing
    }
    const opened = openInternalTab()
    select(opened, true)
    return opened
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

  function select(tab: Tab, focus = true): void {
    if (active !== tab) {
      if (active && window.contentView.children.includes(active.view)) {
        window.contentView.removeChildView(active.view)
      }
      active = tab
      window.contentView.addChildView(tab.view)
      overlays.setActivePage(tab.view.webContents)
      layout()
    }
    if (focus) focusContents(tab.view.webContents)
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
    if (window.contentView.children.includes(previous)) window.contentView.removeChildView(previous)
    if (!previous.webContents.isDestroyed()) previous.webContents.close()
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
    const contents = tab.view.webContents
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
      load(tab, tab.internal ? SETTINGS_URL : START_PAGE)
      return
    }
    const view = tab.view
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
    const host = hostOf(tab.failedUrl ?? safe(() => tab.view.webContents.getURL(), ''))
    if (!host) return fail('no-site')
    if (!engineRules.remember(host, tab.engine)) return fail('site-rule-save-failed')
    tab.manualOverride = false
    publish()
    return { ok: true, state: state() }
  }

  /** 取消当前站点的引擎规则，回到「手动切换」状态（记住要可撤销）。 */
  function forgetActiveEngine(tab: Tab): BrowserResult {
    const host = hostOf(tab.failedUrl ?? safe(() => tab.view.webContents.getURL(), ''))
    if (!host) return fail('no-site')
    if (!engineRules.forget(host)) return fail('site-rule-save-failed')
    tab.manualOverride = true
    publish()
    return { ok: true, state: state() }
  }

  /** 复制标签页：同 URL、同引擎，作为新标签插到末尾并激活（架构 §3「标签操作」）。 */
  function duplicateTab(tab: Tab): void {
    const url = safe(() => tab.view.webContents.getURL(), '')
    const copy = addTab(tab.initialTitle, url && url !== START_PAGE ? url : START_PAGE, tab.engine, sourceOf(tab))
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
    const contents = tab.view.webContents
    if (!contents.isDestroyed()) contents.setAudioMuted(tab.muted)
    publish()
  }

  /** 标签右键菜单：原生菜单，光标位置弹出（比自绘菜单更贴合系统习惯）。 */
  function showTabMenu(tab: Tab): void {
    const contents = tab.view.webContents
    const muted = !contents.isDestroyed() && safe(() => contents.isAudioMuted(), false)
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
          { type: 'separator' },
          { label: '关闭标签页', click: () => closeTab(tab) },
          { label: '撤销关闭的标签页', enabled: recentlyClosed.length > 0, click: () => void undoClose() }
        ]
    Menu.buildFromTemplate(template).popup({ window })
  }

  function reloadTab(tab: Tab): void {
    const contents = tab.view.webContents
    const url = contents.isDestroyed() ? '' : safe(() => contents.getURL(), '')
    if (contents.isDestroyed() || contents.isCrashed()) {
      rebuild(tab, tab.failedUrl || url || START_PAGE)
      return
    }
    if (tab.failedUrl) load(tab, tab.failedUrl)
    else contents.reload()
  }

  function rememberClosed(tab: Tab): void {
    const contents = tab.view.webContents
    if (contents.isDestroyed()) return
    const entries = safe(() => contents.navigationHistory.getAllEntries(), [])
    if (entries.length === 0) return
    recentlyClosed.push({
      entries,
      index: safe(() => contents.navigationHistory.getActiveIndex(), entries.length - 1),
      engine: tab.engine,
      manualOverride: tab.manualOverride,
      internal: tab.internal
    })
    if (recentlyClosed.length > CLOSED_TAB_LIMIT) recentlyClosed.shift()
  }

  function closeTab(tab: Tab): void {
    const index = tabs.indexOf(tab)
    if (index < 0) return
    const wasActive = active === tab
    rememberClosed(tab)
    tabs.splice(index, 1)
    tab.binding += 1
    tab.host = undefined
    if (window.contentView.children.includes(tab.view)) window.contentView.removeChildView(tab.view)
    if (active === tab) active = undefined
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    if (wasActive) {
      const next = tabs[index] ?? tabs[index - 1]
      select(next ?? addTab(), true)
    }
    publish()
  }

  /** 撤销关闭：新建 WebContents 并用 E39 导航栈恢复（架构 §3「撤销关闭」）。 */
  function undoClose(): BrowserResult {
    const closed = recentlyClosed.pop()
    if (!closed) return fail('nothing-to-undo')
    // 内部页撤销关闭要重建**内部视图**，否则会变成"内部标签里跑页面语义"。
    const tab = closed.internal
      ? openInternalTab()
      : addTab('新标签页', null, closed.engine, closed.manualOverride ? 'manual' : 'default')
    select(tab, true)
    void restoreHistory(tab, closed.entries, closed.index,
      closed.entries[closed.index]?.url ? '无法恢复完整历史，已打开最后一个地址' : '无法恢复此前关闭的标签页')
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
      else select(addTab(), true)
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
    if (window.contentView.children.includes(tab.view)) window.contentView.removeChildView(tab.view)
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
    refreshSettings: updateWindowControls,
    broadcastSettings,
    ownsContents,
    internalSender,
    internalSnapshot,
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
        select(addTab(), true)
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
      case 'navigate': {
        const target = activeTab()
        if (!target) return fail('unknown-tab')
        /**
         * 内部页里的地址栏：
         * - `bao://settings` → 保持在设置页；
         * - 其它 http(s) → **新开一个标签**（P2）。内部会话永远不承载网页，否则那个网页
         *   就能 `fetch('bao://settings/…')`（实测 200），等于给页面开新特权面。
         */
        if (target.internal) {
          const address = typeof command.address === 'string' ? command.address : ''
          if (parseSettingsAddress(address)) {
            load(target, SETTINGS_URL)
            break
          }
          const opened = parseAddress(address)
          if (!opened) return fail('invalid-address')
          const resolved = engineFor(opened)
          select(addTab('新标签页', opened, resolved.engine, resolved.source), true)
          break
        }
        const url = typeof command.address === 'string' ? parseAddress(command.address) : undefined
        if (!url) return fail('invalid-address')
        // 站点规则只决定「初始」引擎：用户在这个标签上手动切换过，就沿用他的选择。
        const resolved = target.manualOverride
          ? { engine: target.engine, source: 'manual' as EngineSource }
          : engineFor(url)
        if (resolved.engine !== target.engine) {
          swapView(target, resolved.engine, resolved.source)
          load(target, url)
          break
        }
        const contents = target.view.webContents
        if (contents.isDestroyed() || contents.isCrashed()) {
          rebuild(target, url)
          break
        }
        void contents.loadURL(url).catch(() => {})
        focusContents(contents)
        break
      }
      case 'back': {
        const tab = activeTab()
        if (!tab) return fail('unknown-tab')
        tab.view.webContents.navigationHistory.goBack()
        break
      }
      case 'forward': {
        const tab = activeTab()
        if (!tab) return fail('unknown-tab')
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

  /** 设置变化后推给本窗口的内部页；页面自己决定怎么重绘。 */
  function broadcastSettings(): void {
    const snapshot = internalSnapshot()
    for (const tab of tabs) {
      if (!tab.internal) continue
      const contents = tab.view.webContents
      if (!contents.isDestroyed()) contents.send(settingsChannels.changed, snapshot)
    }
  }

  function ownsContents(contentsId: number): boolean {
    return tabs.some((tab) => tab.view.webContents.id === contentsId)
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
    const tab = tabs.find((item) => item.internal === 'settings' && item.view.webContents.id === event.sender.id)
    if (!tab) return false
    const frame = event.senderFrame
    if (!frame || frame !== event.sender.mainFrame) return false
    return isSettingsUrl(frame.url)
  }

  /**
   * 系统主题变化（`themeSource: 'system'` 时由操作系统触发）：
   * 外壳/叠加层重绘 + 内部页也要拿到新的解析主题，否则设置页会停在上一个亮/暗。
   */
  function onNativeThemeUpdated(): void {
    updateWindowControls()
    broadcastSettings()
  }

  nativeTheme.on('updated', onNativeThemeUpdated)
  window.on('resize', layout)
  window.on('closed', () => {
    closing = true
    controllers.delete(shellContentsId)
    overlays.dispose()
    nativeTheme.off('updated', onNativeThemeUpdated)
    for (const tab of tabs) {
      tab.binding += 1
      tab.host = undefined
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close()
    }
    tabs.length = 0
    active = undefined
  })

  controllers.set(shellContentsId, controller)

  if (options.adopt) {
    // 两阶段接管（2026-11-23 审计 P1-4）：接管放到外壳加载成功之后。
    // 原先先接管再 loadURL，一旦窗口创建/加载失败，`window.on('closed')` 会把
    // 被移交标签的 WebContents 一起关掉，源窗口再想接回时页面已经没了。
  } else if (options.initialAddress) {
    // 命令行带了地址：首个标签按站点规则决定引擎后直接打开。
    const resolved = engineFor(options.initialAddress)
    const opened = addTab('新标签页', options.initialAddress, resolved.engine, resolved.source)
    select(opened, true)
  } else {
    // 启动只开一个标签页；多标签由「新建标签页」与冒烟测试覆盖。
    select(addTab('新标签页'), false)
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
      // 预热齿轮飞窗（首次打开不卡）：真实使用下提前建好隐藏的 WebContentsView，
      // 打开时只需 setBounds。自动化模式不预热——那会给「页面视图计数」类断言多一个子视图。
      window.once('ready-to-show', () => {
        setTimeout(() => {
          if (closing || window.isDestroyed()) return
          overlays.prewarm('quick')
        }, 600)
      })
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
    if (detached.tab.view.webContents.isDestroyed()) {
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
   * Flash 插件状态 / 导入（BYOP）。
   *
   * 只有内部设置页能调；对话框由主进程弹（页面拿不到任意文件路径）。导入只把文件复制到
   * `<userData>/flash/`，插件注册发生在下一次启动，所以结果里带 `restartRequired`。
   */
  ipcMain.handle(settingsChannels.flashStatus, (event) => {
    const controller = controllerFor(event)
    if (!controller || !controller.internalSender(event)) return undefined
    return flashStatus()
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
    const current = flashStatus()
    return importFlashPlugin(picked.filePaths[0], current.ready)
  })
}
