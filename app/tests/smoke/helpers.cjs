const { createHash } = require('node:crypto')
const { existsSync, readFileSync } = require('node:fs')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const { mkdtemp, readFile, rm } = require('node:fs/promises')
const { createServer } = require('node:http')
const { tmpdir } = require('node:os')
const { extname, isAbsolute, join, resolve } = require('node:path')
const { _electron: electron } = require('playwright')

// Windows 上 Adobe PPAPI 初始化会启动控制台进程，即使应用窗口隐藏。
const nativeFlashSkip = process.platform === 'win32' &&
  (process.env.BAO_SMOKE_HIDDEN === '1' || process.env.BAO_SMOKE_BACKGROUND === '1') &&
  '未验证此内核的 PPAPI 进程沙箱，请用 --foreground 验收原生 Flash。'

/** 叠加层文档（飞窗 / 引擎面板 / 提示条 / 崩溃恢复气泡共用的那个视图）的 URL 特征。 */
const OVERLAY_URL_MARKER = 'baoOverlay=overlay'

let verifiedPpapiSandbox
function appNativeFlashSkip() {
  if (!nativeFlashSkip) return false
  if (verifiedPpapiSandbox === undefined) {
    const runtime = require('../../scripts/runtime-manifest.json')
    const executable = process.env.ELECTRON_EXEC_PATH
    verifiedPpapiSandbox = runtime.kernel.windowsPpapiProcessSandbox === true &&
      isAbsolute(executable ?? '') && existsSync(executable) &&
      createHash('sha256').update(readFileSync(executable)).digest('hex').toUpperCase() ===
        runtime.files['.runtime/win-x64/electron.exe']
  }
  return verifiedPpapiSandbox ? false : nativeFlashSkip
}

const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.swf': 'application/x-shockwave-flash'
}

/**
 * 环境里有 ELECTRON_RUN_AS_NODE 时 electron 以 Node 模式启动，主进程拿不到 app。
 * 这是本机环境变量（flashprobe/README.md 同样记录过），不是产品行为，启动前清掉。
 */
function resolveExecutable() {
  delete process.env.ELECTRON_RUN_AS_NODE
  const executablePath = process.env.ELECTRON_EXEC_PATH
  assert.ok(isAbsolute(executablePath ?? ''), '请设置 ELECTRON_EXEC_PATH 为自编译 Electron 的绝对路径。')
  return executablePath
}

function isShellPage(page) {
  return page.url().endsWith('/out/renderer/index.html')
}

/**
 * 本地样本服务器：`fixtures/` 目录 + 每个用例自带的 HTML 路由。
 * `.swf` 必须以 application/x-shockwave-flash 返回，否则插件不会接管。
 */
async function startFixtureServer(routes = {}) {
  const root = resolve(__dirname, 'fixtures')
  const server = createServer(async (request, response) => {
    const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (Object.hasOwn(routes, pathname)) {
      response.writeHead(200, { 'Content-Type': MIME_TYPES['.html'] })
      response.end(routes[pathname])
      return
    }
    try {
      const file = join(root, pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''))
      const body = await readFile(file)
      response.writeHead(200, { 'Content-Type': MIME_TYPES[extname(file)] ?? 'application/octet-stream' })
      response.end(body)
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('not found')
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolveClose) => server.close(resolveClose))
  }
}

