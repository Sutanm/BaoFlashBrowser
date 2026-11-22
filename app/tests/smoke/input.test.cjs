const assert = require('node:assert/strict')
const { test } = require('node:test')
const { launchApp, page, startFixtureServer, waitFor } = require('./helpers.cjs')

async function viewHandle(app, shell) {
  return app.browserWindow(shell)
}

async function viewId(app, shell) {
  const handle = await viewHandle(app, shell)
  return handle.evaluate((window) =>
    window.contentView.children
      .find((child) => child.webContents && child.webContents !== window.webContents).webContents.id)
}

async function viewEval(app, shell, code) {
  const handle = await viewHandle(app, shell)
  return handle.evaluate((window, source) => {
    const view = window.contentView.children
      .find((child) => child.webContents && child.webContents !== window.webContents)
    return view.webContents.executeJavaScript(source)
  }, code)
}

/** 走真实输入路径：`webContents.sendInputEvent`（Playwright 的 page.keyboard 进不了 WCV）。 */
async function typeInView(app, id, text, { ascii = true } = {}) {
  await app.evaluate(({ webContents }, payload) => {
    const target = webContents.fromId(payload.id)
    if (!target) throw new Error('页面视图不存在')
    for (const char of payload.text) {
      if (payload.ascii) target.sendInputEvent({ type: 'keyDown', keyCode: char })
      target.sendInputEvent({ type: 'char', keyCode: char })
      if (payload.ascii) target.sendInputEvent({ type: 'keyUp', keyCode: char })
    }
  }, { id, text, ascii })
}

test('输入回环：页面键盘、IME 组合、焦点交接与 F11 全屏', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({ '/input': page('输入页面') })
  const { app, shell, close } = await launchApp()
  try {
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${server.baseUrl}/input`)
    await address.press('Enter')
    await shell.getByRole('button', { name: '输入页面', exact: true }).waitFor({ timeout: 30_000 })
    const id = await viewId(app, shell)

    await viewEval(app, shell, `(() => {
      window.__events = []
      const input = document.querySelector('input')
      input.value = ''
      input.addEventListener('compositionstart', () => window.__events.push('compositionstart'))
      input.addEventListener('compositionupdate', () => window.__events.push('compositionupdate'))
      input.addEventListener('compositionend', () => window.__events.push('compositionend'))
      input.addEventListener('keydown', (event) => window.__events.push('key:' + event.key))
      input.focus()
      return document.hasFocus()
    })()`)

    // 1) 普通 ASCII 输入进页面
    await typeInView(app, id, 'abc')
    assert.equal(await viewEval(app, shell, "document.querySelector('input').value"), 'abc')

    // 2) 非 ASCII 字符（char 事件）进页面
    await typeInView(app, id, '中文', { ascii: false })
    assert.equal(await viewEval(app, shell, "document.querySelector('input').value"), 'abc中文')

    // 3) IME 组合输入：composition 事件与提交文本都到达页面
    await app.evaluate(async ({ webContents }, viewIdValue) => {
      const target = webContents.fromId(viewIdValue)
      target.debugger.attach('1.3')
      try {
        await target.debugger.sendCommand('Input.imeSetComposition', {
          text: 'pinyin', selectionStart: 6, selectionEnd: 6
        })
        await target.debugger.sendCommand('Input.insertText', { text: '拼音' })
      } finally {
        target.debugger.detach()
      }
    }, id)
    const afterIme = await waitFor(async () => {
      const facts = await viewEval(app, shell, `({
        value: document.querySelector('input').value,
        events: window.__events.slice()
      })`)
      return facts.events.includes('compositionend') ? facts : null
    }, { message: 'IME 组合事件未到达页面。' })
    assert.ok(afterIme.value.endsWith('拼音'), `IME 提交文本丢失：${afterIme.value}`)
    assert.ok(afterIme.events.includes('compositionstart'), '缺少 compositionstart')
    assert.ok(afterIme.events.includes('compositionupdate'), '缺少 compositionupdate')

    // 4) 不带 Ctrl 的普通字母不能被标签快捷键吃掉
    const tabsBefore = await shell.locator('.tab').count()
    await typeInView(app, id, 't')
    assert.ok((await viewEval(app, shell, "document.querySelector('input').value")).endsWith('t'))
    assert.equal(await shell.locator('.tab').count(), tabsBefore, '普通字母被当成了标签快捷键')

    // 5) 焦点交接：地址栏与页面互不串台
    await address.fill('')
    await shell.keyboard.type('addr')
    assert.equal(await address.inputValue(), 'addr')
    await app.evaluate(({ webContents }, viewIdValue) => webContents.fromId(viewIdValue).focus(), id)
    await typeInView(app, id, 'Z')
    assert.ok((await viewEval(app, shell, "document.querySelector('input').value")).endsWith('Z'))
    assert.equal(await address.inputValue(), 'addr', '页面输入污染了地址栏')

    // 6) F11 全屏：视图跟随内容区，Esc 退出
    const chromeHeight = await shell.evaluate(() =>
      document.querySelector('header').getBoundingClientRect().height)
    const windowHandle = await viewHandle(app, shell)
    await app.evaluate(({ webContents }, viewIdValue) =>
      webContents.fromId(viewIdValue).sendInputEvent({ type: 'keyDown', keyCode: 'F11' }), id)
    await waitFor(() => windowHandle.evaluate((window) => window.isFullScreen()), {
      message: 'F11 未进入全屏。'
    })
    const fullscreen = await windowHandle.evaluate((window) => {
      const view = window.contentView.children
        .find((child) => child.webContents && child.webContents !== window.webContents)
      return { size: window.getContentSize(), bounds: view.getBounds() }
    })
    assert.deepEqual(fullscreen.bounds, {
      x: 0,
      y: chromeHeight,
      width: fullscreen.size[0],
      height: fullscreen.size[1] - chromeHeight
    })

    await app.evaluate(({ webContents }, viewIdValue) =>
      webContents.fromId(viewIdValue).sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }), id)
    await waitFor(async () => !(await windowHandle.evaluate((window) => window.isFullScreen())), {
      message: 'Esc 未退出全屏。'
    })
  } finally {
    await close()
    await server.close()
  }
})
