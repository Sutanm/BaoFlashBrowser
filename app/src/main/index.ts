import { app, BrowserWindow, Menu, protocol } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBrowserWindow, flushSession, holdSession, registerBrowserIpc } from './browser-window'
import { configureFlashPlugin } from './plugins'
import { ruffleSchemePrivileges, registerRuffleIpc } from './ruffle'
import { registerPopupChromeIpc } from './popup-chrome'
import { registerWindowControlIpc } from './window-control'
import { registerNetBroker } from './net-broker'
import { internalSchemePrivileges } from './internal-pages'
import { closeStorage, initStorage, markSessionExit, session as storedSession, sessionExit } from './storage'
import { sessionTabCount } from '../shared/session'
import type { SessionSnapshot } from '../shared/session'
import { backgroundSmoke, hiddenSmoke } from './automation'

app.setName('BaoFlashBrowser Next')

// 浏览器外壳不挂 Electron 默认应用菜单：否则 Ctrl+W / Ctrl+R 等快捷键会被
// 默认菜单的 accelerator 抢走，标签级快捷键无法生效（架构 §3 商标交互沿用 Chrome 式目标）。
Menu.setApplicationMenu(null)

/**
 * 自动化模式下关闭 Chromium 的后台节流，避免不可见窗口的页面定时器影响回归结果。
 */
if (hiddenSmoke || backgroundSmoke) {
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  app.commandLine.appendSwitch('disable-background-timer-throttling')
}

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

async function openShellWindow(crashSession?: SessionSnapshot): Promise<void> {
  await createBrowserWindow({
    shellUrl: shellDocument(),
    flash: flash.enabled,
    flashHint: flash.hint,
    initialAddress: initialAddress(),
    crashSession
  })
}

/**
 * 启动顺序（架构 §4 数据）：先开业务库并应用设置，**再**建窗口。
 *
 * 主题必须在第一个窗口之前就位，否则暗色下会先闪一下亮色；存储失败不阻断浏览，
 * `initStorage()` 会退化成默认设置并让写入返回稳定错误码。
 *
 * 崩溃恢复（Chrome 的「恢复页面」语义）：
 * - **正常退出后重启不恢复**，一律是新标签页——用户主动退出就不该被旧标签打扰；
 * - 只有上次没有正常退出（`session.last-exit === 'crash'`）且确实存有会话时，
 *   才把会话交给首个窗口**挂起**，由外壳顶部提示条等用户点「恢复标签页」；
 * - 启动时立刻把标记改回 `crash` 武装：本次运行若再崩溃，下次启动同样能识别；
 * - 命令行显式带了网址时不提示（用户当下要打开的东西优先）。
 */
app.whenReady()
  .then(async () => {
    await initStorage()
    const saved = initialAddress() ? undefined : storedSession()
    const crashed = sessionExit() === 'crash' && !!saved && sessionTabCount(saved) > 0
    // 先武装再开窗口：武装失败只影响下一次崩溃检测，不阻断启动。
    markSessionExit('crash')
    if (crashed && saved) {
      // 用户回答之前不许覆盖磁盘上的崩溃会话（否则提示条还在、内容已经没了）。
      holdSession()
      await openShellWindow(saved)
      return
    }
    await openShellWindow()
  })
  .catch((error: unknown) => {
    console.error('浏览器外壳启动失败。', error)
    app.exit(1)
  })

/** 正常退出：先冻结会话内容，再把退出标记改成 `clean`（硬杀时这两步都来不及）。 */
app.on('before-quit', () => {
  flushSession()
  markSessionExit('clean')
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
