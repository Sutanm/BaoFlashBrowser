/**
 * 探针 10：共享进程下「浮层里的长任务」对外壳的实际影响。
 *
 * 已知（docs §5.5）：浮层跑 400 ms 同步忙循环时，外壳一次 `evaluate` 往返 3 → 333 ms。
 * 这里把它翻译成**用户可感知的量**，并顺便验证兜底路径：
 *
 *   ① 外壳自己的 IPC 往返（`baoBrowser.run({snapshot})`，产品真实路径）
 *   ② 外壳的 rAF 帧间隔（掉帧数；16.7 ms 是满帧，>100 ms 是人眼可感的卡顿）
 *   ③ 卡住期间按 Esc 还能不能关掉浮层（`before-input-event` 在主进程处理，不经过渲染层）
 *   ④ 对照：同样的忙循环放在独立进程模式（`BAO_OVERLAY_SHARED=0`）下，外壳是否无感
 *
 * 用法：node scripts/probe-overlay-longtask.cjs            # 共享进程（默认）
 *       node scripts/probe-overlay-longtask.cjs isolated   # 独立进程对照
 */
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { _electron: electron } = require('playwright')

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const BUSY_MS = 400
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

async function roundTrip(shell) {
  const started = Date.now()
  await shell.evaluate(async () => { await window.baoBrowser.run({ type: 'snapshot' }) })
  return Date.now() - started
}

/** 采样 n 帧的间隔（在页面主线程上）；返回间隔数组。 */
function frameGaps(shell, count) {
  return shell.evaluate((total) => new Promise((done) => {
    const gaps = []
    let last = performance.now()
    const tick = () => {
      const now = performance.now()
      gaps.push(now - last)
      last = now
      if (gaps.length >= total) done(gaps)
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }), count)
}

async function main() {
  const isolated = process.argv[2] === 'isolated'
  delete process.env.ELECTRON_RUN_AS_NODE
  const profilePath = mkdtempSync(join(tmpdir(), 'bao-longtask-'))
  const app = await electron.launch({
    executablePath: process.env.ELECTRON_EXEC_PATH,
    args: [resolve(__dirname, '..'), `--user-data-dir=${profilePath}`],
    env: { ...process.env, BAO_OVERLAY_SHARED: isolated ? '0' : '1', BAO_OVERLAY_PREWARM: 'always' },
    timeout: 20_000
  })
  try {
    const shell = app.windows().find((page) => page.url().endsWith('/out/renderer/index.html')) ??
      await app.waitForEvent('window', { predicate: (page) => page.url().endsWith('/out/renderer/index.html') })
    shell.setDefaultTimeout(10_000)
    const gear = shell.getByRole('button', { name: '快捷设置', exact: true })
    await gear.waitFor({ timeout: 30_000 })
    await sleep(1_200)

    const overlayId = () => app.evaluate(({ webContents }) => {
      const found = webContents.getAllWebContents().find((item) => {
        try { return item.getURL().includes('baoOverlay=overlay') } catch { return false }
      })
      return found ? found.id : null
    })
    const id = await overlayId()
    if (!id) throw new Error('浮层文档不存在（预热没生效？）')

    // 走真实用户路径打开浮层（齿轮点击），并等视图真的挂上——`setQuick` 直调会绕过
    // 「文档 ready 前不挂载」的等待，测不出真实状态。
    const opened = await gear.click().then(() => true, () => false)
    const viewState = () => app.evaluate(({ BrowserWindow }, payload) => {
      const win = BrowserWindow.getAllWindows()[0]
      const view = win.contentView.children.find((child) => child.webContents?.id === payload.id)
      return view ? { attached: true, visible: view.getVisible() } : { attached: false, visible: false }
    }, { id })
    let shown = { attached: false, visible: false }
    for (let i = 0; i < 40; i += 1) {
      shown = await viewState()
      if (shown.visible) break
      await sleep(50)
    }
    console.log(`打开浮层: click=${opened} 视图=${JSON.stringify(shown)}`)

    // --- 基线 ---
    const baseTrips = []
    for (let i = 0; i < 5; i += 1) baseTrips.push(await roundTrip(shell))
    const baseGaps = await frameGaps(shell, 30)

    // --- 浮层里跑 400 ms 同步忙循环（立即开始，不再留延迟，确保采样落在阻塞期内）---
    const injectBusy = () => app.evaluate(({ webContents }, payload) => {
      const target = webContents.fromId(payload.id)
      if (!target || target.isDestroyed()) throw new Error('浮层已销毁')
      // 不 await：这段脚本自己会把渲染进程主线程占满 payload.ms 毫秒。
      void target.executeJavaScript(
        `(() => { const t = Date.now(); while (Date.now() - t < ${payload.ms}) {} })()`)
      return true
    }, { id, ms: BUSY_MS })

    const busyTrips = []
    const gapsPromise = frameGaps(shell, 45)
    await injectBusy()
    for (let i = 0; i < 6; i += 1) busyTrips.push(await roundTrip(shell))
    const busyGaps = await gapsPromise

    // --- 卡住期间按 Esc：主进程路径应当仍然能把浮层关掉 ---
    await injectBusy()
    await sleep(100)
    const beforeVisible = await viewState()
    await app.evaluate(({ webContents }) => {
      const shellContents = webContents.getAllWebContents()
        .find((item) => { try { return item.getURL().endsWith('/out/renderer/index.html') } catch { return false } })
      shellContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      shellContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    })
    await sleep(250)
    const afterVisible = await viewState()
    const closedDuringStall = { beforeVisible, afterVisible }

    const report = (label, trips, gaps) => {
      const worst = Math.max(...gaps)
      const stalled = gaps.filter((gap) => gap > 100).length
      console.log(`${label}: IPC 往返 中位=${median(trips)}ms 最大=${Math.max(...trips)}ms | ` +
        `帧间隔 中位=${Math.round(median(gaps))}ms 最大=${Math.round(worst)}ms | >100ms 的帧=${stalled}/${gaps.length}`)
    }
    console.log(`\n模式=${isolated ? '独立进程' : '共享进程（默认）'}，浮层忙循环 ${BUSY_MS} ms\n`)
    report('空闲  ', baseTrips, baseGaps)
    report('忙循环', busyTrips, busyGaps)
    console.log(`Esc 关窗（卡住期间）: 之前 ${JSON.stringify(closedDuringStall.beforeVisible)} → 之后 ${JSON.stringify(closedDuringStall.afterVisible)}`)
  } finally {
    await app.close().catch(() => {})
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
