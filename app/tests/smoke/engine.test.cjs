const assert = require('node:assert/strict')
const { test } = require('node:test')
const { launchApp, page, startFixtureServer, waitFor } = require('./helpers.cjs')

async function snapshot(shell) {
  const result = await shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' }))
  assert.equal(result.ok, true)
  return result.state
}

async function navigate(shell, url, title) {
  const address = shell.getByRole('textbox', { name: '地址栏' })
  await address.waitFor()
  await address.fill(url)
  await address.press('Enter')
  if (title) await shell.getByRole('button', { name: title, exact: true }).waitFor({ timeout: 30_000 })
}

function activeTabOf(state) {
  return state.tabs.find((tab) => tab.id === state.activeId)
}

test('引擎切换保留导航栈，Ruffle 接管 SWF，站点规则可复用', { timeout: 240_000 }, async () => {
  const server = await startFixtureServer({
    '/one': page('第一个页面'),
    '/two': page('第二个页面')
  })
  const { app, shell, close } = await launchApp()
  try {
    await navigate(shell, `${server.baseUrl}/one`, '第一个页面')
    await navigate(shell, `${server.baseUrl}/two`, '第二个页面')

    let state = await snapshot(shell)
    assert.equal(activeTabOf(state).engine, 'ppapi')
    assert.equal(activeTabOf(state).engineSource, 'default')

    // 切到 Ruffle：新 WebContents，地址与导航栈保留。
    await shell.getByRole('switch', { name: '切换到 Ruffle 引擎', exact: true }).click()
    state = await waitFor(async () => {
      const next = await snapshot(shell)
      return activeTabOf(next).engine === 'ruffle' ? next : null
    }, { message: '未切到 Ruffle 引擎。' })
    assert.equal(activeTabOf(state).engineSource, 'manual')
    assert.ok(activeTabOf(state).address.endsWith('/two'), `切换后地址丢失：${activeTabOf(state).address}`)
    assert.equal(activeTabOf(state).canGoBack, true, '切换后导航栈未恢复')

    // Ruffle 运行时注入页面主世界（版本固定），并 polyfill 页面里的 <embed>。
    const windowHandle = await app.browserWindow(shell)
    const runtime = await waitFor(async () => {
      const facts = await windowHandle.evaluate(async (window) => {
        const view = window.contentView.children
          .find((child) => child.webContents && child.webContents !== window.webContents)
        return view.webContents.executeJavaScript(`({
          newest: typeof window.RufflePlayer?.newest,
          version: window.RufflePlayer?.version ?? null
        })`)
      })
      return facts.newest === 'function' ? facts : null
    }, { message: 'Ruffle 运行时未注入。' })
    assert.equal(runtime.newest, 'function')

    await navigate(shell, `${server.baseUrl}/flash.html`)
    const polyfill = await waitFor(async () => {
      const facts = await windowHandle.evaluate(async (window) => {
        const view = window.contentView.children
          .find((child) => child.webContents && child.webContents !== window.webContents)
        return view.webContents.executeJavaScript(`(() => {
          const player = document.querySelector('ruffle-embed, ruffle-object, ruffle-player')
          return {
            players: document.querySelectorAll('ruffle-embed, ruffle-object, ruffle-player').length,
            remaining: document.querySelectorAll('embed').length,
            id: document.getElementById('flash')?.tagName ?? null,
            // 只有 WASM 真的加载成功，Ruffle 才会在 shadow root 里创建播放器画布。
            // 只断言元素存在会在 Ruffle 报错（例如非法 publicPath）时误判通过。
            canvas: Boolean(player?.shadowRoot?.querySelector('canvas'))
          }
        })()`)
      })
      return facts.players > 0 && facts.canvas ? facts : null
    }, { message: 'Ruffle 未接管 <embed>（或播放器未初始化）。' })
    assert.ok(polyfill.players >= 1)
    assert.equal(polyfill.remaining, 0, '原 <embed> 未被替换')
    assert.equal(polyfill.id, 'RUFFLE-EMBED', 'polyfill 丢了元素 id')
    assert.equal(polyfill.canvas, true, 'Ruffle 播放器画布未创建（WASM 未加载）')

    // 记住站点：站点规则生效。
    await shell.getByRole('button', { name: '记住此站点', exact: true }).click()
    state = await waitFor(async () => {
      const next = await snapshot(shell)
      return activeTabOf(next).engineSource === 'site-rule' ? next : null
    }, { message: '未记入站点规则。' })

    // 新标签打开同站点：自动使用 Ruffle。
    await shell.getByRole('button', { name: '新建标签页', exact: true }).click()
    await navigate(shell, `${server.baseUrl}/one`, '第一个页面')
    state = await snapshot(shell)
    assert.equal(activeTabOf(state).engine, 'ruffle', '站点规则未决定初始引擎')
    assert.equal(activeTabOf(state).engineSource, 'site-rule')
  } finally {
    await close()
    await server.close()
  }
})
