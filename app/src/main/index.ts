import { app, BrowserWindow, Menu } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBrowserWindow, registerBrowserIpc } from './browser-window'
import { configureFlashPlugin } from './plugins'
import { registerRuffleIpc, registerRuffleScheme } from './ruffle'

app.setName('BaoFlashBrowser Next')

// 浏览器外壳不挂 Electron 默认应用菜单：否则 Ctrl+W / Ctrl+R 等快捷键会被
// 默认菜单的 accelerator 抢走，标签级快捷键无法生效（架构 §3 商标交互沿用 Chrome 式目标）。
Menu.setApplicationMenu(null)

// 自定义 scheme 必须在 ready 之前登记（架构 §3 引擎：Ruffle 本地资源）。
registerRuffleScheme()

// 内核插件注册必须在 ready 之前写入命令行（架构 §3 引擎）。
const flash = configureFlashPlugin()
registerBrowserIpc()
registerRuffleIpc()

function shellDocument(): string {
  const devUrl = !app.isPackaged && process.env.ELECTRON_RENDERER_URL
  return devUrl ? new URL(devUrl).href : pathToFileURL(join(__dirname, '../renderer/index.html')).href
}

async function openShellWindow(): Promise<void> {
  await createBrowserWindow({ shellUrl: shellDocument(), flash: flash.enabled })
}

app.whenReady().then(openShellWindow).catch((error: unknown) => {
  console.error('浏览器外壳启动失败。', error)
  app.exit(1)
})

/**
 * 新建窗口请求。当前默认生命周期仍是单窗口，此事件留给多窗口入口与真实产物冒烟：
 * 冒烟需要验证窗口销毁后旧事件不会污染新建窗口（架构 §3、§6）。
 */
const appEvents = app as unknown as { on(event: string, listener: () => void): void }
appEvents.on('bao-next:open-window', () => {
  void openShellWindow().catch((error: unknown) => console.error('新建窗口失败。', error))
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void openShellWindow().catch((error: unknown) => console.error('新建窗口失败。', error))
  }
})

app.on('window-all-closed', () => app.quit())
