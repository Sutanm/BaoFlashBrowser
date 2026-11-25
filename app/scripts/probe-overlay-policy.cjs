/**
 * 探针 3：`overlay.prewarm` 三档在**共享进程模式**下的真实行为。
 *
 * 三档的合同（改前：三档行为完全一致，never 也照样悬停即建、建完也不回收）：
 *   auto   悬停 180 ms 预热；隐藏后空闲 RETIRE_AFTER_MS 回收，下次再建
 *   always 启动后空闲即建、一直热着（第一次点开就是热的），不回收
 *   never  悬停/启动都不建；只有点击（或 toast）才建
 *
 * 每一档都验到底：文档有没有被建、视图是不是隐藏态、点击能不能打开、回收后能不能重开。
 *
 * 用法：
 *   $env:ELECTRON_EXEC_PATH=(Resolve-Path '.runtime\win-x64\electron.exe').Path
 *   node scripts/probe-overlay-policy.cjs            # 三档全跑
 *   node scripts/probe-overlay-policy.cjs auto       # 只跑一档
 */
const assert = require('node:assert/strict')
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { _electron: electron } = require('playwright')

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function waitFor(predicate, { timeout = 15_000, interval = 100, message = '超时' } = {}) {
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
    if (Date.now() >= deadline) throw lastError ?? new Error(message)
    await sleep(interval)
  }
}

async function launch(env = {}) {
  delete process.env.ELECTRON_RUN_AS_NODE
  const executablePath = process.env.ELECTRON_EXEC_PATH
  if (!executablePath) throw new Error('请设置 ELECTRON_EXEC_PATH')
  const profilePath = mkdtempSync(join(tmpdir(), 'bao-overlay-policy-'))
  const saved = {}
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
  const app = await electron.launch({
    executablePath,
    args: [resolve(__dirname, '..'), `--user-data-dir=${profilePath}`],
    timeout: 20_000
  })
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const shell = app.windows().find((page) => page.url().endsWith('/out/renderer/index.html')) ??
    await app.waitForEvent('window', { predicate: (page) => page.url().endsWith('/out/renderer/index.html') })
  shell.setDefaultTimeout(10_000)
  await shell.waitForSelector('.gear-button')
  return { app, shell }
}

/** 共享浮层的真实状态：存在 / 是否挂到窗口上 / 是否可见。 */
async function overlay(app) {
  return app.evaluate(({ BrowserWindow, webContents }) => {
    const win = BrowserWindow.getAllWindows()[0]
    let guest
    for (const item of webContents.getAllWebContents()) {
      try {
        if (item.getURL().includes('baoOverlay=overlay')) guest = item
      } catch { /* destroyed */ }
    }
    const view = guest ? win.contentView.children.find((child) => child.webContents?.id === guest.id) : undefined
    return {
      present: Boolean(guest),
      id: guest ? guest.id : null,
      attached: Boolean(view),
      visible: view ? view.getVisible() : false
    }
  })
}

