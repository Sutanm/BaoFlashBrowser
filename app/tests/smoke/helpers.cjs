const assert = require('node:assert/strict')
const { once } = require('node:events')
const { mkdtemp, readFile, rm } = require('node:fs/promises')
const { createServer } = require('node:http')
const { tmpdir } = require('node:os')
const { extname, isAbsolute, join, resolve } = require('node:path')
const { _electron: electron } = require('playwright')

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

async function waitFor(predicate, { timeout = 30_000, interval = 100, message = '条件未在超时内满足。' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((resolveWait) => setTimeout(resolveWait, interval))
  }
}

/** 使用独立测试 profile 启动真实自编译运行时。 */
async function launchApp() {
  const profilePath = await mkdtemp(join(tmpdir(), 'bao-next-smoke-'))
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
      await rm(profilePath, { recursive: true, force: true, maxRetries: 3 })
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

module.exports = { isShellPage, launchApp, page, pageViewIds, pressShortcut, startFixtureServer, waitFor }
