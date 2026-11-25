const assert = require('node:assert/strict')
const { test } = require('node:test')
const { launchApp, startFixtureServer, waitFor } = require('./helpers.cjs')

async function run(shell, command) {
  const result = await shell.evaluate((payload) => window.baoBrowser.run(payload), command)
  assert.equal(result.ok, true, `命令失败：${command.type} ${result.code ?? ''}`)
  return result.state
}

/**
 * 在指定 WebContents 上求值。
 * 复制后源标签会从窗口的 contentView 里移出，只能按 id 通过 `webContents.fromId` 找回来。
 */
async function evalIn(app, id, code) {
  return app.evaluate(async ({ webContents }, payload) => {
    const contents = webContents.fromId(payload.id)
    if (!contents || contents.isDestroyed()) return null
    return contents.executeJavaScript(payload.code)
  }, { id, code })
}

/** Ruffle 是否真的接管了 <embed>：元素存在 + shadow root 里有 canvas（WASM 已加载）。 */
const RUFFLE_FACTS = `(() => {
  const player = document.querySelector('ruffle-embed, ruffle-object, ruffle-player')
  return {
    players: document.querySelectorAll('ruffle-embed, ruffle-object, ruffle-player').length,
    embeds: document.querySelectorAll('embed').length,
    canvas: Boolean(player?.shadowRoot?.querySelector('canvas')),
    version: window.RufflePlayer?.version ?? null
  }
})()`

async function activeView(app, shell) {
  const handle = await app.browserWindow(shell)
  return handle.evaluate((window) => {
    const views = window.contentView.children
      .filter((child) => child.webContents && child.webContents !== window.webContents)
      .filter((child) => !child.webContents.isDestroyed())
    const view = views[views.length - 1]
    if (!view) return null
    return { id: view.webContents.id, pid: view.webContents.getOSProcessId() }
  })
}

/**
 * 复制 Ruffle 标签的低层合同。
 *
 * 为什么**不**用 clone：`webContents.clone()` 的副本拿不到页面 preload
 * （官方 Electron 44 实测同样如此），而 Ruffle 正是靠 `preload/page.js` 注入的，
 * 克隆体里 `window.RufflePlayer` 为 undefined、`<embed>` 不被替换。
 * 因此 `duplicateTab()` 必须走"同 URL 新视图"，本用例守住这条：
 * 副本是独立进程，且两个标签的 Ruffle 都能初始化。
 */
test('复制 Ruffle 标签：副本独立进程且两个实例都能初始化播放器', { timeout: 240_000 }, async () => {
  const server = await startFixtureServer()
  const { app, shell, close } = await launchApp()
  try {
    const address = shell.getByRole('textbox', { name: '地址栏' })
    // 初始标签是 NTP（内部页），set-engine 对内部页无效：先导航成网页标签。
    await address.fill(`${server.baseUrl}/flash.html`)
    await address.press('Enter')
    await waitFor(async () => {
      const view = await activeView(app, shell)
      return view && view.pid !== 0 ? view : null
    }, { message: '首个网页标签未就绪' })

    await run(shell, { type: 'set-engine', engine: 'ruffle' })
    await waitFor(async () => {
      const state = await run(shell, { type: 'snapshot' })
      const tab = state.tabs.find((item) => item.id === state.activeId)
      return tab && tab.engine === 'ruffle' ? state : null
    }, { message: '未切到 Ruffle 引擎' })

    // 切引擎是"换 WebContents + 恢复导航栈"，恢复出来的文档不会再跑一次注入路径；
    // 重新导航到样本页，才是 Ruffle 真正接管的目标文档。
    await address.fill(`${server.baseUrl}/flash.html`)
    await address.press('Enter')

    const source = await waitFor(async () => {
      const view = await activeView(app, shell)
      if (!view || view.pid === 0) return null
      const facts = await evalIn(app, view.id, RUFFLE_FACTS)
      return facts && facts.canvas ? { ...view, facts } : null
    }, { message: '源标签的 Ruffle 未初始化' })

    const snapshot = await run(shell, { type: 'duplicate', id: (await run(shell, { type: 'snapshot' })).activeId })
    assert.equal(snapshot.tabs.length, 2, '复制未新增标签')

    const copy = await waitFor(async () => {
      const view = await activeView(app, shell)
      if (!view || view.id === source.id || view.pid === 0) return null
      const facts = await evalIn(app, view.id, RUFFLE_FACTS)
      return facts && facts.canvas ? { ...view, facts } : null
    }, { message: '副本标签的 Ruffle 未初始化' })

    assert.notEqual(copy.id, source.id, '副本必须是独立 WebContents')
    assert.notEqual(copy.pid, source.pid, '副本应使用独立渲染进程（不走 clone）')
    assert.ok(copy.facts.players >= 1, '副本里没有 ruffle 播放器元素')
    assert.equal(copy.facts.embeds, 0, '副本里的原 <embed> 未被替换')
    assert.equal(copy.facts.canvas, true, '副本的 Ruffle 播放器画布未创建（WASM 未加载）')

    // 两个实例互不干扰：源标签在复制后仍然活着。
    const sourceAfter = await evalIn(app, source.id, RUFFLE_FACTS)
    assert.ok(sourceAfter, '源标签在复制后不可访问')
    assert.equal(sourceAfter.canvas, true, '复制后源标签的播放器画布消失')
    assert.equal(sourceAfter.version, copy.facts.version, '两个实例应使用同一 Ruffle 运行时版本')
  } finally {
    await close()
    await server.close()
  }
})
