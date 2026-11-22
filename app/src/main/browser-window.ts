import { BrowserWindow, ipcMain, nativeTheme, screen, WebContentsView } from 'electron'
import type { Input, IpcMainInvokeEvent, NavigationEntry, Rectangle } from 'electron'
import { join } from 'node:path'
import { browserChannels, browserFailureText, TAB_BAR_HEIGHT, TOOLBAR_HEIGHT } from '../shared/browser'
import type { BrowserCommand, BrowserFailureCode, BrowserResult, BrowserState, BrowserTab } from '../shared/browser'
import { hostOf } from '../shared/engine'
import type { BrowserEngine, EngineSource } from '../shared/engine'
import { getPageSession, getShellSession } from './sessions'
import { bindRuffleProtocol, registerPageView } from './ruffle'
import * as engineRules from './engine-rules'
import { START_PAGE } from './start-page'
import { windowPalette } from '../shared/shell-theme'
import type { ShellTheme } from '../shared/shell-theme'

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
  initialTitle: string
  /** 当前引擎与其来源（架构 §3 引擎）。 */
  engine: BrowserEngine
  engineSource: EngineSource
  host?: TabHost
}

interface TabHost {
  notify(tab: Tab): void
}

interface WindowController extends TabHost {
  readonly shellUrl: string
  readonly flash: boolean
  snapshot(): BrowserState
  run(event: IpcMainInvokeEvent, command: BrowserCommand): BrowserResult | Promise<BrowserResult>
  detachTab(id: number): { tab: Tab; index: number } | undefined
  adoptTab(tab: Tab, index?: number): void
  isEmpty(): boolean
  bounds(): Rectangle
  closeWindow(): void
}

export interface BrowserWindowOptions {
  shellUrl: string
  /** 页面视图启用 PPAPI 插件（架构 §3 引擎）。 */
  flash?: boolean
  /** 接管一个已存在的标签（跨窗口移动）。 */
  adopt?: Tab
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
  engineSource: EngineSource
}

const controllers = new Map<number, WindowController>()
/** 全局标签 ID 序列：跨窗口唯一（架构 §3「每个标签有稳定业务 ID」）。 */
let nextTabId = 1