async function runAuto() {
  const { app, shell } = await launch({ BAO_RETIRE_MS: '1500' })
  try {
    assert.equal((await overlay(app)).present, false, 'auto：启动后不该有浮层文档（等悬停）')

    await shell.getByRole('button', { name: '快捷设置', exact: true }).hover()
    const warmed = await waitFor(async () => {
      const state = await overlay(app)
      return state.present ? state : null
    }, { message: 'auto：悬停 180 ms 后应当预热出文档' })
    assert.equal(warmed.visible, false, 'auto：预热出来的视图必须是隐藏的')
    console.log(`auto：悬停预热 ✅（guest id=${warmed.id}，隐藏未挂载）`)

    await shell.getByRole('button', { name: '快捷设置', exact: true }).click()
    const opened = await waitFor(async () => {
      const state = await overlay(app)
      return state.visible ? state : null
    }, { message: 'auto：点击后应当显示浮层' })
    assert.equal(opened.id, warmed.id, 'auto：点击不该重开一个新文档（复用了预热的那个）')
    console.log('auto：点击复用预热的文档 ✅')

    // 关掉：点页面区域（外壳的 pointerdown 会关飞窗）。
    await shell.getByRole('textbox', { name: '地址栏' }).click()
    await waitFor(async () => !(await overlay(app)).visible, { message: 'auto：点击别处应当隐藏浮层' })
    const retired = await waitFor(async () => !(await overlay(app)).present, {
      timeout: 10_000, message: 'auto：隐藏后空闲 1.5 s 应当回收文档'
    })
    assert.equal(retired, true)
    console.log('auto：隐藏后按 RETIRE_AFTER_MS 回收 ✅')

    await shell.getByRole('button', { name: '快捷设置', exact: true }).hover()
    const reopened = await waitFor(async () => {
      const state = await overlay(app)
      return state.present ? state : null
    }, { message: 'auto：回收后再悬停应当重新预热' })
    assert.notEqual(reopened.id, warmed.id, 'auto：回收后应当是一个新文档')
    await shell.getByRole('button', { name: '快捷设置', exact: true }).click()
    await waitFor(async () => (await overlay(app)).visible, { message: 'auto：回收后点击仍应能打开' })
    console.log(`auto：回收 → 重新预热（id=${reopened.id}）→ 点击打开 ✅`)
  } finally {
    await app.close().catch(() => {})
  }
}

async function runNever() {
  const { app, shell } = await launch({ BAO_OVERLAY_PREWARM: 'never' })
  try {
    await shell.getByRole('button', { name: '快捷设置', exact: true }).hover()
    await sleep(1_200)
    assert.equal((await overlay(app)).present, false, 'never：悬停不该建文档')
    console.log('never：悬停 1.2 s 后仍然没有文档 ✅')

    await shell.getByRole('button', { name: '快捷设置', exact: true }).click()
    const opened = await waitFor(async () => {
      const state = await overlay(app)
      return state.visible ? state : null
    }, { message: 'never：点击仍应能打开（"不预热"不等于"不能用"）' })
    console.log(`never：点击冷开仍然可用 ✅（guest id=${opened.id}）`)
  } finally {
    await app.close().catch(() => {})
  }
}

async function runAlways() {
  const { app, shell } = await launch({ BAO_OVERLAY_PREWARM: 'always' })
  try {
    // 不碰任何入口：文档应当由"空闲预热"自己建出来。
    const warmed = await waitFor(async () => {
      const state = await overlay(app)
      return state.present ? state : null
    }, { timeout: 10_000, message: 'always：启动后空闲时应当常驻预热出文档' })
    assert.equal(warmed.visible, false, 'always：常驻预热不该显示视图')
    console.log(`always：启动后空闲预热 ✅（guest id=${warmed.id}，+6 MB 量级，未显示）`)

    const started = Date.now()
    await shell.getByRole('button', { name: '快捷设置', exact: true }).click()
    const opened = await waitFor(async () => {
      const state = await overlay(app)
      return state.visible ? state : null
    }, { message: 'always：点击后应当显示浮层' })
    assert.equal(opened.id, warmed.id, 'always：第一次点开就该复用常驻文档')
    console.log(`always：第一次点击 ${Date.now() - started} ms 内显示常驻文档 ✅`)

    await shell.getByRole('textbox', { name: '地址栏' }).click()
    await waitFor(async () => !(await overlay(app)).visible, { message: 'always：点击别处应当隐藏' })
    await sleep(1_500)
    assert.equal((await overlay(app)).present, true, 'always：常驻档不该回收文档')
    console.log('always：隐藏后仍常驻（不回收）✅')
  } finally {
    await app.close().catch(() => {})
  }
}

async function main() {
  const only = process.argv[2]
  const modes = [['auto', runAuto], ['never', runNever], ['always', runAlways]]
  for (const [name, run] of modes) {
    if (only && only !== name) continue
    console.log(`\n########## ${name} ##########`)
    await run()
  }
  console.log('\n全部通过。')
}

main().catch((error) => {
  console.error(`\n失败：${error.message}`)
  process.exit(1)
})
