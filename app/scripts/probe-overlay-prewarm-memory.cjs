/**
 * 探针 9：`overlay.prewarm` 改默认（`auto` → `always`）的内存代价。
 *
 * 口径与 docs/discussions 2026-11-25 §5.1 一致：`app.getAppMetrics()` 的 workingSetSize
 * 与 privateBytes，按进程类型拆开（`Tab` 就是各 WebContents 的渲染进程）。
 *
 * 为什么对跑：内存受 GC/第一次绘制影响，单次采样噪声能到几 MB。这里 `always` / `never`
 * 交替各跑两轮，取每档的中位数，差值才是"常驻一份浮层文档"的真实价格。
 *
 * 必须前台跑：隐藏/后台自动化模式下 `canPrewarm()` 为 false，`always` 不会建文档。
 *
 * 用法：node scripts/probe-overlay-prewarm-memory.cjs
 */
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { _electron: electron } = require('playwright')

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const SAMPLE = (app) => app.evaluate(({ app: electronApp }) => {
  const rows = electronApp.getAppMetrics()
  const byType = {}
  let totalWs = 0
  let totalPrivate = 0
  for (const row of rows) {
    const ws = (row.memory && row.memory.workingSetSize ? row.memory.workingSetSize : 0) / 1024
    const priv = (row.memory && row.memory.privateBytes ? row.memory.privateBytes : 0) / 1024
    totalWs += ws
    totalPrivate += priv
    const slot = byType[row.type] || (byType[row.type] = { n: 0, ws: 0, private: 0 })
    slot.n += 1
    slot.ws += ws
    slot.private += priv
  }
  const round = (value) => Math.round(value * 10) / 10
  return {
    totalWs: round(totalWs),
    totalPrivate: round(totalPrivate),
    renderers: byType.Tab ? byType.Tab.n : 0,
    rendererWs: round(byType.Tab ? byType.Tab.ws : 0),
    rendererPrivate: round(byType.Tab ? byType.Tab.private : 0),
    browserWs: round(byType.Browser ? byType.Browser.ws : 0),
    procs: rows.length
  }
})

async function measure(mode, label) {
  const profilePath = mkdtempSync(join(tmpdir(), 'bao-mem-probe-'))
  const app = await electron.launch({
    executablePath: process.env.ELECTRON_EXEC_PATH,
    args: [resolve(__dirname, '..'), `--user-data-dir=${profilePath}`],
    env: { ...process.env, BAO_OVERLAY_PREWARM: mode },
    timeout: 20_000
  })
  try {
    const shell = app.windows().find((page) => page.url().endsWith('/out/renderer/index.html')) ??
      await app.waitForEvent('window', { predicate: (page) => page.url().endsWith('/out/renderer/index.html') })
    await shell.waitForSelector('.gear-button')
    // 等启动期抖动过去（首帧、GC、guest 文档加载）。
    await sleep(6_000)
    const early = await SAMPLE(app)
    await sleep(14_000)
    const settled = await SAMPLE(app)
    const overlay = await app.evaluate(({ webContents }) => webContents.getAllWebContents()
      .filter((item) => { try { return item.getURL().includes('baoOverlay=overlay') } catch { return false } }).length)
    console.log(`${label} 文档数=${overlay}  6s=${JSON.stringify(early)}  20s=${JSON.stringify(settled)}`)
    return settled
  } finally {
    await app.close().catch(() => {})
  }
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE
  const runs = { never: [], always: [] }
  // 交替跑，抵消机器状态的漂移。
  for (let round = 0; round < 2; round += 1) {
    runs.never.push(await measure('never', `[never  round${round + 1}]`))
    runs.always.push(await measure('always', `[always round${round + 1}]`))
  }
  const pick = (mode, key) => median(runs[mode].map((sample) => sample[key]))
  console.log('\n=== 中位数（20 s 稳定后） ===')
  for (const key of ['totalWs', 'totalPrivate', 'rendererWs', 'rendererPrivate', 'browserWs', 'renderers', 'procs']) {
    const never = pick('never', key)
    const always = pick('always', key)
    const delta = Math.round((always - never) * 10) / 10
    console.log(`${key.padEnd(16)} never=${String(never).padStart(7)}  always=${String(always).padStart(7)}  Δ=${delta > 0 ? '+' : ''}${delta}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
