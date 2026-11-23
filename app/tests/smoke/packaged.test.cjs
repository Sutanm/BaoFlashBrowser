const assert = require('node:assert/strict')
const { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } = require('node:fs/promises')
const { existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join, resolve } = require('node:path')
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
// `BAO_PACKAGED_ROOT` 可指向别的产物根目录，供 CI / 门禁脚本校验**本次生成的**产物。
async function latestPackagedExecutable() {
  const dist = process.env.BAO_PACKAGED_ROOT
    ? resolve(process.env.BAO_PACKAGED_ROOT)
    : resolve(__dirname, '../../dist')
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


/** 读产物自带的 manifest.json 决定 profile；没有清单按 internal 处理。 */
async function readPackagedProfile(executablePath) {
  const manifest = join(dirname(executablePath), 'manifest.json')
  const text = await readFile(manifest, 'utf8').catch(() => '')
  if (!text) return 'internal'
  try {
    return JSON.parse(text).profile === 'public' ? 'public' : 'internal'
  } catch {
    return 'internal'
  }
}

test('Win x64 验证包运行真实自编译运行时并加载 PPAPI 样本', { timeout: 180_000 }, async (context) => {
  const executablePath = await latestPackagedExecutable()
  if (!executablePath) {
    // 审计 P2：成品验证不允许默认跳过，否则「打包通过」会被当成「真产物通过」。
    // 只允许显式声明本次不验成品（例如只跑应用冒烟时）。
    if (process.env.BAO_SKIP_PACKAGED === '1') {
      context.skip('BAO_SKIP_PACKAGED=1：本次显式跳过成品验证。')
      return
    }
    assert.fail('未找到 dist/win-preview/win-unpacked：先运行 npm run pack:win；若确实只想跑应用冒烟，设置 BAO_SKIP_PACKAGED=1。')
  }

  delete process.env.ELECTRON_RUN_AS_NODE
  const server = await startFixtureServer()
  const profilePath = await mkdtemp(join(tmpdir(), 'bao-next-packaged-'))
  // profile 由产物自带的 manifest.json 决定（internal = 捆插件；public = BYOP 不带插件）。
  const profile = await readPackagedProfile(executablePath)
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

    const processes = await app.evaluate(({ app }) => app.getAppMetrics().map((metric) => metric.type))
    if (profile === 'internal') {
      assert.equal(await tab.getAttribute('title'), 'flash:loaded bridge')
      assert.ok(processes.includes('Pepper Plugin'), `验证包未启动 PPAPI 插件进程：${processes.join(',')}`)
    } else {
      // 公开包不携带 Adobe 二进制：插件进程不应出现，页面按 CORS/插件缺失走 Ruffle。
      assert.ok(!processes.includes('Pepper Plugin'), '公开包里出现了 PPAPI 插件进程')
      assert.ok((await tab.getAttribute('title')).startsWith('flash:'), '公开包页面未正常加载')
    }

    // 验证包里也带着版本固定的 Ruffle 运行时（vendor 必须打进 asar）。
    // 公开包（BYOP）没有插件，标签本来就在 Ruffle 上，不存在「切到 Ruffle」开关。
    if (profile === 'internal') {
      await shell.getByRole('switch', { name: '切换到 Ruffle 引擎', exact: true }).click()
    }
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
/**
 * BYOP 落地验证：公开包不带 Adobe 二进制，但用户把插件放到 `<exe目录>\flash\` 后
 * 原生引擎必须生效。这条只对 public profile 有意义（internal 包自带插件，跳过）。
 */
test('BYOP：把插件放到 <exe目录>\\flash\\ 后原生引擎生效', { timeout: 180_000 }, async (context) => {
  const executablePath = await latestPackagedExecutable()
  if (!executablePath) {
    assert.fail('未找到 dist/win-preview/win-unpacked：先运行 npm run pack:win:public。')
  }
  const profile = await readPackagedProfile(executablePath)
  if (profile !== 'public') {
    context.skip('当前产物是 internal profile（自带插件），BYOP 不适用。')
    return
  }
  const devPlugin = resolve(__dirname, '../../.runtime/win-x64/pepflashplayer64.dll')
  assert.ok(existsSync(devPlugin), '缺少开发侧插件文件，无法模拟用户自备')

  delete process.env.ELECTRON_RUN_AS_NODE
  const server = await startFixtureServer()
  const dropIn = join(dirname(executablePath), 'flash')
  await mkdir(dropIn, { recursive: true })
  await copyFile(devPlugin, join(dropIn, 'pepflashplayer64.dll'))
  const profilePath = await mkdtemp(join(tmpdir(), 'bao-next-byop-'))
  const app = await electron.launch({ executablePath, args: [`--user-data-dir=${profilePath}`], timeout: 30_000 })
  try {
    const isShell = (page) => page.url().endsWith('/out/renderer/index.html')
    const shell = app.windows().find(isShell) ?? await app.waitForEvent('window', { predicate: isShell, timeout: 20_000 })
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${server.baseUrl}/flash.html`)
    await address.press('Enter')
    const tab = shell.getByRole('button', { name: /^flash:/ })
    await tab.waitFor({ timeout: 60_000 })
    assert.equal(await tab.getAttribute('title'), 'flash:loaded bridge', 'BYOP 插件未被加载')
    const processes = await app.evaluate(({ app }) => app.getAppMetrics().map((metric) => metric.type))
    assert.ok(processes.includes('Pepper Plugin'), `BYOP 未启动 PPAPI 插件进程：${processes.join(',')}`)
  } finally {
    await app.close().catch(() => {})
    await rm(dropIn, { recursive: true, force: true })
    await server.close()
  }
})