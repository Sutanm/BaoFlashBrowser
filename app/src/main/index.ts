import { app, BrowserWindow, Menu, protocol } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createBrowserWindow, flushSession, holdSession, registerBrowserIpc, sessionRestorePending } from './browser-window'
import { configureFlashPlugin } from './plugins'
import { ruffleSchemePrivileges, registerRuffleIpc } from './ruffle'
import { registerPopupChromeIpc } from './popup-chrome'
import { registerWindowControlIpc } from './window-control'
import { registerNetBroker } from './net-broker'
import { internalSchemePrivileges } from './internal-pages'
import { closeStorage, initStorage, markSessionExit, session as storedSession, sessionExit, settings } from './storage'
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

async function openShellWindow(session?: { crashSession?: SessionSnapshot; initialSession?: SessionSnapshot }): Promise<void> {
  await createBrowserWindow({
    shellUrl: shellDocument(),
    flash: flash.enabled,
    flashHint: flash.hint,
    initialAddress: initialAddress(),
    ...session
  })
}

/**
 * 启动顺序（架构 §4 数据）：先开业务库并应用设置，**再**建窗口。
 *
 * 主题必须在第一个窗口之前就位，否则暗色下会先闪一下亮色；存储失败不阻断浏览，
 * `initStorage()` 会退化成默认设置并让写入返回稳定错误码。
 *
 * 启动行为由设置项 `session.startup` 决定（Chrome 的 `On startup`）：
 * - `newtab`（默认）：正常退出后重启**不恢复**，一律是新标签页；只有上次异常退出
 *   （`session.last-exit === 'crash'`）且确实存有会话时，才把会话交给首个窗口挂起，
 *   由外壳提示条等用户点「恢复标签页」；
 * - `continue`：用户明确要求「继续上次会话」，启动即恢复，不再提示。
 *
 * 无论哪种模式，启动时都先把标记改回 `crash` 武装（本次若再崩溃，下次能识别），
 * 命令行显式带网址时则不恢复也不提示（用户当下要打开的东西优先）。
 */
app.whenReady()
  .then(async () => {
    await initStorage()
    const saved = initialAddress() ? undefined : storedSession()
    /**
     * `'pending'` = 上次的恢复提示**没人回答**（用户直接退出或关掉了提示窗口）。
     *
     * 这种启动必须继续提示，否则保存的会话会在本次的某次写盘里被覆盖掉——「看不到提示」
     * 和「没有会话」是两件事，不能混（2026-11-26 审计）。
     */
    const exit = sessionExit()
    const awaitingRestore = (exit === 'crash' || exit === 'pending') && !!saved && sessionTabCount(saved) > 0
    // 先武装再开窗口：武装失败只影响下一次崩溃检测，不阻断启动。
    markSessionExit(awaitingRestore ? 'pending' : 'crash')
    if (saved && settings().sessionStartup === 'continue') {
      // 「继续上次会话」：恢复即用户已选择，不需要再问一次。
      await openShellWindow({ initialSession: saved })
      return
    }
    if (awaitingRestore && saved) {
      // 用户回答之前不许覆盖磁盘上的崩溃会话（否则提示条还在、内容已经没了）。
      holdSession()
      await openShellWindow({ crashSession: saved })
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
  /**
   * 提示还没被回答时**不能**写 `clean`：那会让下次启动不再提示，磁盘上那份崩溃会话随后
   * 被本次的空白会话覆盖（2026-11-26 审计）。关掉提示窗口也算"没回答"。
   */
  markSessionExit(sessionRestorePending() ? 'pending' : 'clean')
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
