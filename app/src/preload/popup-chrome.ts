import { contextBridge, ipcRenderer } from 'electron'

/**
 * 弹窗 chrome 条的 preload（架构 A5 界面归一化：不用原生窗口 chrome）。
 *
 * 控制条包含拖动抓手、最小化和关闭。
 * 只暴露两个动作，且主进程按「发送者是否该 chrome 视图」校验。
 */
contextBridge.exposeInMainWorld('baoPopupChrome', {
  minimize: () => ipcRenderer.invoke('bao:popup-chrome', 'minimize'),
  close: () => ipcRenderer.invoke('bao:popup-chrome', 'close')
})
