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

test('受控弹窗：同站开新标签、跨站与非 http(s) 拒绝、引擎继承', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({
    '/lobby': pageWithButton('大厅', '/game'),
    '/game': pageWithButton('游戏', '/client'),
    '/client': pageWithButton('客户端', '/client2'),
    '/client2': '<!doctype html><meta charset="utf-8"><title>客户端二</title><h1>ok</h1>'
  })
  const { app, shell, close } = await launchApp()
  try {
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${server.baseUrl}/lobby`)
    await address.press('Enter')
    await shell.getByRole('button', { name: '大厅', exact: true }).waitFor({ timeout: 30_000 })
    assert.equal((await snapshot(shell)).tabs.length, 1)

    // 第一级：lobby → game
    await viewEval(app, shell, "document.getElementById('open').click()", true)
    const first = await waitFor(async () => {
      const next = await snapshot(shell)
      const active = next.tabs.find((tab) => tab.id === next.activeId)
      return next.tabs.length === 2 && active?.address.endsWith('/game') ? next : null
    }, { message: '同站弹窗未开新标签。' })
    assert.equal(first.tabs.length, 2)
    const firstPopupId = first.activeId

    // 第二级：game → client（弹窗再弹窗，142 报告里踩过的坑）
    await viewEval(app, shell, "document.getElementById('open').click()", true)
    const second = await waitFor(async () => {
      const next = await snapshot(shell)
      const active = next.tabs.find((tab) => tab.id === next.activeId)
      return next.tabs.length === 3 && active?.address.endsWith('/client') ? next : null
    }, { message: '二级弹窗未开新标签。' })
    assert.equal(new Set(second.tabs.map((tab) => tab.id)).size, 3, '标签业务 ID 必须唯一')
    let state = second

    // 引擎继承：切到 Ruffle 后，弹窗标签继续用 Ruffle
    await shell.getByRole('switch', { name: '切换到 Ruffle 引擎', exact: true }).click()
    await waitFor(async () => (await snapshot(shell)).tabs.find((tab) => tab.id === state.activeId)?.engine === 'ruffle',
      { message: '未切到 Ruffle 引擎。' })
    await viewEval(app, shell, "document.getElementById('open').click()", true)
    const third = await waitFor(async () => {
      const next = await snapshot(shell)
      const active = next.tabs.find((tab) => tab.id === next.activeId)
      return next.tabs.length === 4 && active?.address.endsWith('/client2') ? next : null
    }, { message: 'Ruffle 引擎下的弹窗未开新标签。' })
    state = third
    const popupTab = state.tabs.find((tab) => tab.id === state.activeId)
    assert.equal(popupTab.engine, 'ruffle', '弹窗未继承 opener 引擎')

    // 跨站：拒绝
    await viewEval(app, shell, "window.open('https://example.com/', '_blank')", true)
    await new Promise((done) => setTimeout(done, 800))
    assert.equal((await snapshot(shell)).tabs.length, 4, '跨站弹窗被放行了')

    // 非 http(s)：拒绝
    await viewEval(app, shell, "window.open('file:///C:/Windows', '_blank')", true)
    await new Promise((done) => setTimeout(done, 800))
    assert.equal((await snapshot(shell)).tabs.length, 4, 'file: 弹窗被放行了')

    // 被拒绝的弹窗不影响原标签
    const after = await snapshot(shell)
    assert.equal(after.activeId, popupTab.id)
    assert.ok(after.tabs.some((tab) => tab.id === firstPopupId))
  } finally {
    await close()
    await server.close()
  }
})
