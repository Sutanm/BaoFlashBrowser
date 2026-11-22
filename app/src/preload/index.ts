import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { browserChannels } from '../shared/browser'
import type { BrowserBridge, BrowserState } from '../shared/browser'
import type { RuntimeVersions } from '../shared/runtime'

const versions: RuntimeVersions = {
  electron: process.versions.electron,
  chromium: process.versions.chrome
}

const browser: BrowserBridge = {
  run: (command) => ipcRenderer.invoke(browserChannels.command, command),
  subscribe(listener) {
    const relay = (_event: IpcRendererEvent, state: BrowserState) => listener(state)
    ipcRenderer.on(browserChannels.changed, relay)
    return () => ipcRenderer.removeListener(browserChannels.changed, relay)
  }
}

contextBridge.exposeInMainWorld('baoRuntime', versions)
contextBridge.exposeInMainWorld('baoBrowser', browser)
