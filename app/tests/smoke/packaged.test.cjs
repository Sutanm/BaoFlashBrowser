const assert = require('node:assert/strict')
const { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat } = require('node:fs/promises')
const { existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join, resolve } = require('node:path')
const { test } = require('node:test')
const { _electron: electron } = require('playwright')
const { nativeFlashSkip, startFixtureServer } = require('./helpers.cjs')

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


/**
 * 读产物自带的 manifest.json 决定 profile，并**校验它与命令声明的期望一致**。
 *
 * 审计 P1：`smoke:packaged` 与 `smoke:packaged:public` 之前完全相同、按找到的 EXE 自选
 * profile，于是 public 命令可以在 internal 产物上通过。现在由 `scripts/test.cjs --public`
 * 下发 `BAO_EXPECT_PROFILE`，不符就直接失败；同时校验「public 包不含 Adobe 二进制、
 * internal 包必须含」。
 */
async function readPackagedProfile(executablePath) {
  const manifestPath = join(dirname(executablePath), 'manifest.json')
  const manifest = await readFile(manifestPath, 'utf8').then(JSON.parse).catch(() => null)
  if (hidden) {
    assert.equal(manifest?.smokeHiddenSupported, true,
      '旧产物不支持无窗口启动；请先重新打包，再跑成品冒烟。')
  }
  const actual = manifest?.profile === 'public' ? 'public' : 'internal'
  const expected = process.env.BAO_EXPECT_PROFILE
  if (expected) {
    assert.equal(actual, expected,
      `产物 profile 与命令不符：产物=${actual}（${executablePath}），期望=${expected}。` +
      '换用对应命令，或重新打包。')
  }
  const pluginPath = join(dirname(executablePath), 'pepflashplayer64.dll')
  const pluginPresent = existsSync(pluginPath) || existsSync(join(dirname(executablePath), 'flash', 'pepflashplayer64.dll'))
  assert.equal(pluginPresent, actual === 'internal',
    `产物 profile=${actual} 与插件存在性不符（插件 ${pluginPresent ? '存在' : '缺失'}）。`)
  return actual
}

const hidden = process.env.BAO_SMOKE_HIDDEN === '1'

async function launchPackaged(executablePath, profilePath) {
  const args = [`--user-data-dir=${profilePath}`]
  if (hidden) args.push('--bao-smoke-hidden')
  return electron.launch({ executablePath, args, timeout: 30_000 })
}

async function assertHidden(app, shell) {
  if (!hidden) return
  const window = await app.browserWindow(shell)
  assert.deepEqual(await window.evaluate((win) => [win.isVisible(), win.isFocusable(), win.isFocused()]),
    [false, false, false], '成品冒烟窗口必须保持隐藏且不获取焦点')
}