function fail(code: BrowserFailureCode): BrowserResult {
  return { ok: false, code, message: browserFailureText[code] }
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
function siteOf(url: string): string | undefined {
  const host = hostOf(url)
  if (!host) return undefined
  if (/^\d+(?:\.\d+){3}$/.test(host) || host.includes(':')) return host
  const labels = host.split('.')
  return labels.length <= 2 ? host : labels.slice(-2).join('.')
}

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
  const plugins = options.flash === true
  const shellUrl = options.shellUrl
  const placement = placeWindow(options)
  const window = new BrowserWindow({
    ...placement,
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
    const address = url === START_PAGE ? '' : url
    return {
      id: tab.id,
      title: address ? title || address : tab.initialTitle,
      address,
      canGoBack,
      canGoForward,
      loading,
      crashed,
      error: tab.error,
      engine: tab.engine,
      engineSource: tab.engineSource
    }
  }

  function state(): BrowserState {
    return {
      revision,
      theme: currentTheme(),
      activeId: active?.id ?? -1,
      undoCount: recentlyClosed.length,
      tabs: tabs.map(describe)
    }
  }

  function publish(): void {
    if (closing || !active || !tabs.includes(active)) return
    if (window.isDestroyed() || window.webContents.isDestroyed()) return
    revision += 1
    window.webContents.send(browserChannels.changed, state())
  }

  function notify(tab: Tab): void {
    if (tabs.includes(tab)) publish()
  }

  function layout(): void {
    if (!active) return
    const [width, height] = window.getContentSize()
    const y = TAB_BAR_HEIGHT + TOOLBAR_HEIGHT
    active.view.setBounds({ x: 0, y, width, height: Math.max(0, height - y) })
  }

  /**
   * 引擎决定视图的 preload 与插件开关（架构 §3 引擎）：
   * - `ppapi`：原生 Flash 插件，无页面 preload；
   * - `ruffle`：关闭插件，挂页面 preload 注入本地 Ruffle 运行时。
   * 两种引擎都保持 `sandbox: true` 与 `contextIsolation: true`（沙箱要求见内核补丁记录）。
   */
  function createView(engine: BrowserEngine): WebContentsView {
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

  /** 事件只按 `tab.host` 分发，跨窗口移动时无需重挂监听。 */
  function bind(tab: Tab, view: WebContentsView): void {
    const binding = tab.binding
    const contents = view.webContents
    const live = () => tab.view === view && tab.binding === binding && !contents.isDestroyed()

    contents.on('before-input-event', (event, input) => {
      if (live() && handleShortcut(input)) event.preventDefault()
    })
    /**
     * 受控弹窗（架构 §3 权限与会话「对弹窗、新窗口、导航及外部协议设显式策略」）。
     *
     * 只允许**同站点**的 http(s) 弹窗，并以「新标签」承载（引擎与来源继承 opener）；
     * 跨站、非 http(s)（`file:`/`about:blank`/自定义协议）一律拒绝。
     *
     * 已知限制：以标签承载会丢失 `window.opener` 与带 features 的独立弹窗窗口。真实站点
     * 若依赖 `opener.postMessage`/`opener.location` 做 lobby→game 交接，需要改成
     * `overrideBrowserWindowOptions` 的真实弹窗窗口（142 报告的探针就是这个形态）。
     * 该限制在真实站点上未验证（本增量不做真站回归）。
     */
    contents.setWindowOpenHandler(({ url }) => {
      if (!live() || !isWebAddress(url)) return { action: 'deny' }
      const openerSite = siteOf(safe(() => contents.getURL(), ''))
      if (!openerSite || openerSite !== siteOf(url)) {
        console.warn(`[popup] 拒绝跨站弹窗：${url}`)
        return { action: 'deny' }
      }
      const opened = addTab('新标签页', null, tab.engine, tab.engineSource)
      load(opened, url)
      select(opened, true)
      return { action: 'deny' }
    })
    contents.on('will-frame-navigate', (event) => {
      if (live() && event.isMainFrame && !isWebAddress(event.url)) event.preventDefault()
    })
    contents.on('will-redirect', (event) => {
      if (live() && event.isMainFrame && !isWebAddress(event.url)) event.preventDefault()
    })
    contents.on('did-start-loading', () => {
      if (!live()) return
      tab.error = ''
      tab.host?.notify(tab)
    })
    contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (!live() || !isMainFrame || code === -3) return
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
      if (live()) tab.host?.notify(tab)
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
    const view = createView(engine)
    const tab: Tab = {
      id: nextTabId++, view, binding: 1, error: '', initialTitle, engine, engineSource: source, host: controller
    }
    tabs.push(tab)
    bind(tab, view)
    if (url !== null) load(tab, url)
    return tab
  }

  function select(tab: Tab, focus = true): void {
    if (active !== tab) {
      if (active && window.contentView.children.includes(active.view)) {
        window.contentView.removeChildView(active.view)
      }
      active = tab
      window.contentView.addChildView(tab.view)
      layout()
    }
    if (focus && !tab.view.webContents.isDestroyed()) tab.view.webContents.focus()
    publish()
  }

  /**
   * 换一个 WebContents（同引擎重建或换引擎）。旧代际事件立即作废。
   * 用于渲染进程崩溃恢复与引擎切换（架构 §3 页面、§3 引擎、§6 M1）。
   */
  function swapView(tab: Tab, engine: BrowserEngine, source: EngineSource): WebContentsView {
    const previous = tab.view
    const view = createView(engine)
    tab.binding += 1
    tab.view = view
    tab.engine = engine
    tab.engineSource = source
    tab.error = ''
    bind(tab, view)
    const measured = active === tab
    if (measured) {
      window.contentView.addChildView(view)
      layout()
    }
    if (window.contentView.children.includes(previous)) window.contentView.removeChildView(previous)
    if (!previous.webContents.isDestroyed()) previous.webContents.close()
    if (measured && !view.webContents.isDestroyed()) view.webContents.focus()
    return view
  }

  function rebuild(tab: Tab, url: string): void {
    swapView(tab, tab.engine, tab.engineSource)
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
    swapView(tab, engine, 'manual')
    void restoreHistory(tab, entries, index)
  }

  /**
   * 恢复导航栈。`restore()` 只能还原 URL 与滚动/表单状态，POST 体等无法还原 ——
   * 失败时退回最后一个已知地址并给出可理解的恢复动作（架构 §3 引擎）。
   */
  async function restoreHistory(
    tab: Tab,
    entries: NavigationEntry[],
    index: number,
    failure = browserFailureText['engine-switch-failed']
  ): Promise<void> {
    if (entries.length === 0) {
      load(tab, START_PAGE)
      return
    }
    try {
      await tab.view.webContents.navigationHistory.restore({ entries, index })
    } catch (error) {
      const fallback = entries[index]?.url || entries.at(-1)?.url
      tab.error = failure
      if (fallback) load(tab, fallback)
      publish()
      console.error('无法恢复导航栈。', error)
    }
  }

  /** 把当前标签的引擎记为站点规则（架构 §3 引擎「用户手动切换时可确认记为站点规则」）。 */
  function rememberActiveEngine(tab: Tab): BrowserResult {
    const host = hostOf(safe(() => tab.view.webContents.getURL(), ''))
    if (!host) return fail('no-site')
    engineRules.remember(host, tab.engine)
    tab.engineSource = 'site-rule'
    publish()
    return { ok: true, state: state() }
  }

  function reloadTab(tab: Tab): void {
    const contents = tab.view.webContents
    const url = contents.isDestroyed() ? '' : safe(() => contents.getURL(), '')
    if (contents.isDestroyed() || contents.isCrashed()) {
      rebuild(tab, url || START_PAGE)
      return
    }
    contents.reload()
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
      engineSource: tab.engineSource
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
    const tab = addTab('新标签页', null, closed.engine, closed.engineSource)
    select(tab, true)
    void restoreHistory(tab, closed.entries, closed.index,
      closed.entries[closed.index]?.url ? '无法恢复完整历史，已打开最后一个地址' : '无法恢复此前关闭的标签页')
    return { ok: true, state: state() }
  }

  /** 标签排序：只改顺序，不动 WebContents（架构 §3「排序」）。 */
  function moveTab(tab: Tab, index: number): void {
    const from = tabs.indexOf(tab)
    if (from < 0 || !Number.isFinite(index)) return
    const to = Math.min(Math.max(Math.trunc(index), 0), tabs.length - 1)
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
  function handleShortcut(input: Input): boolean {
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
      if (active) closeTab(active)
      return true
    }
    return false
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
    snapshot: state,
    notify,
    isEmpty: () => tabs.length === 0,
    bounds: () => window.getBounds(),
    closeWindow: () => {
      if (!window.isDestroyed()) window.destroy()
    },
    detachTab,
    adoptTab,
    run
  }

  function activeTab(): Tab | undefined {
    return active
  }

  async function run(event: IpcMainInvokeEvent, command: BrowserCommand): Promise<BrowserResult> {
    if (closing) return fail('window-closed')
    const frame = event.senderFrame
    if (event.sender !== window.webContents || !frame || frame !== window.webContents.mainFrame ||
        !sameDocument(frame.url, shellUrl)) {
      return fail('forbidden-sender')
    }
    if (!command || typeof command !== 'object' || typeof command.type !== 'string') {
      return fail('invalid-command')
    }

    switch (command.type) {
      case 'snapshot':
        break
      case 'add':
        select(addTab(), true)
        break
      case 'select':
      case 'close': {
        const tab = tabs.find(({ id }) => id === command.id)
        if (!tab) return fail('unknown-tab')
        if (command.type === 'select') select(tab)
        else closeTab(tab)
        break
      }
      case 'tearoff':
        return tearOffTab(controller, command)
      case 'undo-close':
        return undoClose()
      case 'set-engine': {
        const tab = activeTab()
        if (!tab) return fail('unknown-tab')
        if (command.engine !== 'ppapi' && command.engine !== 'ruffle') return fail('invalid-command')
        switchEngine(tab, command.engine)
        break
      }
      case 'remember-engine': {
        const tab = activeTab()
        if (!tab) return fail('unknown-tab')
        return rememberActiveEngine(tab)
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
        const url = typeof command.address === 'string' ? parseAddress(command.address) : undefined
        if (!url) return fail('invalid-address')
        // 站点规则只决定「初始」引擎：用户在这个标签上手动切换过，就沿用他的选择。
        const resolved = target.engineSource === 'manual'
          ? { engine: target.engine, source: target.engineSource }
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
        contents.focus()
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
    if (handleShortcut(input)) event.preventDefault()
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

  nativeTheme.on('updated', updateWindowControls)
  window.on('resize', layout)
  window.on('closed', () => {
    closing = true
    controllers.delete(shellContentsId)
    nativeTheme.off('updated', updateWindowControls)
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
    adoptTab(options.adopt, options.adoptIndex ?? 0)
  } else {
    // 启动只开一个标签页；多标签由「新建标签页」与冒烟测试覆盖。
    select(addTab('新标签页'), false)
  }

  try {
    await window.loadURL(shellUrl)
    window.show()
  } catch (error) {
    closing = true
    controllers.delete(shellContentsId)
    if (!window.isDestroyed()) window.destroy()
    throw error
  }
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
    source.adoptTab(detached.tab, detached.index)
    console.error('跨窗口移动失败，标签已退回原窗口。', error)
    return fail('tearoff-failed')
  }

  if (source.isEmpty()) source.closeWindow()
  return { ok: true, state: source.snapshot() }
}

let registered = false

/** 全局只注册一次命令通道，按发送者窗口路由；窗口关闭不注销该通道。 */
export function registerBrowserIpc(): void {
  if (registered) return
  registered = true
  ipcMain.handle(browserChannels.command, (event, command: unknown) => {
    const controller = controllers.get(event.sender.id)
    if (!controller) return fail('forbidden-sender')
    return controller.run(event, command as BrowserCommand)
  })
}
