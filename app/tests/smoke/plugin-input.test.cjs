const assert = require('node:assert/strict')
const { test } = require('node:test')
const { hasFlashPlugin, launchApp, startFixtureServer, waitFor } = require('./helpers.cjs')

async function viewId(app, shell) {
  const handle = await app.browserWindow(shell)
  return handle.evaluate((window) =>
    window.contentView.children
      .find((child) => child.webContents && child.webContents !== window.webContents).webContents.id)
}

async function viewEval(app, shell, code) {
  const handle = await app.browserWindow(shell)
  return handle.evaluate((window, source) => {
    const view = window.contentView.children
      .find((child) => child.webContents && child.webContents !== window.webContents)
    return view.webContents.executeJavaScript(source)
  }, code)
}

test('键盘事件进入 PPAPI 插件进程（插件内部输入回环）', { timeout: 120_000 }, async (context) => {
  if (!hasFlashPlugin()) {
    context.skip('未检测到 .runtime/win-x64/pepflashplayer64.dll（BYOP）：跳过插件输入用例。')
    return
  }
  const server = await startFixtureServer()
  const { app, shell, close } = await launchApp()
  try {
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${server.baseUrl}/keyprobe.html`)
    await address.press('Enter')
    await shell.getByRole('button', { name: '插件输入探针', exact: true }).waitFor({ timeout: 30_000 })
    const id = await viewId(app, shell)

    // 插件实例化 + ExternalInterface 回调就绪
    await waitFor(async () => (await viewEval(app, shell, 'window.__probeReady()')) === true, {
      message: '插件未就绪（keyProbe 回调不可用）。'
    })

    // 点击插件区域让它获得键盘焦点（Flash 需要显式聚焦），再送按键。
    await app.evaluate(({ webContents }, viewIdValue) => {
      const target = webContents.fromId(viewIdValue)
      target.sendInputEvent({ type: 'mouseDown', x: 200, y: 150, button: 'left', clickCount: 1 })
      target.sendInputEvent({ type: 'mouseUp', x: 200, y: 150, button: 'left', clickCount: 1 })
    }, id)
    await app.evaluate(({ webContents }, viewIdValue) => {
      const target = webContents.fromId(viewIdValue)
      for (const char of ['a', 'b']) {
        target.sendInputEvent({ type: 'keyDown', keyCode: char })
        target.sendInputEvent({ type: 'char', keyCode: char })
        target.sendInputEvent({ type: 'keyUp', keyCode: char })
      }
    }, id)

    const events = await waitFor(async () => {
      const value = await viewEval(app, shell, 'window.__probe()')
      return value && value !== 'unavailable' && value.length > 0 ? value : null
    }, { message: '插件没有收到键盘事件。' })

    // 形如 "65:97,66:98"：keyCode:charCode
    assert.match(events, /65:97/, `插件未收到 'a' 的 keydown：${events}`)
    assert.match(events, /66:98/, `插件未收到 'b' 的 keydown：${events}`)
  } finally {
    await close()
    await server.close()
  }
})
