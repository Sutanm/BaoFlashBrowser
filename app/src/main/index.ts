import { app, BrowserWindow, Menu, protocol } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBrowserWindow, registerBrowserIpc } from './browser-window'
import { configureFlashPlugin } from './plugins'
import { ruffleSchemePrivileges, registerRuffleIpc } from './ruffle'
import { registerPopupChromeIpc } from './popup-chrome'
import { registerWindowControlIpc } from './window-control'
import { registerNetBroker } from './net-broker'
import { internalSchemePrivileges } from './internal-pages'
import { closeStorage, initStorage } from './storage'

app.setName('BaoFlashBrowser Next')

// 浏览器外壳不挂 Electron 默认应用菜单：否则 Ctrl+W / Ctrl+R 等快捷键会被
// 默认菜单的 accelerator 抢走，标签级快捷键无法生效（架构 §3 商标交互沿用 Chrome 式目标）。
Menu.setApplicationMenu(null)

// 自定义 scheme 必须在 ready 之前登记，而且**只能调用一次**（多次调用会覆盖而不是追加）。
// Ruffle 的资源协议与内部页 `bao://settings` 因此合并成一次登记。
protocol.registerSchemesAsPrivileged([...ruffleSchemePrivileges(), ...internalSchemePrivileges()])

// 内核插件注册必须在 ready 之前写入命令行（架构 §3 引擎）。
const flash = configureFlashPlugin()
registerBrowserIpc()
registerRuffleIpc()
registerPopupChromeIpc()
registerWindowControlIpc()
// 引擎网络 broker：按 crossdomain.xml 放行 Ruffle 的跨域读（架构 §3 引擎）。
registerNetBroker()

function shellDocument(): string {
  const devUrl = !app.isPackaged && process.env.ELECTRON_RENDERER_URL
  return devUrl ? new URL(devUrl).href : pathToFileURL(join(__dirname, '../renderer/index.html')).href
}

/** 命令行里第一个 http(s) 参数作为首个标签的地址（`BaoFlashBrowser Next.exe <网址>`）。 */
function initialAddress(): string | undefined {
  const args = process.argv.slice(app.isPackaged ? 1 : 2)
  return args.find((arg) => /^https?:\/\/\S+$/i.test(arg))
}

async function openShellWindow(): Promise<void> {
  await createBrowserWindow({
    shellUrl: shellDocument(),
    flash: flash.enabled,
    flashHint: flash.hint,
    initialAddress: initialAddress()
  })
}

/**
 * 启动顺序（架构 §4 数据）：先开业务库并应用设置，**再**建窗口。
 *
 * 主题必须在第一个窗口之前就位，否则暗色下会先闪一下亮色；存储失败不阻断浏览，
 * `initStorage()` 会退化成默认设置并让写入返回稳定错误码。
 */
app.whenReady()
  .then(async () => {
    await initStorage()
    await openShellWindow()
  })
  .catch((error: unknown) => {
    console.error('浏览器外壳启动失败。', error)
    app.exit(1)
  })

app.on('will-quit', () => closeStorage())

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
