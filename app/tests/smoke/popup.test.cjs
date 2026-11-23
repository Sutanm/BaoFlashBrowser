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

async function snapshot(shell) {
  const result = await shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' }))
  assert.equal(result.ok, true)
  return result.state
}

function pageWithButton(title, openUrl) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
    <button id="open" style="margin:8px;padding:8px 16px">进入</button>
    <script>document.getElementById('open').onclick = () => window.open(${JSON.stringify(openUrl)}, '_blank')</script>`
}

test('受控弹窗：同站开真实窗口并保留 window.opener，跨站与非 http(s) 拒绝', { timeout: 180_000 }, async () => {
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

    // 第一级：lobby → game。用真实窗口承载，不再是新标签。
    const [game] = await Promise.all([
      app.waitForEvent('window', { predicate: (page) => page.url().endsWith('/game'), timeout: 30_000 }),
      viewEval(app, shell, "document.getElementById('open').click()", true)
    ])
    // window.opener 是 Flash lobby→game 交接的常见通道，必须在。
    const openerFacts = await game.evaluate(() => ({
      hasOpener: Boolean(window.opener),
      openerUrl: window.opener?.location?.href ?? null
    }))
    assert.equal(openerFacts.hasOpener, true, '弹窗窗口丢失了 window.opener')
    assert.ok(String(openerFacts.openerUrl).endsWith('/lobby'), `opener 指向异常：${openerFacts.openerUrl}`)
    assert.equal((await snapshot(shell)).tabs.length, 1, '弹窗不应变成外壳里的新标签')

    // 第二级：弹窗再弹窗（142 报告里踩过的坑）。
    const [client] = await Promise.all([
      app.waitForEvent('window', { predicate: (page) => page.url().endsWith('/client'), timeout: 30_000 }),
      game.evaluate(() => document.getElementById('open').click())
    ])
    assert.ok((await client.evaluate(() => Boolean(window.opener))), '二级弹窗丢失 window.opener')
    assert.equal((await snapshot(shell)).tabs.length, 1)

    // 跨站：拒绝。
    await viewEval(app, shell, "window.open('https://example.invalid/', '_blank')", true)
    await new Promise((done) => setTimeout(done, 800))
    assert.equal((await snapshot(shell)).tabs.length, 1)

    // 非 http(s)：拒绝。
    await viewEval(app, shell, "window.open('file:///C:/Windows', '_blank')", true)
    await new Promise((done) => setTimeout(done, 800))
    assert.equal((await snapshot(shell)).tabs.length, 1)

    // 引擎继承：切到 Ruffle 后，弹窗窗口也要注入 Ruffle 引导。
    await shell.getByRole('switch', { name: '切换到 Ruffle 引擎', exact: true }).click()
    await waitFor(async () => {
      const state = await snapshot(shell)
      return state.tabs.find((tab) => tab.id === state.activeId)?.engine === 'ruffle' ? state : null
    }, { message: '未切到 Ruffle 引擎。' })
    const [rufflePopup] = await Promise.all([
      app.waitForEvent('window', { predicate: (page) => page.url().endsWith('/game'), timeout: 30_000 }),
      viewEval(app, shell, "document.getElementById('open').click()", true)
    ])
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
