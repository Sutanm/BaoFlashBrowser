import { WebContentsView } from 'electron'
import type { BrowserWindow, Event, Input, IpcMainInvokeEvent, MouseInputEvent, WebContents } from 'electron'
import { join } from 'node:path'
import { browserChannels } from '../shared/browser'
import type { BrowserState } from '../shared/browser'
import { OVERLAY_QUERY, overlayChannels } from '../shared/overlay'
import { clampBelow, clampBounds } from '../shared/overlay-geometry'
import type { OverlayBounds, OverlayEvent, OverlayKind } from '../shared/overlay'
import { beginOpen, markContent, markVisible, readSamples, resetSamples, summarize } from './overlay-metrics'
import { getShellSession } from './sessions'

interface HostedView {
  view: WebContentsView
  bounds?: OverlayBounds
  ready: boolean
  text?: string
  /** 共用视图当前在显示哪一种内容（同一个文档按事件切换组件）。 */
  kind?: OverlayKind
}

const FLYOUT_KINDS = ['panel', 'quick'] as const
type FlyoutKind = (typeof FLYOUT_KINDS)[number]

/**
 * 叠加层只保留**两个**视图：一个飞窗视图（panel 与 quick 共用）+ 一个 toast 视图。
 *
 * 为什么合并：每多一个 WebContentsView 就多一个渲染进程（建进程 30–90 ms），
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

/** Native sibling views cover the active page without changing its layout. */
export function createShellOverlays(
  window: BrowserWindow,
  shellUrl: string,
  sameDocument: (actual: string, expected: string) => boolean,
  handleShortcut: (input: Input) => boolean,
  currentTheme: () => 'light' | 'dark',
  /** 自动化模式下不预热：多出来的视图会干扰「页面视图计数」类断言。 */
  canPrewarm: () => boolean
) {
  const shell = window.webContents
  let flyout: HostedView | undefined
  let activePage: WebContents | undefined
  let pendingOpen = 0
  let retireTimer: ReturnType<typeof setTimeout> | undefined
  /** 空闲回收：预热的视图在 5 分钟没有打开就释放（用户可在设置里选「常驻」关掉回收）。 */
  // 默认 5 分钟；BAO_RETIRE_MS 仅供测试/度量缩短短语。
  const RETIRE_AFTER_MS = Number(process.env.BAO_RETIRE_MS ?? 5 * 60_000)
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
    if (!contents.isDestroyed()) contents.send(overlayChannels.event, message)
  }

  function hide(item: HostedView): void {
    // 先告诉文档「我要隐藏了」：视图 detach 后页面仍报告 visible，不主动通知的话
    // 里面的动画和定时器会一直跑（实测隐藏时仍有 1 个 24h 动画 + 15s 轮询）。
    if (item.view.getVisible()) send(item.view.webContents, { type: 'overlay-hidden' })
    item.bounds = undefined
    item.text = undefined
    item.kind = undefined
    item.view.setVisible(false)
    if (!window.isDestroyed()) window.contentView.removeChildView(item.view)
    armRetire()
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
    if (item.view.getVisible()) return
    item.view.setVisible(true)
    raise()
    if (pendingOpen) markVisible(pendingOpen)
    if (kind !== 'toast') {
      // 后台窗口不抢前台（与 browser-window 的 focusContents 同一合同）：
      // 自动化或窗口被盖住时，打开飞窗不应该把窗口拉到前台。
      if (window.isFocused()) item.view.webContents.focus()
      // 打开时把当前主题一起带上：叠加层是常驻文档，只靠推送会因为「文档还没订阅」而漏。
      const theme = currentTheme()
      send(item.view.webContents, kind === 'panel'
        ? { type: 'panel-opened', theme }
        : { type: 'quick-opened', theme })
    }
  }

  function cancelRetire(): void {
    if (retireTimer) {
      clearTimeout(retireTimer)
      retireTimer = undefined
    }
  }

  function armRetire(): void {
    cancelRetire()
    retireTimer = setTimeout(() => {
      retireTimer = undefined
      if (flyout?.view.getVisible()) return
      if (flyout && !flyout.view.webContents.isDestroyed()) flyout.view.webContents.close()
      flyout = undefined
    }, RETIRE_AFTER_MS)
  }

  function retireNow(): void {
    cancelRetire()
    if (!flyout) return
    if (flyout.kind) hide(flyout)
    if (!flyout.view.webContents.isDestroyed()) flyout.view.webContents.close()
    flyout = undefined
  }

  /** 只有一个叠加层视图：panel / quick / toast 共用（见文件头说明）。 */
  function host(): HostedView {
    if (flyout) return flyout
    return createView()
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
  function showOverlay(kind: OverlayKind, bounds: OverlayBounds): void {
    // 度量：记录点击那一刻视图处于哪种状态（cold / warming / warm）。
    const state = flyout ? (flyout.ready ? 'warm' : 'warming') : 'cold'
    pendingOpen = beginOpen(kind, state)
    // toast 与飞窗互斥：先按正常路径关掉当前那种（会通知外壳），再切内容。
    cancelRetire()
    if (flyout?.kind && flyout.kind !== kind && flyout.kind !== 'toast') close(flyout.kind, false)
    const item = host()
    item.kind = kind
    item.bounds = bounds
    sync(kind)
  }

  function command(event: IpcMainInvokeEvent, value: unknown): boolean {
    const role = sender(event)
    if (!role || !isRecord(value)) return false
    switch (value.type) {
      case 'set-panel': {
        if (role !== 'shell') return false
        if (value.bounds === null) {
          if (flyout?.kind === 'panel') hide(flyout)
          return true
        }
        const bounds = readBounds(value.bounds)
        if (!bounds) return false
        showOverlay('panel', bounds)
        return true
      }
      case 'set-quick': {
        if (role !== 'shell') return false
        if (value.bounds === null) {
          if (flyout?.kind === 'quick') hide(flyout)
          return true
        }
        const bounds = readBounds(value.bounds)
        if (!bounds) return false
        showOverlay('quick', bounds)
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
        const item = host()
        const updated = item.text !== text
        item.text = text
        showOverlay('toast', bounds)
        if (item.ready && updated) send(item.view.webContents, { type: 'toast', text })
        return true
      }
      case 'resize-panel': {
        if (role !== 'panel' || flyout?.kind !== 'panel' || !flyout.bounds || !isFiniteNumber(value.height) || value.height <= 0) return false
        flyout.bounds.height = value.height
        sync('panel')
        return true
      }
      case 'resize-quick': {
        if (role !== 'quick' || flyout?.kind !== 'quick' || !flyout.bounds || !isFiniteNumber(value.height) || value.height <= 0) return false
        flyout.bounds.height = value.height
        sync('quick')
        return true
      }
      case 'close-panel':
        return role === 'panel' && typeof value.restoreFocus === 'boolean' && closePanel(value.restoreFocus)
      case 'close-quick':
        return role === 'quick' && typeof value.restoreFocus === 'boolean' && closeQuick(value.restoreFocus)
      case 'dismiss-toast':
        return role === 'toast' && dismissToast()
      case 'prewarm': {
        if (role !== 'shell' || !canPrewarm()) return false
        host()
        armRetire()
        return true
      }
      case 'report-ready': {
        if (role !== 'panel' && role !== 'quick' && role !== 'toast') return false
        if (pendingOpen) markContent(pendingOpen)
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
    /** 预热：提前建好隐藏的叠加层视图（首次打开只差一次 setBounds），不改变可见性。 */
    prewarm() {
      host()
      armRetire()
    },
    /** 立即释放叠加层视图（设置切到「不预热」时用）。 */
    retire() {
      retireNow()
    },
    layout() {
      if (flyout?.kind) sync(flyout.kind)
    },
    publish(state: BrowserState) {
      const contents = flyout?.view.webContents
      if (contents && !contents.isDestroyed()) contents.send(browserChannels.changed, state)
    },
    dispose() {
      disposed = true
      activePage?.off('before-input-event', onPageInput)
      activePage?.off('before-mouse-event', onPageMouse)
      activePage = undefined
      if (flyout && !flyout.view.webContents.isDestroyed()) flyout.view.webContents.close()
      flyout = undefined
      cancelRetire()
    }
  }
}
