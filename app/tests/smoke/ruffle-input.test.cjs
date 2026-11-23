const assert = require('node:assert/strict')
const { test } = require('node:test')
const { launchApp, startFixtureServer, waitFor } = require('./helpers.cjs')

const PLAYER_RECT = `(() => {
  const player = document.querySelector('ruffle-embed, ruffle-object, ruffle-player')
  const canvas = player?.shadowRoot?.querySelector('canvas')
  if (!canvas) return null
  const box = canvas.getBoundingClientRect()
  return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }
})()`

const PROBE = `typeof window.__probe === 'function' ? window.__probe() : 'no-probe'`

/**
 * Ruffle 引擎的画布键盘焦点（架构 §3 标签合同「键盘输入和 IME」）。
 *
 * 关键事实（2026-11-23 实测）：Ruffle 0.8 靠 `pointerdown` 把焦点交给播放器内部的容器，
 * 键盘事件才会进 SWF。`webContents.sendInputEvent({ type: 'mousedown' })` **不产生**
 * pointer 事件，所以必须用 CDP 的 `Input.dispatchMouseEvent` 才能复现真实点击；
 * 键盘仍走 `sendInputEvent`（与产品真实输入路径一致）。
 */
test('Ruffle 画布焦点：点击播放器后键盘事件进入 SWF', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer()
  const { app, shell, close } = await launchApp()
  try {
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${server.baseUrl}/keyprobe.html`)
    await address.press('Enter')
    await shell.getByRole('button', { name: '插件输入探针', exact: true }).waitFor({ timeout: 30_000 })
    await shell.getByRole('switch', { name: '切换到 Ruffle 引擎', exact: true }).click({ timeout: 30_000 })

    const handle = await app.browserWindow(shell)
    const viewEval = (code) => handle.evaluate((window, source) => {
      const view = window.contentView.children
        .find((child) => child.webContents && child.webContents !== window.webContents)
      return view.webContents.executeJavaScript(source)
    }, code)
    const sendKeys = (keys) => handle.evaluate((window, payload) => {
      const view = window.contentView.children
        .find((child) => child.webContents && child.webContents !== window.webContents)
      for (const keyCode of payload) {
        view.webContents.sendInputEvent({ type: 'keyDown', keyCode })
        view.webContents.sendInputEvent({ type: 'char', keyCode: keyCode.toLowerCase() })
        view.webContents.sendInputEvent({ type: 'keyUp', keyCode })
      }
    }, keys)

    const rect = await waitFor(async () => {
      const value = await viewEval(PLAYER_RECT)
      return value && value.y > 0 ? value : null
    }, { message: 'Ruffle 播放器画布未就位' })

    // 未点击：SWF 收不到键盘（Ruffle 的既有语义，记录下来避免误判为回归）。
    await sendKeys(['A'])
    await new Promise((done) => setTimeout(done, 400))
    assert.equal(await viewEval(PROBE), '', '未点击播放器时不应收到键盘事件')

    // 真实指针点击：让 playback 容器获得焦点。
    await handle.evaluate(async (window, point) => {
      const view = window.contentView.children
        .find((child) => child.webContents && child.webContents !== window.webContents)
      const contents = view.webContents
      contents.focus()
      contents.debugger.attach('1.3')
      try {
        await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
        await contents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      } finally {
        contents.debugger.detach()
      }
    }, rect)

    const focus = await waitFor(async () => {
      const value = await viewEval(`(() => {
        const player = document.querySelector('ruffle-embed, ruffle-object, ruffle-player')
        return {
          host: document.activeElement?.tagName ?? null,
          inner: player?.shadowRoot?.activeElement?.tagName ?? null
        }
      })()`)
      return value.host === 'RUFFLE-EMBED' && value.inner ? value : null
    }, { message: '点击后播放器未获得焦点' })
    assert.equal(focus.host, 'RUFFLE-EMBED')

    // 点击后：键盘进入 SWF（keyprobe 用 ExternalInterface 暴露 keyCode:charCode 列表）。
    await sendKeys(['A', 'S'])
    const received = await waitFor(async () => {
      const value = await viewEval(PROBE)
      return typeof value === 'string' && value.includes('65:97') && value.includes('83:115') ? value : null
    }, { message: '键盘事件未进入 Ruffle 的 SWF' })
    assert.ok(received.includes('65:97'), `未收到 A 键：${received}`)
    assert.ok(received.includes('83:115'), `未收到 S 键：${received}`)
  } finally {
    await close()
    await server.close()
  }
})
