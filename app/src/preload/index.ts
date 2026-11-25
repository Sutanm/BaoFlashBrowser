import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { browserChannels } from '../shared/browser'
import type { BrowserBridge, BrowserState } from '../shared/browser'
import { overlayChannels } from '../shared/overlay'
import type { OverlayBridge, OverlayCommand, OverlayEvent } from '../shared/overlay'
import type { RuntimeVersions } from '../shared/runtime'

const versions: RuntimeVersions = {
  electron: process.versions.electron,
  chromium: process.versions.chrome
}

// 窗口 chrome（A5）：系统画按钮，双击标题栏最大化由我们显式转发。
const windowControl = {
  toggleMaximize: () => ipcRenderer.invoke('bao:window-control', 'toggle-maximize')
}

const browser: BrowserBridge = {
  run: (command) => ipcRenderer.invoke(browserChannels.command, command),
  subscribe(listener) {
    const relay = (_event: IpcRendererEvent, state: BrowserState) => listener(state)
    ipcRenderer.on(browserChannels.changed, relay)
    return () => ipcRenderer.removeListener(browserChannels.changed, relay)
  }
}

function runOverlay(command: OverlayCommand): Promise<boolean> {
  return ipcRenderer.invoke(overlayChannels.command, command)
}

// A first-load toast or panel-opened event may arrive before the UI subscribes.
const overlayListeners = new Set<(event: OverlayEvent) => void>()
let pendingOverlayEvent: OverlayEvent | undefined
ipcRenderer.on(overlayChannels.event, (_event: IpcRendererEvent, message: OverlayEvent) => {
  if (overlayListeners.size === 0 &&
      (message.type === 'toast' || message.type === 'panel-opened' || message.type === 'overlay-prewarm')) {
    pendingOverlayEvent = message
  }
  for (const listener of overlayListeners) listener(message)
})

const overlay: OverlayBridge = {
  setPanel: (bounds) => runOverlay({ type: 'set-panel', bounds }),
  setToast: (toast) => runOverlay({ type: 'set-toast', toast }),
  resizePanel: (height) => runOverlay({ type: 'resize-panel', height }),
  closePanel: (restoreFocus = true) => runOverlay({ type: 'close-panel', restoreFocus }),
  setQuick: (bounds) => runOverlay({ type: 'set-quick', bounds }),
  resizeQuick: (height) => runOverlay({ type: 'resize-quick', height }),
  closeQuick: (restoreFocus = true) => runOverlay({ type: 'close-quick', restoreFocus }),
  dismissToast: () => runOverlay({ type: 'dismiss-toast' }),
  reportFailure: (text) => runOverlay({ type: 'report-failure', text }),
  reportReady: () => runOverlay({ type: 'report-ready' }),
  canPrewarm: () => runOverlay({ type: 'can-prewarm' }),
  prewarm: () => runOverlay({ type: 'prewarm' }),
  sharedMode: () => runOverlay({ type: 'shared-mode' }),
  pullOverlay: () => runOverlay({ type: 'pull-overlay' }),
  readMetrics: () => ipcRenderer.invoke(overlayChannels.metrics),
  resetMetrics: () => ipcRenderer.invoke(overlayChannels.metricsReset),
  subscribe(listener) {
    overlayListeners.add(listener)
    const pending = pendingOverlayEvent
    pendingOverlayEvent = undefined
    if (pending) listener(pending)
    return () => { overlayListeners.delete(listener) }
  }
}

contextBridge.exposeInMainWorld('baoRuntime', versions)
contextBridge.exposeInMainWorld('baoWindowControl', windowControl)
contextBridge.exposeInMainWorld('baoBrowser', browser)
contextBridge.exposeInMainWorld('baoOverlay', overlay)
