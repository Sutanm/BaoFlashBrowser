import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { settingsChannels } from '../shared/settings'
import type { SettingsBridge, SettingsSnapshot, SettingsWriteResult } from '../shared/settings'

/**
 * 内部设置页的 preload（架构 §3 IPC：页面不获得外壳 IPC 桥）。
 *
 * 这里**只**暴露两个动词 + 一个订阅：没有 `baoBrowser`、没有 `baoOverlay`、
 * 没有 `baoWindowControl`、没有任意 URL 读写。主进程侧还会按「本窗口标签表 ∧ 主帧 ∧
 * 文档 URL ∈ bao://settings/*」再验证一次发送者。
 */
const bridge: SettingsBridge = {
  read: () => ipcRenderer.invoke(settingsChannels.read),
  write: (key, value) => ipcRenderer.invoke(settingsChannels.write, { key, value }),
  subscribe(listener) {
    const relay = (_event: IpcRendererEvent, snapshot: SettingsSnapshot) => listener(snapshot)
    ipcRenderer.on(settingsChannels.changed, relay)
    return () => ipcRenderer.removeListener(settingsChannels.changed, relay)
  }
}

contextBridge.exposeInMainWorld('baoSettings', bridge)

// 便于测试断言"内部页拿不到外壳桥"：这里不导出任何其它东西。
export type { SettingsWriteResult }
