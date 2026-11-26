import { WebContentsView } from 'electron'
import type { BrowserWindow, Event, Input, IpcMainInvokeEvent, MouseInputEvent, WebContents } from 'electron'
import { join } from 'node:path'
import { browserChannels } from '../shared/browser'
import type { BrowserState } from '../shared/browser'
import { OVERLAY_QUERY, isQuickView, overlayChannels } from '../shared/overlay'
import { OVERLAY_GUTTER_BOTTOM, clampBelow, clampBounds, insideCard } from '../shared/overlay-geometry'
import type { OverlayBounds, OverlayEvent, OverlayKind, QuickView } from '../shared/overlay'
import type { PrewarmMode } from '../shared/settings'
import { beginOpen, markContent, markVisible, readSamples, resetSamples, summarize } from './overlay-metrics'
import { getShellSession } from './sessions'

interface HostedView {
  view: WebContentsView
  bounds?: OverlayBounds
  ready: boolean
  text?: string
  /** 共用视图当前在显示哪一种内容（同一个文档按事件切换组件）。 */
  kind?: OverlayKind
  /** 飞窗当前画哪一页（`kind === 'quick'` 时有效）：快捷设置 / 收藏夹。 */
  quick?: QuickView
}

const FLYOUT_KINDS = ['panel', 'quick'] as const
type FlyoutKind = (typeof FLYOUT_KINDS)[number]

/** 浮层长任务阈值（毫秒）：超过就当"浮层里放了重活"。 */
const OVERLAY_LONG_TASK_MS = Number(process.env.BAO_OVERLAY_LONG_TASK_MS ?? 50)

/**
 * 诊断落盘：`BAO_OVERLAY_TRACE` 未设置时只走 `console.warn`。
 *
 * 和 `BAO_DISCARD_TRACE` / `BAO_SELFHEAL_TRACE` 同一套约定——误杀/卡顿时第一个问题永远是
 * "是哪段脚本干的"，所以 `source` 必须带上（LoAF 的 `sourceURL` 或 `longtask` 的 name）。
 */
function traceOverlayLongTask(duration: number, source: string): void {
  const line = `overlay longtask ${Math.round(duration)}ms source=${source || 'unknown'}`
  if (duration >= OVERLAY_LONG_TASK_MS) console.warn(`[overlay] ${line}`)
  const file = process.env.BAO_OVERLAY_TRACE
  if (!file) return
  const { appendFileSync } = require('node:fs') as typeof import('node:fs')
  try {
    appendFileSync(file, `${Date.now()} ${line}\n`)
  } catch {
    // 诊断写盘失败不影响浏览。
  }
}

/**
 * 叠加层只保留**一个**视图：panel / quick / toast 共用同一个文档与渲染进程。
 *
 * 为什么不按 kind 分开：每多一个 WebContentsView 就多一个渲染进程（建进程 30–90 ms），
 * 于是每种飞窗都得自己预热、还得错开预热时间。合并后飞窗只有一个渲染进程，
 * 打开时只需要 setBounds + setVisible + 一条「显示哪种内容」的事件。
 */
const OVERLAY_MODE = 'overlay'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function readBounds(value: unknown): OverlayBounds | undefined {
  if (!isRecord(value)) return
  const { x, y, width, height } = value
  if (isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(width) && isFiniteNumber(height) &&
      width > 0 && height > 0) return { x, y, width, height }
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
}

/**
 * 转发透明边距里的鼠标时要知道"页面在哪"：当前页面的 WebContents 与它在窗口里的位置。
 * 由 `browser-window` 提供（它才是布局的唯一负责人）。
 */
export interface PageFrame {
  contents: WebContents
  bounds: { x: number; y: number; width: number; height: number }
}

