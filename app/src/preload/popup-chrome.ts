import { contextBridge, ipcRenderer } from 'electron'

/**
 * 弹窗 chrome 条的 preload（架构 A5 界面归一化：不用原生窗口 chrome）。
 *
 * 这条 32px 的条由我们自绘：不可见的拖动带 + 最小化/关闭两个按钮。
 * 只暴露两个动作，且主进程按「发送者是否该 chrome 视图」校验。
 */
contextBridge.exposeInMainWorld('baoPopupChrome', {
  minimize: () => ipcRenderer.invoke('bao:popup-chrome', 'minimize'),
  close: () => ipcRenderer.invoke('bao:popup-chrome', 'close')
})
