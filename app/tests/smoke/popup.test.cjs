const assert = require('node:assert/strict')
const { test } = require('node:test')
const { launchApp, startFixtureServer, waitFor } = require('./helpers.cjs')

async function viewEval(app, shell, code, userGesture = false) {
  const handle = await app.browserWindow(shell)
  return handle.evaluate((window, payload) => {
    const view = window.contentView.children
      .find((child) => child.webContents && child.webContents !== window.webContents)
    return view.webContents.executeJavaScript(payload.code, payload.userGesture)
  }, { code, userGesture })
}

async function assertHiddenPopup(app, page) {
  if (process.env.BAO_SMOKE_HIDDEN !== '1') return
  const window = await app.browserWindow(page)
  assert.deepEqual(await window.evaluate((win) => [win.isVisible(), win.isFocusable(), win.isFocused()]),
    [false, false, false], '测试弹窗必须从创建起就保持隐藏且不可聚焦')
}

async function snapshot(shell) {
  const result = await shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' }))
  assert.equal(result.ok, true)
  return result.state
}

/** 原生窗口数：弹窗不进标签列表，负向断言必须直接看窗口被不被创建。 */
async function windowCount(app) {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
}

function pageWithButton(title, openUrl) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
    <button id="open" style="margin:8px;padding:8px 16px">进入</button>
    <script>document.getElementById('open').onclick = () => window.open(${JSON.stringify(openUrl)}, '_blank')</script>`
}

test('受控弹窗：同站开真实窗口、策略递归到子窗口、跨站与非 http(s) 拒绝', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({
    '/lobby': pageWithButton('大厅', '/game'),
    '/game': pageWithButton('游戏', '/client'),
    '/client': '<!doctype html><meta charset="utf-8"><title>客户端</title><h1>ok</h1>'
  })
  const { app, shell, close } = await launchApp()
  try {
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${server.baseUrl}/lobby`)
    await address.press('Enter')
    await shell.getByRole('button', { name: '大厅', exact: true }).waitFor({ timeout: 30_000 })
    assert.equal((await snapshot(shell)).tabs.length, 1)
    const baseWindows = await windowCount(app)

    // 第一级：lobby → game。真实窗口承载，保留 window.opener。
    const [game] = await Promise.all([
      app.waitForEvent('window', { predicate: (page) => page.url().endsWith('/game'), timeout: 30_000 }),
      viewEval(app, shell, "document.getElementById('open').click()", true)
    ])
    await assertHiddenPopup(app, game)
    const openerFacts = await game.evaluate(() => ({
      hasOpener: Boolean(window.opener),
      openerUrl: window.opener?.location?.href ?? null
    }))
    assert.equal(openerFacts.hasOpener, true, '弹窗窗口丢失了 window.opener')
    assert.ok(String(openerFacts.openerUrl).endsWith('/lobby'), `opener 指向异常：${openerFacts.openerUrl}`)
    assert.equal(await windowCount(app), baseWindows + 1)
    assert.equal((await snapshot(shell)).tabs.length, 1, '弹窗不应变成外壳里的新标签')

    // 第二级：弹窗再弹窗（策略必须递归到子窗口）。
    const [client] = await Promise.all([
      app.waitForEvent('window', { predicate: (page) => page.url().endsWith('/client'), timeout: 30_000 }),
      game.evaluate(() => document.getElementById('open').click())
    ])
    await assertHiddenPopup(app, client)
    assert.ok((await client.evaluate(() => Boolean(window.opener))), '二级弹窗丢失 window.opener')
    assert.equal(await windowCount(app), baseWindows + 2)

    // 跨站：从外壳拒绝，窗口数不变。
    await viewEval(app, shell, "window.open('https://example.invalid/', '_blank')", true)
    await new Promise((done) => setTimeout(done, 800))
    assert.equal(await windowCount(app), baseWindows + 2, '跨站弹窗被放行')

    // 跨站：从**子窗口**发起也必须拒绝（审计 P1-3 的核心断言）。
    await client.evaluate(() => { window.open('https://example.invalid/', '_blank') })
    await new Promise((done) => setTimeout(done, 800))
    assert.equal(await windowCount(app), baseWindows + 2, '子窗口未继承跨站拒绝策略')

    // 非 http(s)：外壳与子窗口都拒绝。
    await viewEval(app, shell, "window.open('file:///C:/Windows', '_blank')", true)
    await new Promise((done) => setTimeout(done, 800))
    assert.equal(await windowCount(app), baseWindows + 2, 'file: 弹窗被放行（外壳）')
    await client.evaluate(() => { window.open('file:///C:/Windows', '_blank') })
    await new Promise((done) => setTimeout(done, 800))
    assert.equal(await windowCount(app), baseWindows + 2, 'file: 弹窗被放行（子窗口）')

    // 引擎继承：切到 Ruffle 后，弹窗窗口同样注入 Ruffle 引导。
    await shell.getByRole('switch', { name: '切换到 Ruffle 引擎', exact: true }).click()
    await waitFor(async () => {
      const state = await snapshot(shell)
      return state.tabs.find((tab) => tab.id === state.activeId)?.engine === 'ruffle' ? state : null
    }, { message: '未切到 Ruffle 引擎。' })
    const [rufflePopup] = await Promise.all([
      app.waitForEvent('window', { predicate: (page) => page.url().endsWith('/game'), timeout: 30_000 }),
      viewEval(app, shell, "document.getElementById('open').click()", true)
    ])
    await assertHiddenPopup(app, rufflePopup)
    const inherited = await waitFor(async () => {
      const value = await rufflePopup.evaluate(() => typeof window.RufflePlayer?.newest)
      return value === 'function' ? value : null
    }, { message: 'Ruffle 引擎下的弹窗没有继承 Ruffle 引导。' })
    assert.equal(inherited, 'function')
  } finally {
    await close()
    await server.close()
  }
})
test('弹窗使用自绘 chrome：无原生边框，控制簇可用', { timeout: 120_000 }, async () => {
  const server = await startFixtureServer({
    '/lobby': pageWithButton('大厅', '/game'),
    '/game': '<!doctype html><meta charset="utf-8"><title>游戏</title><h1>game</h1>'
  })
  const { app, shell, close } = await launchApp()
  try {
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${server.baseUrl}/lobby`)
    await address.press('Enter')
    await shell.getByRole('button', { name: '大厅', exact: true }).waitFor({ timeout: 30_000 })
    const baseWindows = await windowCount(app)

    const [popup] = await Promise.all([
      app.waitForEvent('window', { predicate: (page) => page.url().endsWith('/game'), timeout: 30_000 }),
      viewEval(app, shell, "document.getElementById('open').click()", true)
    ])

    await assertHiddenPopup(app, popup)

    // 1) 无原生边框：frameless 窗口的 getBounds 与 getContentBounds 相同。
    const frames = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => ({
      url: window.webContents.getURL(),
      bounds: window.getBounds(),
      content: window.getContentBounds()
    })))
    const popupFrame = frames.find((item) => item.url.endsWith('/game'))
    assert.ok(popupFrame, '未找到弹窗窗口')
    // 1) 无原生标题栏：内容区尺寸应等于请求值（有标题栏时高度会被吃掉约 32px）；
    //    Windows 上可调整的无边框窗口仍带 1px 边框，允许 ≤2px 差额。
    assert.equal(popupFrame.content.width, 1024, '弹窗内容宽度不等于请求值')
    assert.equal(popupFrame.content.height, 768, '弹窗仍带原生标题栏（内容高度被吃掉）')
    assert.ok(popupFrame.bounds.width - popupFrame.content.width <= 2, '弹窗边框过宽（可能是原生帧）')
    assert.ok(popupFrame.bounds.height - popupFrame.content.height <= 2, '弹窗边框过宽（可能是原生帧）')

    // 2) 自绘控制簇存在，且拖动抓手确实声明了 app-region: drag。
    // chrome 视图是异步 loadURL 的，轮询到它加载完成再断言。
    const chrome = await waitFor(async () => {
      const value = await app.evaluate(async ({ webContents }) => {
        const target = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith('data:text/html'))
        if (!target || target.isLoading()) return null
        return target.executeJavaScript(`(() => {
          const grip = document.querySelector('.grip')
          if (!grip) return null
          return {
            hasClose: Boolean(document.getElementById('close')),
            gripRegion: getComputedStyle(grip).webkitAppRegion ?? getComputedStyle(grip).getPropertyValue('-webkit-app-region')
          }
        })()`)
      }).catch(() => null)
      return value && value.hasClose ? value : null
    }, { message: '弹窗没有 chrome 控制簇' })
    assert.ok(chrome, '弹窗没有 chrome 控制簇')
    assert.equal(chrome.hasClose, true)
    assert.equal(String(chrome.gripRegion).trim(), 'drag', '拖动抓手不是 app-region: drag')

    // 3) 关闭按钮生效：点自绘关闭，窗口数回落。
    await app.evaluate(async ({ webContents }) => {
      const target = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith('data:text/html'))
      await target.executeJavaScript(`document.getElementById('close').click()`)
    })
    await popup.waitForEvent('close', { timeout: 10_000 }).catch(() => {})
    const closed = await waitFor(async () => {
      const count = await windowCount(app)
      return count === baseWindows ? count : null
    }, { message: '自绘关闭按钮没有关闭弹窗' })
    assert.equal(closed, baseWindows)
  } finally {
    await close()
    await server.close()
  }
})
