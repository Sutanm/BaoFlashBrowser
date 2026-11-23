const assert = require('node:assert/strict')
const { mkdtemp, readdir, rm, stat } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { test } = require('node:test')
const { _electron: electron } = require('playwright')
const { startFixtureServer } = require('./helpers.cjs')

async function waitForFacts(read, message) {
  const deadline = Date.now() + 60_000
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((done) => setTimeout(done, 150))
  }
}

// `npm run pack:win` 输出到固定的 dist/win-preview/win-unpacked（每次覆盖），
// 选最新的可执行文件即可；历史随机目录已由打包脚本清理。
async function latestPackagedExecutable() {
  const dist = resolve(__dirname, '../../dist')
  const entries = await readdir(dist, { withFileTypes: true }).catch(() => [])
  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('win-preview')) continue
    const unpacked = join(dist, entry.name, 'win-unpacked')
    const files = await readdir(unpacked).catch(() => [])
    for (const file of files) {
      if (!file.endsWith('.exe') || file === 'elevate.exe') continue
      const path = join(unpacked, file)
      candidates.push({ path, mtimeMs: (await stat(path)).mtimeMs })
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
  return candidates[0]?.path
}

test('Win x64 验证包运行真实自编译运行时并加载 PPAPI 样本', { timeout: 180_000 }, async (context) => {
  const executablePath = await latestPackagedExecutable()
  if (!executablePath) {
    context.skip('未找到 dist/win-preview-*/win-unpacked，先运行 npm run pack:win。')
    return
  }

  delete process.env.ELECTRON_RUN_AS_NODE
  const server = await startFixtureServer()
  const profilePath = await mkdtemp(join(tmpdir(), 'bao-next-packaged-'))
  const app = await electron.launch({ executablePath, args: [`--user-data-dir=${profilePath}`], timeout: 30_000 })
  try {
    const isShell = (page) => page.url().endsWith('/out/renderer/index.html')
    const shell = app.windows().find(isShell) ?? await app.waitForEvent('window', { predicate: isShell, timeout: 20_000 })
    assert.deepEqual(await shell.evaluate(() => ({ ...window.baoRuntime })),
      { electron: '39.8.10', chromium: '142.0.7444.265' })

    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${server.baseUrl}/flash.html`)
    await address.press('Enter')
    const tab = shell.getByRole('button', { name: /^flash:/ })
    await tab.waitFor({ timeout: 60_000 })
    assert.equal(await tab.getAttribute('title'), 'flash:loaded bridge')

    const processes = await app.evaluate(({ app }) => app.getAppMetrics().map((metric) => metric.type))
    assert.ok(processes.includes('Pepper Plugin'), `验证包未启动 PPAPI 插件进程：${processes.join(',')}`)

    // 验证包里也带着版本固定的 Ruffle 运行时（vendor 必须打进 asar）。
    await shell.getByRole('switch', { name: '切换到 Ruffle 引擎', exact: true }).click()
    const windowHandle = await app.browserWindow(shell)
    const polyfilled = await waitForFacts(async () => {
      const facts = await windowHandle.evaluate(async (window) => {
        const view = window.contentView.children
          .find((child) => child.webContents && child.webContents !== window.webContents)
        return view.webContents.executeJavaScript(`({
          newest: typeof window.RufflePlayer?.newest,
          players: document.querySelectorAll('ruffle-embed, ruffle-object, ruffle-player').length
        })`)
      })
      return facts.newest === 'function' && facts.players > 0 ? facts : null
    }, '验证包未加载 Ruffle 运行时。')
    assert.ok(polyfilled.players >= 1)
  } finally {
    await app.close().catch(() => {})
    await server.close()
    await rm(profilePath, { recursive: true, force: true, maxRetries: 3 })
  }
})