function page(title, body = '<input aria-label="输入测试">') {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1>${body}`
}

/** 活动实例登记表：只用于超时时 dump 现场（失败诊断，不参与断言）。 */
const liveApps = new Set()

/** 超时时收集现场：进程分布、外壳页状态、标签快照。任何一步失败都只记录不抛出。 */
async function collectDiagnostics() {
  if (liveApps.size === 0) return "  (no live app)"
  const one = async (entry) => {
    const parts = []
    try {
      const metrics = await entry.app.evaluate(({ app }) => {
        const rows = app.getAppMetrics()
        const byType = {}
        let total = 0
        for (const row of rows) {
          byType[row.type] = (byType[row.type] ?? 0) + 1
          total += row.memory ? row.memory.workingSetSize : 0
        }
        return { byType, totalMB: Math.round(total / 1024) }
      })
      parts.push(`metrics=${JSON.stringify(metrics)}`)
    } catch (error) { parts.push(`metrics=<${error.message}>`) }
    try {
      if (entry.shell.isClosed()) {
        parts.push("shell=<closed>")
      } else {
        const snap = await entry.shell.evaluate(async () => {
          const r = await window.baoBrowser.run({ type: "snapshot" })
          const state = r ? r.state : null
          const active = state ? state.tabs.find((tab) => tab.id === state.activeId) : null
          return {
            ok: r ? r.ok : null,
            tabs: state ? state.tabs.length : -1,
            active: active ? active.address : null,
            loading: active ? active.loading : null,
            labels: Array.from(document.querySelectorAll(".tab"), (el) => el.textContent.trim()).slice(0, 6)
          }
        }).catch((error) => ({ error: String(error.message) }))
        parts.push(`shell=${JSON.stringify(snap)}`)
      }
    } catch (error) { parts.push(`shell=<${error.message}>`) }
    return `${entry.profilePath}: ${parts.join(" ")}`
  }
  const all = await Promise.race([
    Promise.all([...liveApps].map((entry) => Promise.race([one(entry), new Promise((done) => setTimeout(() => done("[diag timeout]"), 4_000))]))),
    new Promise((done) => setTimeout(() => done(["[diag timeout]"]), 5_000))
  ])
  return all.map((line) => `  ${line}`).join("\n")
}
/**
 * 轮询直到 predicate 返回真值。
 *
 * predicate 抛错时**继续重试**而不是立刻失败：并行跑用例、或主进程正忙时，
 * `electronApplication.evaluate` 会偶发 "Resulting promise was garbage collected" /
 * "Script failed to execute"——那是「这一刻还没准备好」，不是断言失败。
 * 到超时仍未满足时，优先抛出 predicate 的最后一次错误（信息更具体）。
 */
async function waitFor(predicate, { timeout = 30_000, interval = 100, message = '条件未在超时内满足。' } = {}) {
  const deadline = Date.now() + timeout
  let lastError
  for (;;) {
    try {
      const value = await predicate()
      if (value) return value
      lastError = undefined
    } catch (error) {
      lastError = error
    }
    if (Date.now() >= deadline) {
      const base = lastError ?? new Error(message)
      // 超时最有价值的是现场：把进程分布、外壳页状态和标签快照一起抛出来，
      // 避免「偶发超时」变成无法复现的空白记录。
      const diagnostics = await collectDiagnostics().catch(() => "  (diagnostics failed)")
      const error = new Error(`${base.message}\n[超时现场]\n${diagnostics}`)
      error.stack = `${base.stack ?? base.message}\n[超时现场]\n${diagnostics}`
      throw error
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, interval))
  }
}

/**
 * 使用独立测试 profile 启动真实自编译运行时。
 *
 * `options.env` 只叠加到子进程环境（例如 `BAO_OVERLAY_PREWARM=never` 这类策略覆盖）：
 * 用例之间共用同一个 Node 进程（`--experimental-test-isolation=none`），改 `process.env`
 * 会漏给后面的文件，所以必须走这里而不是在用例里 set。
 */
async function launchApp({ env: extraEnv } = {}) {
  const profilePath = await mkdtemp(join(tmpdir(), 'bao-next-smoke-'))
  const app = await electron.launch({
    executablePath: resolveExecutable(),
    args: [resolve(__dirname, '../..'), `--user-data-dir=${profilePath}`],
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    timeout: 20_000
  })
  const shell = app.windows().find(isShellPage) ??
    await app.waitForEvent('window', { predicate: isShellPage, timeout: 10_000 })
  shell.setDefaultTimeout(10_000)
  const entry = { app, shell, profilePath }
  liveApps.add(entry)
  return {
    app,
    shell,
    profilePath,
    entry,
    async close() {
      liveApps.delete(entry)
      await app.close().catch(() => {})
      await rm(profilePath, { recursive: true, force: true, maxRetries: 3 })
    }
  }
}

/** 用**已存在**的 profile 再启动一次（跨重启验证）；不删除该目录，调用方自己清理。 */
async function launchAppAt(profilePath) {
  const app = await electron.launch({
    executablePath: resolveExecutable(),
    args: [resolve(__dirname, '../..'), `--user-data-dir=${profilePath}`],
    timeout: 20_000
  })
  const shell = app.windows().find(isShellPage) ??
    await app.waitForEvent('window', { predicate: isShellPage, timeout: 10_000 })
  shell.setDefaultTimeout(10_000)
  return {
    app,
    shell,
    profilePath,
    async close() {
      await app.close().catch(() => {})
    }
  }
}

/** 主进程里当前窗口的页面视图（外壳之外唯一挂载的 WebContentsView）。 */
function pageViewIds(windowHandle) {
  return windowHandle.evaluate((window) =>
    window.contentView.children
      .filter((child) => child.webContents && child.webContents !== window.webContents)
      .map((child) => child.webContents.id))
}

/**
 * 在叠加层文档里执行一段脚本（找不到文档时返回 undefined）。
 *
 * 崩溃恢复气泡住在叠加层视图里（不是外壳 DOM）：提示条那版可以 `.session-infobar` 定位，
 * 气泡只能进到那个 WebContents 里看。视图可能正处在「共享模式刚被外壳 window.open 出来」
 * 的创建窗口期，所以失败重试一次——与 `quick-settings.test.cjs` 的 `inQuick()` 同一套做法。
 */
async function overlayEval(app, code) {
  let lastError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const id = await app.evaluate(({ webContents }, marker) => {
      const target = webContents.getAllWebContents().find((contents) =>
        (contents.getURL() ?? '').includes(marker))
      return target ? target.id : null
    }, OVERLAY_URL_MARKER)
    if (!id) {
      lastError = new Error('叠加层文档还不存在')
      await new Promise((done) => setTimeout(done, 250))
      continue
    }
    try {
      return await app.evaluate(async ({ webContents }, payload) => {
        const target = webContents.fromId(payload.id)
        if (!target || target.isDestroyed()) throw new Error('叠加层已销毁')
        return target.executeJavaScript(payload.code)
      }, { id, code })
    } catch (error) {
      lastError = error
      await new Promise((done) => setTimeout(done, 250))
    }
  }
  throw lastError ?? new Error('叠加层文档不可用')
}

/** 崩溃恢复气泡的当前状态；没显示时返回 null。 */
async function sessionBubbleState(app) {
  const state = await overlayEval(app, `(() => {
    const card = document.querySelector('.session-bubble')
    // 组件常驻挂载（宿主用 v-show 切显示），所以"消失了"= 祖先 display:none 导致没有布局盒。
    if (!card || card.getClientRects().length === 0) return null
    return {
      title: (card.querySelector('.session-bubble-title')?.textContent ?? '').trim(),
      message: (card.querySelector('.session-bubble-message')?.textContent ?? '').trim(),
      tabs: Number((card.querySelector('.session-bubble-count')?.textContent ?? '0').trim()),
      restore: (card.querySelector('.session-bubble-actions button')?.textContent ?? '').trim()
    }
  })()`).catch(() => undefined)
  return state ?? null
}

/** 等气泡出现（走 waitFor，让超时现场带上进程/标签快照）。 */
async function waitForSessionBubble(app, { timeout = 30_000 } = {}) {
  return waitFor(async () => {
    const state = await sessionBubbleState(app)
    return state ?? null
  }, { timeout, message: '崩溃恢复气泡没有出现' })
}

/** 等气泡消失（用户回答后，或提示被清除）。 */
async function waitForSessionBubbleGone(app, { timeout = 30_000 } = {}) {
  return waitFor(async () => ((await sessionBubbleState(app)) === null ? true : null),
    { timeout, message: '崩溃恢复气泡没有消失' })
}

/** 点气泡上的「恢复」或右上角「忽略」（×）。 */
async function clickSessionBubble(app, action) {
  const selector = action === 'restore' ? '.session-bubble-actions button' : '.session-bubble-close'
  return overlayEval(app, `(() => {
    const button = document.querySelector('${selector}')
    if (!button) return false
    button.click()
    return true
  })()`)
}

/** 主进程里主窗口当前挂载的页面视图 bounds（用来验证气泡不会推页面）。 */
function pageViewBounds(app) {
  return app.evaluate(({ BrowserWindow }) => {
    // 取外壳窗口（多窗口拖出场景下第一扇不一定是外壳）。
    const win = BrowserWindow.getAllWindows().find((item) =>
      (item.webContents.getURL() ?? '').endsWith('/out/renderer/index.html'))
    if (!win) return null
    const view = win.contentView.children
      .find((child) => child.webContents && child.webContents !== win.webContents)
    return view ? view.getBounds() : null
  })
}

/**
 * 主进程里按 URL 找页面 WebContents 的**实际**音频状态。
 *
 * 静音 / 休眠 / 会话恢复的回归必须检查真实 WebContents 的 `isAudioMuted()`：
 * 外壳快照里的 `muted` 是逻辑状态，单独断言它无法证明「真的静音了」。
 */
async function audioStateOf(app, url) {
  const entries = await app.evaluate(({ webContents }) =>
    webContents.getAllWebContents().map((contents) => {
      try {
        return {
          id: contents.id,
          url: contents.getURL(),
          muted: contents.isAudioMuted(),
          destroyed: contents.isDestroyed()
        }
      } catch {
        return undefined
      }
    }).filter(Boolean))
  return entries.find((entry) => entry.url === url)
}

/**
 * 走真实的主进程键盘路径。
 * Playwright 的 `page.keyboard` 是 CDP 注入，不会触发 Electron 的 `before-input-event`；
 * `webContents.sendInputEvent` 才会，因此标签级快捷键必须这样测。
 */
async function pressShortcut(app, keyCode, modifiers = []) {
  await app.evaluate(async ({ webContents }, input) => {
    const target = webContents.getAllWebContents().find((contents) => contents.getURL().endsWith('index.html'))
    if (!target) throw new Error('未找到外壳 WebContents。')
    target.sendInputEvent({ type: 'keyDown', keyCode: input.keyCode, modifiers: input.modifiers })
    target.sendInputEvent({ type: 'char', keyCode: input.keyCode, modifiers: input.modifiers })
    target.sendInputEvent({ type: 'keyUp', keyCode: input.keyCode, modifiers: input.modifiers })
    await new Promise((done) => setTimeout(done, 50))
  }, { keyCode, modifiers })
}

/**
 * 等标签栏出现指定标题。
 *
 * 为什么不用 Playwright 的 locator.waitFor：那是一条 30s 的黑盒超时，超时后只剩
 * "waiting for ... to be visible"，没有进程分布与标签快照。走 waitFor() 才能把现场带出来。
 */
async function waitForTabLabel(shell, title, { timeout = 30_000 } = {}) {
  return waitFor(async () => {
    if (shell.isClosed()) return null
    const labels = await shell.evaluate(() =>
      Array.from(document.querySelectorAll('.tab'), (el) => el.textContent.trim())
    )
    return labels.includes(title) ? labels : null
  }, { timeout, message: `标签栏未出现「${title}」` })
}

/**
 * 用命令通道切换当前标签的引擎，并等投影确认（2026-11-26）。
 *
 * 为什么不点界面：工具栏去掉了内联快捷开关（引擎按钮统一成"点开飞窗"），而 broker / CORS /
 * 输入 / 弹窗这些用例要的是"处于 Ruffle 下"，不验证切换 UI；UI 路径由 `engine.test.cjs`
 * （点按钮 → 飞窗里选）与 `engine-rules.test.cjs` 覆盖。
 */
async function setEngine(shell, engine) {
  const result = await shell.evaluate((next) => window.baoBrowser.run({ type: 'set-engine', engine: next }), engine)
  assert.equal(result.ok, true, `切换引擎失败：${result.code ?? String(result)}`)
  return waitFor(async () => {
    const state = await shell.evaluate(() =>
      window.baoBrowser.run({ type: 'snapshot' }).then((snapshot) => snapshot.state))
    const tab = state.tabs.find((item) => item.id === state.activeId)
    return tab && tab.engine === engine && !tab.loading ? tab : null
  }, { message: `切到 ${engine} 后投影没有同步` })
}

module.exports = {
  audioStateOf,
  clickSessionBubble,
  waitForTabLabel,
  appNativeFlashSkip,
  flashPluginPath,
  hasFlashPlugin,
  isShellPage,
  launchApp,
  launchAppAt,
  nativeFlashSkip,
  overlayEval,
  page,
  pageViewBounds,
  pageViewIds,
  pressShortcut,
  sessionBubbleState,
  setEngine,
  startFixtureServer,
  waitFor,
  waitForSessionBubble,
  waitForSessionBubbleGone
}
/**
 * 本地是否有 PPAPI 插件（BYOP：开发环境可能没放）。
 *
 * 依赖插件的用例（`flash`、`plugin-input`）在没有插件时应当**跳过并说明原因**，
 * 而不是报「页面加载超时」——否则 BYOP 机器上永远一片红，新人会以为代码坏了。
 */
function flashPluginPath() {
  return join(__dirname, '..', '..', '.runtime', 'win-x64', 'pepflashplayer64.dll')
}

function hasFlashPlugin() {
  return existsSync(flashPluginPath())
}
