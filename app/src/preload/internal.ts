import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { settingsChannels } from '../shared/settings'
import type { SettingsBridge, SettingsSnapshot, SettingsWriteResult } from '../shared/settings'
import { ntpChannels } from '../shared/ntp'
import type { NtpBridge, NtpCommandResult, NtpSnapshot } from '../shared/ntp'

/**
 * 内部页（`bao://settings` / `bao://newtab`）的 preload（架构 §3 IPC：页面不获得外壳 IPC 桥）。
 *
 * 两种内部页**共用这一个 preload**：同一个 WebContents 会在两个文档之间就地导航
 * （设置覆盖新标签页），而 preload 是按文档执行的，按 kind 换文件会让就地导航后的文档
 * 拿不到桥。安全边界不在这里，而在主进程：每个通道都按「本窗口标签表 ∧ 主帧 ∧ 文档 URL」
 * 判定发送者，NTP 拿不到设置写权限、设置页拿不到新标签页的导航/设置入口。
 *
 * 这里没有 `baoBrowser`、没有 `baoOverlay`、没有 `baoWindowControl`、没有任意 URL 读写。
 */
const settings: SettingsBridge = {
  read: () => ipcRenderer.invoke(settingsChannels.read),
  write: (key, value) => ipcRenderer.invoke(settingsChannels.write, { key, value }),
  clearSession: () => ipcRenderer.invoke(settingsChannels.sessionClear),
  flashStatus: () => ipcRenderer.invoke(settingsChannels.flashStatus),
  flashImport: () => ipcRenderer.invoke(settingsChannels.flashImport),
  flashReveal: () => ipcRenderer.invoke(settingsChannels.flashReveal),
  subscribe(listener) {
    const relay = (_event: IpcRendererEvent, snapshot: SettingsSnapshot) => listener(snapshot)
    ipcRenderer.on(settingsChannels.changed, relay)
    return () => ipcRenderer.removeListener(settingsChannels.changed, relay)
  }
}

const ntp: NtpBridge = {
  read: () => ipcRenderer.invoke(ntpChannels.read),
  run: (command) => ipcRenderer.invoke(ntpChannels.command, command),
  subscribe(listener) {
    const relay = (_event: IpcRendererEvent, snapshot: NtpSnapshot) => listener(snapshot)
    ipcRenderer.on(ntpChannels.changed, relay)
    return () => ipcRenderer.removeListener(ntpChannels.changed, relay)
  }
}

contextBridge.exposeInMainWorld('baoSettings', settings)
contextBridge.exposeInMainWorld('baoNtp', ntp)

// 便于测试断言"内部页拿不到外壳桥"：这里不导出任何其它东西。
export type { NtpCommandResult, SettingsWriteResult }
