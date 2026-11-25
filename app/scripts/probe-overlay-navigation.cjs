/**
 * 探针 4：常驻预热（`overlay.prewarm=always`）下"地址栏导航不生效"的现场。
 *
 * 现象（前台套件 + `BAO_OVERLAY_PREWARM=always`）：整片用例 30 s 超时，超时现场都是
 *   tabs=1, active='', label='新标签页'
 * 也就是「输入地址 → 回车」这一步没生效，标签还是新标签页。**外壳没有崩**（自愈轨迹为空）。
 *
 * 这里逐步打印：填完地址后输入框的值、回车后主进程快照、渲染进程/网关状态，
 * 并与 auto 档对照。用法：
 *   $env:ELECTRON_EXEC_PATH=(Resolve-Path '.runtime\win-x64\electron.exe').Path
 *   node scripts/probe-overlay-navigation.cjs always
 *   node scripts/probe-overlay-navigation.cjs auto
 */
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { _electron: electron } = require('playwright')
const { startFixtureServer, waitFor } = require('../tests/smoke/helpers.cjs')

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function snapshot(shell) {
  return shell.evaluate(async () => {
    const result = await window.baoBrowser.run({ type: 'snapshot' })
    if (!result || !result.ok) return { failed: result ? result.code : 'null' }
    const state = result.state
    const active = state.tabs.find((tab) => tab.id === state.activeId)
    return {
      tabs: state.tabs.map((tab) => ({ id: tab.id, title: tab.title, address: tab.address, loading: tab.loading })),
      activeId: state.activeId,
      active: active ? { title: active.title, address: active.address, loading: active.loading } : null,
      input: document.querySelector('input[aria-label="地址栏"]')?.value ?? null,
      focused: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? null
    }
  })
}

async function main() {
  const mode = process.argv[2] ?? 'always'
  delete process.env.ELECTRON_RUN_AS_NODE
  const executablePath = process.env.ELECTRON_EXEC_PATH
  if (!executablePath) throw new Error('请设置 ELECTRON_EXEC_PATH')
  const env = { ...process.env, BAO_OVERLAY_PREWARM: mode }
  const server = await startFixtureServer({ '/one': '<!doctype html><meta charset="utf-8"><title>第一个页面</title><h1>第一个页面</h1>' })
  const profilePath = mkdtempSync(join(tmpdir(), 'bao-nav-probe-'))
  const app = await electron.launch({
    executablePath,
    args: [resolve(__dirname, '..'), `--user-data-dir=${profilePath}`],
    env,
    timeout: 20_000
  })
  try {
    const shell = app.windows().find((page) => page.url().endsWith('/out/renderer/index.html')) ??
      await app.waitForEvent('window', { predicate: (page) => page.url().endsWith('/out/renderer/index.html') })
    shell.setDefaultTimeout(10_000)
    await shell.waitForSelector('.gear-button')

    const overlayIds = () => app.evaluate(({ webContents }) => webContents.getAllWebContents()
      .filter((item) => { try { return item.getURL().includes('baoOverlay=overlay') } catch { return false } })
      .map((item) => item.id))

    // 等常驻预热落地（always 档）或干脆不等（auto 档）。
    const warmed = await Promise.race([
      waitFor(async () => ((await overlayIds()).length ? true : null), { timeout: 6_000, message: '没有预热' })
        .then(() => true).catch(() => false),
      sleep(1).then(() => false)
    ])
    console.log(`模式=${mode}，浮层文档已建=${warmed}，ids=${JSON.stringify(await overlayIds())}`)

    console.log('\n[1] 导航之前:', JSON.stringify(await snapshot(shell)))

    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.click()
    await address.fill(`${server.baseUrl}/one`)
    console.log('[2] fill 之后输入框:', await address.inputValue())

    await address.press('Enter')
    for (let i = 0; i < 12; i += 1) {
      await sleep(250)
      const state = await snapshot(shell)
      console.log(`[3.${i}] ${JSON.stringify(state)}`)
      if (state.active && String(state.active.address).includes('/one')) break
    }

    const contents = await app.evaluate(({ webContents }) => webContents.getAllWebContents().map((item) => {
      try {
        return { id: item.id, url: item.getURL().replace(/^.*\//, ''), crashed: item.isCrashed(), loading: item.isLoading() }
      } catch (error) { return { error: String(error.message) } }
    }))
    console.log('\n[4] 全部 webContents:', JSON.stringify(contents))
  } finally {
    await app.close().catch(() => {})
    await server.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
