import { WebContentsView } from 'electron'
import type { BrowserWindow, Event, Input, IpcMainInvokeEvent, MouseInputEvent, WebContents } from 'electron'
import { join } from 'node:path'
import { browserChannels } from '../shared/browser'
import type { BrowserState } from '../shared/browser'
import { OVERLAY_QUERY, overlayChannels } from '../shared/overlay'
import type { OverlayBounds, OverlayEvent, OverlayKind } from '../shared/overlay'
import { getShellSession } from './sessions'

interface HostedView {
  view: WebContentsView
  bounds?: OverlayBounds
  ready: boolean
  text?: string
}

const KINDS = ['panel', 'toast'] as const

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

function clampBounds(bounds: OverlayBounds, width: number, height: number): OverlayBounds {
  const w = Math.min(width, Math.ceil(bounds.width))
  const h = Math.min(height, Math.ceil(bounds.height))
  return {
    x: Math.max(0, Math.min(width - w, Math.round(bounds.x))),
    y: Math.max(0, Math.min(height - h, Math.round(bounds.y))),
    width: w,
    height: h
  }
}

/** Native sibling views cover the active page without changing its layout. */
export function createShellOverlays(
  window: BrowserWindow,
  shellUrl: string,
  sameDocument: (actual: string, expected: string) => boolean,
  handleShortcut: (input: Input) => boolean
) {
  const shell = window.webContents
  const hosted: Partial<Record<OverlayKind, HostedView>> = {}
  let activePage: WebContents | undefined
  let disposed = false

  function sender(event: IpcMainInvokeEvent): 'shell' | OverlayKind | undefined {
    if (disposed) return
    const frame = event.senderFrame
    if (!frame || frame !== event.sender.mainFrame || !sameDocument(frame.url, shellUrl)) return
    const modes = new URL(frame.url).searchParams.getAll(OVERLAY_QUERY)
    if (event.sender === shell) return modes.length === 0 ? 'shell' : undefined
    const mode = modes.length === 1 ? modes[0] : undefined
    if ((mode === 'panel' || mode === 'toast') && event.sender === hosted[mode]?.view.webContents) return mode
  }

  function send(contents: WebContents, message: OverlayEvent): void {
    if (!contents.isDestroyed()) contents.send(overlayChannels.event, message)
  }

  function hide(item: HostedView): void {
    item.bounds = undefined
    item.text = undefined
    item.view.setVisible(false)
    if (!window.isDestroyed()) window.contentView.removeChildView(item.view)
  }

  function closePanel(restoreFocus: boolean): boolean {
    const panel = hosted.panel
    if (!panel?.bounds) return false
    hide(panel)
    if (restoreFocus && !shell.isDestroyed()) shell.focus()
    send(shell, { type: 'panel-closed', restoreFocus })
    return true
  }

  function dismissToast(): boolean {
    const toast = hosted.toast
    if (!toast?.bounds) return false
    hide(toast)
    send(shell, { type: 'toast-closed' })
    return true
  }

  function escape(input: Input): boolean {
    return input.type === 'keyDown' && input.key === 'Escape' && closePanel(true)
  }

  function onPageInput(event: Event, input: Input): void {
    if (escape(input)) event.preventDefault()
  }

  function onPageMouse(_event: Event, input: MouseInputEvent): void {
    if (input.type === 'mouseDown') closePanel(false)
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
    for (const kind of KINDS) {
      const item = hosted[kind]
      if (item?.view.getVisible()) window.contentView.addChildView(item.view)
    }
  }

  function sync(kind: OverlayKind): void {
    const item = hosted[kind]
    if (!item?.ready || !item.bounds) return
    const [width, height] = window.getContentSize()
    if (width <= 0 || height <= 0) return
    const bounds = clampBounds(item.bounds, width, height)
    const current = item.view.getBounds()
    if (current.x !== bounds.x || current.y !== bounds.y ||
        current.width !== bounds.width || current.height !== bounds.height) item.view.setBounds(bounds)
    if (item.view.getVisible()) return
    item.view.setVisible(true)
    raise()
    if (kind === 'panel') {
      item.view.webContents.focus()
      send(item.view.webContents, { type: 'panel-opened' })
    }
  }

  function ensure(kind: OverlayKind): HostedView {
    const existing = hosted[kind]
    if (existing) return existing
    const url = new URL(shellUrl)
    url.searchParams.set(OVERLAY_QUERY, kind)
    const view = new WebContentsView({
      webPreferences: {
        session: getShellSession(),
        preload: join(__dirname, '../preload/index.js'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true
      }
    })
    view.setVisible(false)
    view.setBackgroundColor('#00000000')
    const item: HostedView = { view, ready: false }
    hosted[kind] = item

    function invalidate(): void {
      if (disposed || hosted[kind] !== item) return
      if (kind === 'panel') closePanel(false)
      else dismissToast()
      delete hosted[kind]
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
      if (disposed || hosted[kind] !== item) return
      item.ready = true
      if (kind === 'toast' && item.text) send(contents, { type: 'toast', text: item.text })
      sync(kind)
    })
    void contents.loadURL(url.href).catch(invalidate)
    return item
  }

  function command(event: IpcMainInvokeEvent, value: unknown): boolean {
    const role = sender(event)
    if (!role || !isRecord(value)) return false
    switch (value.type) {
      case 'set-panel': {
        if (role !== 'shell') return false
        if (value.bounds === null) {
          if (hosted.panel) hide(hosted.panel)
          return true
        }
        const bounds = readBounds(value.bounds)
        if (!bounds) return false
        ensure('panel').bounds = bounds
        sync('panel')
        return true
      }
      case 'set-toast': {
        if (role !== 'shell') return false
        if (value.toast === null) {
          if (hosted.toast) hide(hosted.toast)
          return true
        }
        if (!isRecord(value.toast) || !isText(value.toast.text)) return false
        const bounds = readBounds(value.toast.bounds)
        if (!bounds) return false
        const toast = ensure('toast')
        toast.bounds = bounds
        const updated = toast.text !== value.toast.text
        toast.text = value.toast.text
        if (toast.ready && updated) send(toast.view.webContents, { type: 'toast', text: toast.text })
        sync('toast')
        return true
      }
      case 'resize-panel': {
        const panel = hosted.panel
        if (role !== 'panel' || !panel?.bounds || !isFiniteNumber(value.height) || value.height <= 0) return false
        panel.bounds.height = value.height
        sync('panel')
        return true
      }
      case 'close-panel':
        return role === 'panel' && typeof value.restoreFocus === 'boolean' && closePanel(value.restoreFocus)
      case 'dismiss-toast':
        return role === 'toast' && dismissToast()
      case 'report-failure':
        if (role !== 'panel' || !isText(value.text)) return false
        send(shell, { type: 'failure', text: value.text })
        return true
      default:
        return false
    }
  }

  window.on('blur', () => closePanel(false))

  return {
    command,
    sender,
    escape,
    setActivePage,
    panelVisible: () => hosted.panel?.view.getVisible() === true,
    layout() {
      for (const kind of KINDS) sync(kind)
    },
    publish(state: BrowserState) {
      for (const kind of KINDS) {
        const contents = hosted[kind]?.view.webContents
        if (contents && !contents.isDestroyed()) contents.send(browserChannels.changed, state)
      }
    },
    dispose() {
      disposed = true
      activePage?.off('before-input-event', onPageInput)
      activePage?.off('before-mouse-event', onPageMouse)
      activePage = undefined
      for (const kind of KINDS) {
        const item = hosted[kind]
        delete hosted[kind]
        if (item && !item.view.webContents.isDestroyed()) item.view.webContents.close()
      }
    }
  }
}
