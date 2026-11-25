/**
 * 探针 8：**受控**开窗下的焦点时间线（探针 7 采样起点太晚，预热早已完成）。
 *
 * 做法：用 `BAO_OVERLAY_PREWARM=never` 启动（不自动预热），把焦点放进地址栏，
 * 在页面里 2 ms 采一次 `document.hasFocus()`，然后**手动**执行与 `openSharedOverlay()`
 * 完全相同的 `window.open(url, 'bao-overlay', 'width=600,height=520')`，
 * 同时主进程侧 10 ms 采一次 `getFocusedWebContents()`。
 *
 * 目的：确认"开窗瞬间外壳文档是否丢焦点"（丢焦点 = 这期间的按键全丢）。
 *
 * 用法：node scripts/probe-overlay-focus-controlled.cjs
 */
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { _electron: electron } = require('playwright')

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE
  const profilePath = mkdtempSync(join(tmpdir(), 'bao-focus-controlled-'))
  const app = await electron.launch({
    executablePath: process.env.ELECTRON_EXEC_PATH,
    args: [resolve(__dirname, '..'), `--user-data-dir=${profilePath}`],
    env: { ...process.env, BAO_OVERLAY_PREWARM: 'never' },
    timeout: 20_000
  })
  try {
    const shell = app.windows().find((page) => page.url().endsWith('/out/renderer/index.html')) ??
      await app.waitForEvent('window', { predicate: (page) => page.url().endsWith('/out/renderer/index.html') })
    shell.setDefaultTimeout(10_000)
    await shell.waitForSelector('.gear-button')
    await shell.getByRole('textbox', { name: '地址栏' }).click()

    const result = shell.evaluate(async () => {
      const url = new URL(location.href)
      url.search = '?baoOverlay=overlay'
      const samples = []
      const started = performance.now()
      const record = () => samples.push({
        t: Math.round(performance.now() - started),
        hasFocus: document.hasFocus(),
        active: document.activeElement
          ? document.activeElement.getAttribute('aria-label') || document.activeElement.tagName
          : null
      })
      const timer = setInterval(record, 2)
      record()
      await new Promise((done) => setTimeout(done, 30))
      const openedAt = Math.round(performance.now() - started)
      const proxy = window.open(url.href, 'bao-overlay', 'width=600,height=520')
      record()
      await new Promise((done) => setTimeout(done, 1_200))
      clearInterval(timer)
      return { openedAt, opened: Boolean(proxy), samples }
    })

    const mainSamples = (async () => {
      const samples = []
      const started = Date.now()
      while (Date.now() - started < 1_400) {
        samples.push(await app.evaluate(({ webContents }) => {
          const focused = webContents.getFocusedWebContents()
          const overlay = webContents.getAllWebContents().find((item) => {
            try { return item.getURL().includes('baoOverlay=overlay') } catch { return false }
          })
          return {
            focused: focused ? focused.id : null,
            focusedIsOverlay: Boolean(overlay && focused && focused.id === overlay.id),
            overlayPresent: Boolean(overlay),
            overlayLoading: overlay ? overlay.isLoading() : null
          }
        }))
        await sleep(10)
      }
      return samples
    })()

    const page = await result
    const main = await mainSamples
    console.log(`window.open 调用时刻 t≈${page.openedAt} ms，返回 ${page.opened}`)

    console.log('\n页面侧（只在变化时打印）：')
    let previous
    for (const sample of page.samples) {
      const key = `${sample.hasFocus}|${sample.active}`
      if (key === previous) continue
      previous = key
      const mark = sample.t >= page.openedAt - 4 && sample.t <= page.openedAt + 8 ? '  ← 开窗前后' : ''
      console.log('  ', JSON.stringify(sample), mark)
    }

    console.log('\n主进程侧（只在变化时打印）：')
    let previousMain
    for (let i = 0; i < main.length; i += 1) {
      const sample = main[i]
      const key = `${sample.focused}|${sample.focusedIsOverlay}|${sample.overlayPresent}|${sample.overlayLoading}`
      if (key === previousMain) continue
      previousMain = key
      console.log('  ', JSON.stringify({ t: i * 10, ...sample }))
    }

    const lost = page.samples.filter((sample) => !sample.hasFocus)
    console.log(`\n失去文档焦点的采样点数：${lost.length}（共 ${page.samples.length}）`)
    if (lost.length) {
      const first = lost[0]
      const last = lost[lost.length - 1]
      console.log(`丢失区间 t≈${first.t}–${last.t} ms（相对开窗调用 ${page.openedAt} ms）`)
      console.log('  丢失期间的焦点元素：', JSON.stringify([...new Set(lost.map((s) => s.active))]))
    }
  } finally {
    await app.close().catch(() => {})
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