/** Native sibling views cover the active page without changing its layout. */
export function createShellOverlays(
  window: BrowserWindow,
  shellUrl: string,
  sameDocument: (actual: string, expected: string) => boolean,
  handleShortcut: (input: Input) => boolean,
  currentTheme: () => 'light' | 'dark',
  /** 自动化模式下不预热：多出来的视图会干扰「页面视图计数」类断言。 */
  canPrewarm: () => boolean,
  /** 预热策略：always=窗口创建即预热（默认）；never=用到才建、不做任何提前创建。 */
  prewarmPolicy: () => PrewarmMode,
  /** 共享进程模式（proto）：视图由外壳 window.open 产生，主进程只接管，不自己建。 */
  shared: () => boolean,
  /** 当前页面视图的位置与 WebContents（透明边距里的鼠标转发到它）。 */
  pageFrame: () => PageFrame | undefined
) {
  const shell = window.webContents
  let flyout: HostedView | undefined
  let activePage: WebContents | undefined
  let pendingOpen = 0
  /** 上一次真正通知渲染层的内容种类：用来判断「可见但换内容」是否要补发打开事件。 */
  let shownKind: OverlayKind | undefined
  /** 上一次通知渲染层的飞窗内容页：换页（快捷设置 ↔ 收藏夹）同样要补发 open 事件。 */
  let shownQuick: QuickView | undefined
  let disposed = false

  function sender(event: IpcMainInvokeEvent): 'shell' | 'panel' | 'quick' | 'toast' | undefined {
    if (disposed) return
    const frame = event.senderFrame
    if (!frame || frame !== event.sender.mainFrame || !sameDocument(frame.url, shellUrl)) return
    const modes = new URL(frame.url).searchParams.getAll(OVERLAY_QUERY)
    if (event.sender === shell) return modes.length === 0 ? 'shell' : undefined
    const mode = modes.length === 1 ? modes[0] : undefined
    if (mode === undefined) return
    if (mode === OVERLAY_MODE && event.sender === flyout?.view.webContents) return flyout?.kind
  }

  function send(contents: WebContents, message: OverlayEvent): void {
    // 共享进程模式下浮层文档没有 preload：它通过 opener 订阅的是**外壳**的通道，
    // 所以事件发给外壳（外壳 preload 会转发给包括浮层在内的所有订阅者）。
    const target = shared() ? shell : contents
    if (!target.isDestroyed()) target.send(overlayChannels.event, message)
  }

  /** 只发给外壳（共享模式的"指挥"事件：预热、内容补发）。 */
  function sendToShell(message: OverlayEvent): void {
    if (!shell.isDestroyed()) shell.send(overlayChannels.event, message)
  }

  /** 只有叠加层自己会发的命令：共享模式下它们经外壳的桥发言，需要按当前内容种类认角色。 */
  const OVERLAY_ONLY_COMMANDS = new Set<string>([
    'report-ready', 'report-failure', 'resize-panel', 'resize-quick',
    'close-panel', 'close-quick', 'dismiss-toast', 'pull-overlay', 'report-longtask',
    // 飞窗里的「收藏夹」入口同样由浮层文档发起（它不知道该把飞窗挂到哪个按钮下）。
    'open-bookmarks',
    // 气泡里的「更多」：同上，锚点与换页都在外壳那边。
    'open-bookmark-editor'
  ])

  function hide(item: HostedView): void {
    // 先告诉文档「我要隐藏了」：视图 detach 后页面仍报告 visible，不主动通知的话
    // 里面的动画和定时器会一直跑（实测隐藏时仍有 1 个 24h 动画 + 15s 轮询）。
    if (item.view.getVisible()) send(item.view.webContents, { type: 'overlay-hidden' })
    item.bounds = undefined
    item.text = undefined
    item.kind = undefined
    item.quick = undefined
    shownKind = undefined
    shownQuick = undefined
    item.view.setVisible(false)
    if (!window.isDestroyed()) window.contentView.removeChildView(item.view)
  }

  function close(kind: FlyoutKind, restoreFocus: boolean): boolean {
    const item = flyout
    if (!item?.bounds || item.kind !== kind) return false
    hide(item)
    if (restoreFocus && !window.isDestroyed() && window.isFocused() && !shell.isDestroyed()) shell.focus()
    send(shell, kind === 'panel'
      ? { type: 'panel-closed', restoreFocus }
      : { type: 'quick-closed', restoreFocus })
    return true
  }

  function closePanel(restoreFocus: boolean): boolean {
    return close('panel', restoreFocus)
  }

  function closeQuick(restoreFocus: boolean): boolean {
    return close('quick', restoreFocus)
  }

  function dismissToast(): boolean {
    if (flyout?.kind !== 'toast' || !flyout.bounds) return false
    hide(flyout)
    send(shell, { type: 'toast-closed' })
    return true
  }

  /** Esc 关最先打开的那个浮层（飞窗优先于引擎面板，与视觉层级一致）。 */
  function escape(input: Input): boolean {
    if (input.type !== 'keyDown' || input.key !== 'Escape') return false
    if (closeQuick(true)) return true
    return closePanel(true)
  }

  function onPageInput(event: Event, input: Input): void {
    if (escape(input)) event.preventDefault()
  }

  function onPageMouse(_event: Event, input: MouseInputEvent): void {
    if (input.type !== 'mouseDown') return
    closePanel(false)
    closeQuick(false)
  }

  /**
   * 飞窗视图四周那一圈**透明投影边距**里的鼠标，转发给当前页面。
   *
   * 为什么需要：视图是矩形，命中区不跟卡片走（Electron 的 `View.setBorderRadius` 官方注释也写
   * "the cutout still captures clicks"）。边距是给投影留的，若直接吞掉事件，用户点面板旁边的
   * 链接就会"没反应"——2026-11-26 的评估里这条被明确否掉了，所以这里补上转发。
   *
   * 只转发 `mouseDown` / `mouseMove`：`mouseDown` 之后飞窗会被收起，紧随其后的 `mouseUp`
   * 由系统直接投递给下面的页面视图，再补一次会变成两次抬起。
   */
  function forwardGutterMouse(item: HostedView, input: MouseInputEvent): boolean {
    if (!item.bounds || item.kind === 'toast') return false
    if (input.type !== 'mouseDown' && input.type !== 'mouseMove') return false
    if (item.kind !== undefined && insideCard(item.bounds, input.x, input.y)) return false
    const frame = pageFrame()
    if (!frame || frame.contents.isDestroyed()) return false
    const x = Math.round(item.bounds.x + input.x - frame.bounds.x)
    const y = Math.round(item.bounds.y + input.y - frame.bounds.y)
    if (x < 0 || y < 0 || x >= frame.bounds.width || y >= frame.bounds.height) return false
    frame.contents.sendInputEvent({
      type: input.type,
      x,
      y,
      button: input.button,
      clickCount: input.clickCount,
      modifiers: input.modifiers
    })
    return true
  }

  /** 飞窗收到鼠标：落在卡片外就把事件转发给页面（点外部仍然收起飞窗）。 */
  function onFlyoutMouse(input: MouseInputEvent): void {
    const item = flyout
    if (!item?.bounds || !item.kind) return
    if (insideCard(item.bounds, input.x, input.y)) return
    forwardGutterMouse(item, input)
    if (input.type === 'mouseDown') close(item.kind === 'toast' ? 'quick' : item.kind, false)
  }

  function setActivePage(contents: WebContents | undefined): void {
    if (activePage !== contents) {
      activePage?.off('before-input-event', onPageInput)
      activePage?.off('before-mouse-event', onPageMouse)
      activePage = contents
      // Run panel Escape before the page's normal full-screen shortcut.
      activePage?.prependListener('before-input-event', onPageInput)
      activePage?.on('before-mouse-event', onPageMouse)
    }
    raise()
  }

  function raise(): void {
    if (flyout?.view.getVisible()) window.contentView.addChildView(flyout.view)
  }

  function sync(kind: OverlayKind): void {
    const item = flyout
    if (!item?.ready || !item.bounds || item.kind !== kind) return
    const [width, height] = window.getContentSize()
    if (width <= 0 || height <= 0) return
    // 面板/飞窗贴着按钮，顶边必须保持；toast 是自由定位，用通用夹取。
    const bounds = kind === 'toast'
      ? clampBounds(item.bounds, width, height)
      : clampBelow(item.bounds, width, height)
    const current = item.view.getBounds()
    if (current.x !== bounds.x || current.y !== bounds.y ||
        current.width !== bounds.width || current.height !== bounds.height) item.view.setBounds(bounds)
    const alreadyVisible = item.view.getVisible()
    // 飞窗的内容页（快捷设置 / 收藏夹）与 kind 一样算「内容」：视图已经可见时换页，
    // 必须补发一条 open 事件，否则文档不知道自己该画哪一页（视图亮着、内容还是旧的）。
    const nextQuick = kind === 'quick' ? (item.quick ?? 'settings') : undefined
    // 只有「刚显示」或「内容种类/内容页变了」才通知渲染层。
    // 之前每次 sync() 都重发 `*-opened`（例如每次 resize-quick 之后），渲染层收到就重新挂载/重测，
    // 于是「测量 → resize → sync → 再测量」变成正反馈：实测每 500 ms 约 4100 次 report-ready +
    // 6600 次 resize-quick（≈2.2 万次/秒），主进程被拖到单次定时器延迟上百毫秒甚至数秒。
    const reopened = alreadyVisible && (item.kind !== shownKind ||
      (kind === 'quick' && nextQuick !== shownQuick))
    if (!alreadyVisible) {
      item.view.setVisible(true)
      raise()
      if (pendingOpen) markVisible(pendingOpen)
    } else if (reopened) {
      // 视图已经可见但内容换了（toast ↔ 面板/飞窗，或飞窗换页）：仍要通知渲染层切换并交接焦点，
      // 否则会看到「视图亮着、内容不对、Esc 关不掉」。
      if (pendingOpen) markVisible(pendingOpen)
    }
    shownKind = kind
    shownQuick = nextQuick
    if (kind !== 'toast' && (!alreadyVisible || reopened)) {
      // 后台窗口不抢前台（与 browser-window 的 focusContents 同一合同）：
      // 自动化或窗口被盖住时，打开飞窗不应该把窗口拉到前台。
      if (window.isFocused()) item.view.webContents.focus()
      // 打开时把当前主题一起带上：叠加层是常驻文档，只靠推送会因为「文档还没订阅」而漏。
      const theme = currentTheme()
      send(item.view.webContents, kind === 'panel'
        ? { type: 'panel-opened', theme }
        : { type: 'quick-opened', theme, view: nextQuick ?? 'settings' })
    }
  }

  /**
   * 释放预热出来的叠加层文档，回到「用到才建」。
   *
   * 用户在设置里关掉预热时要立刻生效，否则已经建好的那份文档会一直留到关窗。
   * 这正是当年 `auto` 档那台空闲回收定时器想解决的问题——现在只有开/关两个状态，
   * 一次显式调用就够，不用再养计时器（连同"策略在排队期间变了"那类竞态）。
   */
  function releaseOverlay(): void {
    if (!flyout) return
    // 正在显示的先按正常路径关闭（会通知外壳），再销毁视图，避免「界面没了但外壳以为还开着」。
    if (flyout.kind === 'toast') dismissToast()
    else if (flyout.kind) close(flyout.kind, false)
    if (!flyout.view.webContents.isDestroyed()) flyout.view.webContents.close()
    flyout = undefined
  }

  /** 只有一个叠加层视图：panel / quick / toast 共用（见文件头说明）。 */
  function host(): HostedView | undefined {
    if (flyout) return flyout
    // 共享模式：视图只由 adoptShared() 接管产生，绝不自己建（否则会退回独立进程）。
    return shared() ? undefined : createView()
  }

  /**
   * 共享进程模式：接管外壳 `window.open` 出来的 guest，作为唯一的叠加层视图。
   * 它已经有自己的文档/进程，这里不 loadURL、不设 preload。
   */
  function adoptShared(contents: WebContents): boolean {
    if (!shared() || disposed) return false
    const previous = flyout
    flyout = undefined
    if (previous && previous.view.webContents !== contents && !previous.view.webContents.isDestroyed()) {
      previous.view.webContents.close()
    }
    const view = new WebContentsView({ webContents: contents })
    view.setVisible(false)
    view.setBackgroundColor('#00000000')
    const item: HostedView = { view, ready: false }
    flyout = item
    const isCurrent = () => flyout === item && !disposed
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // 准入规则：共享浮层只能是「外壳自己的同源文档」，导航也钉死——否则浮层里一个指向外站的
    // 链接就能把这个文档带到别的源（既是安全面，也会让借来的桥失效）。
    // 注意**不能无条件 preventDefault**：guest 的首次加载本身就是渲染进程发起的导航，
    // 一律拦掉会得到一个永远空白的飞窗（实测 5 个叠加层用例全挂在 30 s 超时）。
    contents.on('will-frame-navigate', (event) => {
      if (event.isSameDocument || isOverlayUrl(event.url)) return
      event.preventDefault()
    })
    contents.on('will-redirect', (event) => {
      if (isOverlayUrl(event.url)) return
      event.preventDefault()
    })
    contents.on('before-input-event', (event, input) => {
      if (escape(input) || handleShortcut(input)) event.preventDefault()
    })
    // 透明投影边距里的鼠标要转给页面，不能凭空吞掉（见 forwardGutterMouse）。
    contents.on('before-mouse-event', (_event, input) => onFlyoutMouse(input))
    contents.on('destroyed', () => {
      if (!isCurrent()) return
      flyout = undefined
      item.ready = false
      item.kind = undefined
      item.bounds = undefined
      shownKind = undefined
    })
    contents.on('render-process-gone', () => {
      if (!isCurrent() || contents.isDestroyed()) return
      flyout = undefined
    })
    const onLoaded = (): void => {
      if (!isCurrent()) return
      item.ready = true
      if (item.kind) sync(item.kind)
    }
    if (contents.isLoading()) contents.once('did-finish-load', onLoaded)
    else onLoaded()
    return true
  }

  /** 这个 URL 是不是我们放行的叠加层文档（共享模式下由外壳 window.open 产生）。 */
  function isOverlayUrl(url: string): boolean {
    if (!shared()) return false
    try {
      if (!sameDocument(url, shellUrl)) return false
      const parsed = new URL(url)
      return parsed.searchParams.getAll(OVERLAY_QUERY).length === 1 &&
        parsed.searchParams.get(OVERLAY_QUERY) === OVERLAY_MODE
    } catch {
      return false
    }
  }

  function createView(): HostedView {
    const url = new URL(shellUrl)
    url.searchParams.set(OVERLAY_QUERY, OVERLAY_MODE)
    const view = new WebContentsView({
      webPreferences: {
        session: getShellSession(),
        preload: join(__dirname, '../preload/index.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        // 叠加层视图常驻且经常隐藏：关掉后台节流，隐藏时也保持可交互的帧状态。
        backgroundThrottling: false
      }
    })
    view.setVisible(false)
    view.setBackgroundColor('#00000000')
    const item: HostedView = { view, ready: false }
    flyout = item

    const isCurrent = () => flyout === item

    function invalidate(): void {
      if (disposed || !isCurrent()) return
      if (item.kind === 'toast') dismissToast()
      else if (item.kind) close(item.kind, false)
      flyout = undefined
      if (!view.webContents.isDestroyed()) view.webContents.close()
    }

    const contents = view.webContents
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-frame-navigate', (event) => event.preventDefault())
    contents.on('will-redirect', (event) => event.preventDefault())
    contents.on('before-input-event', (event, input) => {
      if (escape(input) || handleShortcut(input)) event.preventDefault()
    })
    // 透明投影边距里的鼠标要转给页面，不能凭空吞掉（见 forwardGutterMouse）。
    contents.on('before-mouse-event', (_event, input) => onFlyoutMouse(input))
    contents.on('render-process-gone', invalidate)
    contents.on('destroyed', invalidate)
    contents.on('did-finish-load', () => {
      if (disposed || !isCurrent()) return
      item.ready = true
      if (item.kind === 'toast' && item.text) send(contents, { type: 'toast', text: item.text })
      if (item.kind) sync(item.kind)
    })
    void contents.loadURL(url.href).catch(invalidate)
    return item
  }

  /** 打开（或换内容并重新定位）叠加层。panel / quick / toast 用同一个视图。 */
  function showOverlay(kind: OverlayKind, bounds: OverlayBounds, quick?: QuickView): boolean {
    // 度量：记录点击那一刻视图处于哪种状态（cold / warming / warm）。
    const state = flyout ? (flyout.ready ? 'warm' : 'warming') : 'cold'
    pendingOpen = beginOpen(kind, state)
    // toast 与飞窗互斥：先按正常路径关掉当前那种（会通知外壳），再切内容。
    if (flyout?.kind && flyout.kind !== kind && flyout.kind !== 'toast') close(flyout.kind, false)
    const item = host()
    if (!item) return false
    item.kind = kind
    if (quick !== undefined) item.quick = quick
    item.bounds = bounds
    sync(kind)
    return true
  }

  /**
   * 预热闸门：关掉预热、自动化/后台窗口一律不预热。
   *
   * 这是"该不该预热"的**唯一判定**（设置项由主进程读，别让渲染层猜——两边各读一次
   * 就会对不上，`overlay.prewarm=never` 在共享模式下被忽略正是这么来的）。
   */
  function canPrewarmNow(): boolean {
    return canPrewarm() && prewarmPolicy() === 'always'
  }

  /** 预热：独立进程路径自己建隐藏视图；共享模式让外壳 `window.open` 出文档（主进程不建）。 */
  function startPrewarm(): boolean {
    if (!canPrewarmNow()) return false
    if (shared()) {
      sendToShell({ type: 'overlay-prewarm' })
      return true
    }
    host()
    return true
  }

  function command(event: IpcMainInvokeEvent, value: unknown): boolean {
    let role = sender(event)
    if (!role || !isRecord(value)) return false
    // 共享模式：浮层文档经外壳的桥发言，IPC 的 sender 是外壳；
    // 只有"叠加层专属命令"才按当前内容种类认角色，其余仍按外壳处理。
    if (shared() && role === 'shell' && OVERLAY_ONLY_COMMANDS.has(String(value.type))) {
      role = flyout?.kind ?? 'quick'
    }
    switch (value.type) {
      case 'shared-mode':
        return role === 'shell' && shared()
      case 'pull-overlay': {
        // 浮层文档刚挂载、订阅才注册好：把「现在该显示什么」补发一次。
        if (role === 'shell') return false
        if (!flyout?.kind || !flyout.view.getVisible()) return true
        const live = flyout
        if (live.kind === 'toast') send(live.view.webContents, { type: 'toast', text: live.text ?? '' })
        else send(live.view.webContents, live.kind === 'panel'
          ? { type: 'panel-opened', theme: currentTheme() }
          : { type: 'quick-opened', theme: currentTheme(), view: live.quick ?? 'settings' })
        return true
      }
      case 'set-panel': {
        if (role !== 'shell') return false
        if (value.bounds === null) {
          if (flyout?.kind === 'panel') hide(flyout)
          return true
        }
        const bounds = readBounds(value.bounds)
        if (!bounds) return false
        return showOverlay('panel', bounds)
      }
      case 'set-quick': {
        if (role !== 'shell') return false
        // 内容页只认白名单里的两个值：它是渲染层能直接指定的"画哪页"，非法值不能落进状态。
        if (value.view !== undefined && !isQuickView(value.view)) return false
        if (value.bounds === null) {
          if (flyout?.kind === 'quick') hide(flyout)
          return true
        }
        const bounds = readBounds(value.bounds)
        if (!bounds) return false
        return showOverlay('quick', bounds, isQuickView(value.view) ? value.view : undefined)
      }
      /**
       * 飞窗里的「收藏夹」入口：外壳负责锚点（它才知道星标按钮在哪），
       * 所以这里只把请求转给外壳，自己不改变任何状态。
       */
      case 'open-bookmarks': {
        if (role !== 'quick' || flyout?.kind !== 'quick' || !flyout.bounds) return false
        sendToShell({ type: 'bookmarks-requested' })
        return true
      }
      /** 气泡里的「更多」：换到完整编辑器那一页，锚点仍是星标（由外壳重新下发 bounds）。 */
      case 'open-bookmark-editor': {
        if (role !== 'quick' || flyout?.kind !== 'quick' || !flyout.bounds) return false
        sendToShell({ type: 'bookmark-editor-requested' })
        return true
      }
      case 'set-toast': {
        if (role !== 'shell') return false
        if (value.toast === null) {
          if (flyout?.kind === 'toast') hide(flyout)
          return true
        }
        if (!isRecord(value.toast) || !isText(value.toast.text)) return false
        const bounds = readBounds(value.toast.bounds)
        if (!bounds) return false
        const text = value.toast.text
        // 共享模式下视图要等外壳 window.open 之后才被接管：还没有就按失败返回。
        const item = host()
        if (!item) return false
        const updated = item.text !== text
        item.text = text
        if (!showOverlay('toast', bounds)) return false
        if (item.ready && updated) send(item.view.webContents, { type: 'toast', text })
        return true
      }
      case 'resize-panel': {
        if (role !== 'panel' || flyout?.kind !== 'panel' || !flyout.bounds || !isFiniteNumber(value.height) || value.height <= 0) return false
        // 渲染层报的是**卡片**高度：视图还要加一圈投影留白（透明边距）。
        flyout.bounds.height = value.height + OVERLAY_GUTTER_BOTTOM
        sync('panel')
        return true
      }
      case 'resize-quick': {
        if (role !== 'quick' || flyout?.kind !== 'quick' || !flyout.bounds || !isFiniteNumber(value.height) || value.height <= 0) return false
        // 高度没变就别再走一遍 sync()：渲染层按 scrollHeight 上报，1–2 px 的抖动会形成
        // 「设置 bounds → 布局变化 → 再上报」的循环（实测能到每秒上万次）。
        const nextHeight = value.height + OVERLAY_GUTTER_BOTTOM
        if (Math.abs(flyout.bounds.height - nextHeight) < 1) return true
        flyout.bounds.height = nextHeight
        sync('quick')
        return true
      }
      case 'close-panel':
        return role === 'panel' && typeof value.restoreFocus === 'boolean' && closePanel(value.restoreFocus)
      case 'close-quick':
        return role === 'quick' && typeof value.restoreFocus === 'boolean' && closeQuick(value.restoreFocus)
      case 'dismiss-toast':
        return role === 'toast' && dismissToast()
      case 'report-ready': {
        if (role !== 'panel' && role !== 'quick' && role !== 'toast') return false
        if (pendingOpen) markContent(pendingOpen)
        return true
      }
      case 'report-longtask': {
        /**
         * 浮层主线程长任务（ADR-0004 §「把纪律变成门槛」）。
         *
         * 浮层与外壳共享渲染进程主线程：浮层里一次 400 ms 同步任务会让外壳的 IPC 往返从 2 ms
         * 涨到 402 ms（2026-11-25 演示 §7.7-1）。所以这里既落盘（`BAO_OVERLAY_TRACE`）
         * 又按阈值告警——开发期 >50 ms 就该当失败处理。
         */
        if (role !== 'panel' && role !== 'quick' && role !== 'toast') return false
        if (!isFiniteNumber(value.duration) || value.duration <= 0) return false
        const duration = Number(value.duration)
        const source = typeof value.source === 'string' ? value.source.slice(0, 200) : ''
        traceOverlayLongTask(duration, source)
        return true
      }
      case 'report-failure':
        if ((role !== 'panel' && role !== 'quick') || !isText(value.text)) return false
        send(shell, { type: 'failure', text: value.text })
        return true
      default:
        return false
    }
  }

  window.on('blur', () => {
    // 自动化窗口是 `focusable: false`：它不会因为用户操作失焦，但并行跑时会收到伪 blur，
    // 把刚打开的飞窗关掉（theme 用例曾因此 60 秒都找不到叠加层）。
    if (!window.isFocusable()) return
    closePanel(false)
    closeQuick(false)
  })

  return {
    command,
    sender,
    escape,
    setActivePage,
    panelVisible: () => flyout?.kind === 'panel' && flyout.view.getVisible() === true,
    quickVisible: () => flyout?.kind === 'quick' && flyout.view.getVisible() === true,
    /** 度量：读出/清空打开耗时样本（临时接口，决定悬停预热后移除）。 */
    metrics: () => ({ samples: readSamples(), summary: summarize(readSamples()) }),
    resetMetrics: () => {
      resetSamples()
      return true
    },
    /** 预热：提前建好叠加层（首次打开只差一次 setBounds/一次显示），不改变可见性。 */
    prewarm() {
      startPrewarm()
    },
    /** 立即释放预热出来的文档（用户在设置里关掉预热时用）。 */
    release() {
      releaseOverlay()
    },
    layout() {
      if (flyout?.kind) sync(flyout.kind)
    },
    publish(state: BrowserState) {
      const contents = flyout?.view.webContents
      // 共享模式：浮层经外壳的桥订阅，改发给外壳。
      const target = shared() ? shell : contents
      if (target && !target.isDestroyed()) target.send(browserChannels.changed, state)
    },
    /** 共享进程模式：接管外壳 window.open 出来的 guest（proto）。 */
    adoptShared,
    /** 判断某个 URL 是否是放行的叠加层文档（共享模式）。 */
    isOverlayUrl,
    dispose() {
      disposed = true
      activePage?.off('before-input-event', onPageInput)
      activePage?.off('before-mouse-event', onPageMouse)
      activePage = undefined
      if (flyout && !flyout.view.webContents.isDestroyed()) flyout.view.webContents.close()
      flyout = undefined
    }
  }
}

