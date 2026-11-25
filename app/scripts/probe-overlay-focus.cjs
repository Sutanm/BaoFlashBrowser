/**
 * 探针：共享飞窗的 `window.open` 到底动了什么焦点状态。
 *
 * 背景：docs/discussions/2026-11-25-overlay-shared-process-demo.md 的「当前待决 1」——
 * 常驻预热被实测挡回，理由是「启动后空闲时建文档会抢焦点、吞掉用户正在敲的键」。
 * 要判它可不可修，先得知道焦点丢在哪一层：
 *
 *   ① OS 窗口激活（BrowserWindow.getFocusedWindow / isFocused）
 *   ② WebContents 焦点（webContents.getFocusedWebContents）
 *   ③ 文档内焦点（document.hasFocus / activeElement）——决定按键还进不进输入框
 *
 * 用法（前台，会显示窗口）：
 *   $env:ELECTRON_EXEC_PATH=(Resolve-Path '.runtime\win-x64\electron.exe').Path
 *   node scripts/probe-overlay-focus.cjs
 */
const { mkdtempSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { _electron: electron } = require('playwright')

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function focusState(app, shell, label) {
  const main = await app.evaluate(({ BrowserWindow, webContents }) => {
    const win = BrowserWindow.getFocusedWindow()
    const contents = webContents.getFocusedWebContents()
    return {
      focusedWindow: win ? win.id : null,
      focusedContents: contents ? contents.id : null,
      focusedContentsUrl: contents ? contents.getURL().replace(/^.*[\\/]/, '') : null,
      windows: BrowserWindow.getAllWindows().map((item) => ({
        id: item.id,
        visible: item.isVisible(),
        focused: item.isFocused(),
        contents: item.webContents.id
      })),
      contents: webContents.getAllWebContents().map((item) => ({
        id: item.id,
        focused: item.isFocused(),
        url: item.getURL().includes('baoOverlay') ? 'overlay' : item.getURL().replace(/^.*[\\/]/, '')
      }))
    }
  })
  const page = await shell.evaluate(() => ({
    hasFocus: document.hasFocus(),
    active: document.activeElement
      ? document.activeElement.getAttribute('aria-label') || document.activeElement.tagName
      : null,
    value: document.activeElement && 'value' in document.activeElement
      ? document.activeElement.value
      : null
  }))
  console.log(`\n=== ${label} ===`)
  console.log('main :', JSON.stringify(main))
  console.log('shell:', JSON.stringify(page))
  return { main, page }
}

async function main() {
  delete process.env.ELECTRON_RUN_AS_NODE
  const executablePath = process.env.ELECTRON_EXEC_PATH
  if (!executablePath) throw new Error('请设置 ELECTRON_EXEC_PATH')
  const profilePath = mkdtempSync(join(tmpdir(), 'bao-focus-probe-'))
  const app = await electron.launch({
    executablePath,
    args: [resolve(__dirname, '..'), `--user-data-dir=${profilePath}`],
    timeout: 20_000
  })
  try {
    const shell = app.windows().find((page) => page.url().endsWith('/out/renderer/index.html')) ??
      await app.waitForEvent('window', { predicate: (page) => page.url().endsWith('/out/renderer/index.html') })
    shell.setDefaultTimeout(10_000)
    await shell.waitForSelector('.gear-button')

    // 把焦点放到地址栏，模拟「用户正在输入」。
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.click()
    await address.fill('')
    await sleep(150)
    await focusState(app, shell, '基线：地址栏已聚焦')

    // 真实路径：悬停齿轮 → 180 ms 悬停意图 → 外壳自己 window.open 浮层文档。
    await shell.getByRole('button', { name: '快捷设置', exact: true }).hover()
    const opened = Date.now()
    let overlay
    for (let i = 0; i < 60; i += 1) {
      overlay = await app.evaluate(({ webContents }) =>
        webContents.getAllWebContents().find((item) => item.getURL().includes('baoOverlay=overlay'))?.id ?? null)
      if (overlay) break
      await sleep(50)
    }
    console.log(`\n浮层 webContents 出现：${overlay ? `id=${overlay}，${Date.now() - opened} ms` : '没有出现（预热未触发？）'}`)
    await sleep(600)
    await focusState(app, shell, '悬停预热之后')

    // 吞键判定：地址栏应该仍然接收按键。
    await address.click()
    await address.type('abc', { delay: 30 })
    const typed = await address.inputValue()
    console.log(`\n=== 吞键判定 ===\n地址栏输入后得到: ${JSON.stringify(typed)}（期望 "abc"）`)
    await focusState(app, shell, '输入之后')
  } finally {
    await app.close().catch(() => {})
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
