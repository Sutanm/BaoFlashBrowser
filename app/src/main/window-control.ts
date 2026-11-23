import { BrowserWindow, ipcMain } from 'electron'

/**
 * 外壳窗口控制（架构 A5：窗口 chrome 自绘）。
 *
 * 主窗口用 `titleBarStyle: 'hidden'` + `titleBarOverlay`：系统画最小化/最大化/关闭三个按钮
 * （配色来自 `windowPalette`），我们不重复画按钮。但**双击标题栏最大化**是标题栏的常规语义，
 * 而 `-webkit-app-region: drag` 的这块区域在自动化里无法可靠验证，所以在渲染层显式处理，
 * 由主进程执行。
 */
type WindowAction = 'toggle-maximize' | 'minimize' | 'close'

export function registerWindowControlIpc(): void {
  ipcMain.handle('bao:window-control', (event, action: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || window.isDestroyed()) return false
    switch (action as WindowAction) {
      case 'toggle-maximize':
        if (window.isMaximized()) window.unmaximize()
        else window.maximize()
        return true
      case 'minimize':
        window.minimize()
        return true
      case 'close':
        window.close()
        return true
      default:
        return false
    }
  })
}