test('Win x64 验证包使用自编译运行时并加载 Ruffle', { timeout: 180_000 }, async (context) => {
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

  // 先查清单，再启动任何进程或资源（旧产物可能会弹出窗口）。
  const profile = await readPackagedProfile(executablePath)
  // 公开包的「没有插件」断言验的是**产物**：本机若装了系统 Flash，自动发现会把那份加载起来，
  // 断言就变成在验这台机器。显式关掉自动发现；下面的 BYOP 投放用例再验优先级。
  if (profile === 'public') process.env.BAO_FLASH_DISCOVERY = 'off'
  delete process.env.ELECTRON_RUN_AS_NODE
  const profilePath = await mkdtemp(join(tmpdir(), 'bao-next-packaged-'))
  const server = await startFixtureServer()
  let app
  try {
    app = await launchPackaged(executablePath, profilePath)
    const isShell = (page) => page.url().endsWith('/out/renderer/index.html')
    const shell = app.windows().find(isShell) ?? await app.waitForEvent('window', { predicate: isShell, timeout: 20_000 })
    await assertHidden(app, shell)
    assert.deepEqual(await shell.evaluate(() => ({ ...window.baoRuntime })),
      { electron: '39.8.10', chromium: '142.0.7444.265' })
    const address = shell.getByRole('textbox', { name: '地址栏' })
    const openSample = async () => {
      await address.fill(`${server.baseUrl}/flash.html`)
      await address.press('Enter')
    }

    if (profile === 'internal') {
      await context.test('内部验证包加载 PPAPI 并保留 JS 桥', { skip: nativeFlashSkip }, async () => {
        await openSample()
        const tab = shell.getByRole('button', { name: /^flash:/ })
        await tab.waitFor({ timeout: 60_000 })
        assert.equal(await tab.getAttribute('title'), 'flash:loaded bridge')
        const processes = await app.evaluate(({ app }) => app.getAppMetrics().map((metric) => metric.type))
        assert.ok(processes.includes('Pepper Plugin'), `验证包未启动 PPAPI 插件进程：${processes.join(',')}`)
      })
      await shell.getByRole('switch', { name: '切换到 Ruffle 引擎', exact: true }).click()
    }
    await shell.getByRole('switch', { name: '切换到原生 Flash 引擎', exact: true }).waitFor()
    if (profile === 'public' || nativeFlashSkip) await openSample()

    // 验证版本固定的 Ruffle 运行时已打进 asar，并实际接管样本。
    const windowHandle = await app.browserWindow(shell)
    await waitForFacts(() =>
      windowHandle.evaluate((window) => {
        const view = window.contentView.children
          .find((child) => child.webContents && child.webContents !== window.webContents)
        return view.webContents.executeJavaScript(`(() => {
          const player = document.querySelector('ruffle-embed, ruffle-object, ruffle-player')
          return typeof window.RufflePlayer?.newest === 'function' &&
            Boolean(player?.shadowRoot?.querySelector('canvas'))
        })()`)
      }), '验证包未加载 Ruffle 运行时。')
    if (profile === 'public' || nativeFlashSkip) {
      const processes = await app.evaluate(({ app }) => app.getAppMetrics().map((metric) => metric.type))
      assert.ok(!processes.includes('Pepper Plugin'), '后台或公开包 Ruffle 验收启动了 PPAPI 插件')
    }
  } finally {
    await app?.close().catch(() => {})
    await server.close()
    await rm(profilePath, { recursive: true, force: true, maxRetries: 3 })
  }
})
/**
 * BYOP 落地验证：公开包不带 Adobe 二进制，但用户把插件放到 `<exe目录>\flash\` 后
 * 原生引擎必须生效。这条只对 public profile 有意义（internal 包自带插件，跳过）。
 */
test('BYOP：把插件放到 <exe目录>\\flash\\ 后原生引擎生效', { timeout: 180_000, skip: nativeFlashSkip }, async (context) => {
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

  // 按用户真实配置运行（自动发现开着）：投放目录优先于自动发现，加载的必须是这份。
  delete process.env.BAO_FLASH_DISCOVERY
  delete process.env.ELECTRON_RUN_AS_NODE
  const server = await startFixtureServer()
  const dropIn = join(dirname(executablePath), 'flash')
  await mkdir(dropIn, { recursive: true })
  await copyFile(devPlugin, join(dropIn, 'pepflashplayer64.dll'))
  const profilePath = await mkdtemp(join(tmpdir(), 'bao-next-byop-'))
  let app
  try {
    app = await launchPackaged(executablePath, profilePath)
    const isShell = (page) => page.url().endsWith('/out/renderer/index.html')
    const shell = app.windows().find(isShell) ?? await app.waitForEvent('window', { predicate: isShell, timeout: 20_000 })
    await assertHidden(app, shell)
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${server.baseUrl}/flash.html`)
    await address.press('Enter')
    const tab = shell.getByRole('button', { name: /^flash:/ })
    await tab.waitFor({ timeout: 60_000 })
    assert.equal(await tab.getAttribute('title'), 'flash:loaded bridge', 'BYOP 插件未被加载')
    const processes = await app.evaluate(({ app }) => app.getAppMetrics().map((metric) => metric.type))
    assert.ok(processes.includes('Pepper Plugin'), `BYOP 未启动 PPAPI 插件进程：${processes.join(',')}`)
  } finally {
    await app?.close().catch(() => {})
    await rm(dropIn, { recursive: true, force: true })
    await server.close()
    await rm(profilePath, { recursive: true, force: true, maxRetries: 3 })
  }
})
