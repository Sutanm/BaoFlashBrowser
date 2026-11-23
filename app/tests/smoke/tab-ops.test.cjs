const assert = require('node:assert/strict')
const { test } = require('node:test')
const { launchApp, startFixtureServer, waitFor } = require('./helpers.cjs')

async function run(shell, command) {
  const result = await shell.evaluate((payload) => window.baoBrowser.run(payload), command)
  assert.equal(result.ok, true, `命令失败：${command.type} ${result.code ?? ''}`)
  return result.state
}

const activeOf = (state) => state.tabs.find((tab) => tab.id === state.activeId)

async function viewContents(app, shell) {
  const handle = await app.browserWindow(shell)
  const id = await handle.evaluate((window) => {
    const view = window.contentView.children
      .find((child) => child.webContents && child.webContents !== window.webContents)
    return view.webContents.id
  })
  return { handle, id }
}

test('标签操作：复制、固定排序、静音迁移与拖出判定', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({
    '/one': '<!doctype html><meta charset="utf-8"><title>one</title><h1>one</h1>',
    '/two': '<!doctype html><meta charset="utf-8"><title>two</title><h1>two</h1>'
  })
  const { app, shell, close } = await launchApp()
  try {
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${server.baseUrl}/one`)
    await address.press('Enter')
    await shell.getByRole('button', { name: 'one', exact: true }).waitFor({ timeout: 30_000 })

    // 复制标签页：同地址、同引擎、ID 唯一。
    const duplicated = await run(shell, { type: 'duplicate', id: (await run(shell, { type: 'snapshot' })).activeId })
    assert.equal(duplicated.tabs.length, 2, '复制未新增标签')
    const copyId = duplicated.activeId
    assert.equal(new Set(duplicated.tabs.map((tab) => tab.id)).size, 2, '标签 ID 必须唯一')
    // 复制出的标签是异步导航，等地址落定再断言。
    const copied = await waitFor(async () => {
      const next = await run(shell, { type: 'snapshot' })
      const tab = next.tabs.find((item) => item.id === copyId)
      return tab && tab.address.endsWith('/one') ? tab : null
    }, { message: '复制出的标签地址不一致' })
    assert.ok(copied.address.endsWith('/one'))

    // 第二个标签换到 /two，便于验证固定后的排序。
    await address.fill(`${server.baseUrl}/two`)
    await address.press('Enter')
    await shell.getByRole('button', { name: 'two', exact: true }).waitFor({ timeout: 30_000 })
    state = await run(shell, { type: 'snapshot' })
    const twoId = activeOf(state).id

    // 固定：排到最左，且界面上没有关闭按钮。
    state = await run(shell, { type: 'pin', id: twoId })
    assert.equal(state.tabs[0].id, twoId, '固定标签未排到最左')
    assert.equal(state.tabs[0].pinned, true)
    const pinnedUi = await shell.evaluate(() => ({
      closeButtons: document.querySelectorAll('.tab.pinned .close-tab').length,
      labels: document.querySelectorAll('.tab.pinned .tab-label').length
    }))
    assert.equal(pinnedUi.closeButtons, 0, '固定标签不应有关闭按钮')
    assert.equal(pinnedUi.labels, 0, '固定标签不应显示标题')

    // 取消固定：回到未固定组，位置在固定组之后。
    state = await run(shell, { type: 'snapshot' })
    assert.ok(state.tabs.some((tab) => tab.pinned), '固定状态未持久')
    state = await run(shell, { type: 'pin', id: twoId })
    assert.equal(state.tabs.find((tab) => tab.id === twoId).pinned, false, '取消固定后仍被当作固定标签')
    assert.equal(state.tabs.findIndex((tab) => tab.pinned), -1, '仍有标签被当作固定标签')
    assert.equal(state.tabs[0].id, twoId, '取消固定后应回到未固定组首位')

    // 静音：来回切换。
    state = await run(shell, { type: 'mute', id: copyId })
    assert.equal(state.tabs.find((tab) => tab.id === copyId).muted, true, '静音未生效')
    // 静音必须跟着标签走：切引擎会重建 WebContents（审计 P2）。
    state = await run(shell, { type: 'set-engine', engine: 'ruffle' })
    assert.equal(state.tabs.find((tab) => tab.id === copyId).muted, true, '切引擎后静音状态丢失')
    state = await run(shell, { type: 'mute', id: copyId })
    assert.equal(state.tabs.find((tab) => tab.id === copyId).muted, false, '取消静音未生效')

    // 固定前缀不能被排序打破（审计 P2）。
    state = await run(shell, { type: 'pin', id: copyId })
    assert.equal(state.tabs[0].id, copyId, '固定标签未排到最左')
    const unpinned = state.tabs.find((tab) => !tab.pinned)
    state = await run(shell, { type: 'move', id: unpinned.id, index: 0 })
    assert.equal(state.tabs[0].pinned, true, '未固定标签被排到了固定标签之前')
    state = await run(shell, { type: 'pin', id: copyId })

    // 竖直拖出不应被当成排序（审计 P2：原来只看 X）。
    const windowHandle = await app.browserWindow(shell)
    const bounds = await windowHandle.evaluate((window) => window.getBounds())
    const orderBefore = (await run(shell, { type: 'snapshot' })).tabs.map((tab) => tab.id)
    const dragTab = shell.getByRole('button', { name: 'one', exact: true }).first()
    await dragTab.dispatchEvent('pointerdown', { button: 0, pointerId: 1, screenX: bounds.x + 40, screenY: bounds.y + 20 })
    await dragTab.dispatchEvent('pointermove', { button: 0, pointerId: 1, screenX: bounds.x + 300, screenY: bounds.y + 400 })
    await dragTab.dispatchEvent('pointerup', { button: 0, pointerId: 1, screenX: bounds.x + 300, screenY: bounds.y + 400 })
    await new Promise((done) => setTimeout(done, 600))
    const orderAfter = (await run(shell, { type: 'snapshot' })).tabs.map((tab) => tab.id)
    assert.deepEqual(orderAfter, orderBefore, '竖直拖出被当成了排序')

    // 方向键切标签后焦点留在标签栏，才能连续浏览（审计 P2）。
    await shell.evaluate(() => document.querySelector('.tab-title')?.focus())
    await shell.keyboard.press('ArrowRight')
    await waitFor(async () => {
      const focused = await shell.evaluate(() => ({
        inStrip: Boolean(document.activeElement?.closest('.tab')),
        selected: Boolean(document.querySelector('.tab.selected'))
      }))
      return focused.inStrip && focused.selected ? focused : null
    }, { message: '方向键切标签后焦点没有留在标签栏' })

  } finally {
    await close()
    await server.close()
  }
})
test('DevTools：Ctrl+Shift+I 开关页面视图的开发者工具', {
  timeout: 120_000,
  skip: (process.env.BAO_SMOKE_HIDDEN === '1' || process.env.BAO_SMOKE_BACKGROUND === '1') &&
    'DevTools 可能打开独立窗口，留给前台测试'
}, async () => {
  // 独立用例：DevTools 会创建自己的窗口，跟长链路的引擎重建/拖出放在一起容易互相干扰。
  const server = await startFixtureServer({ '/one': '<!doctype html><meta charset="utf-8"><title>one</title><h1>one</h1>' })
  const { app, shell, close } = await launchApp()
  try {
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${server.baseUrl}/one`)
    await address.press('Enter')
    await shell.getByRole('button', { name: 'one', exact: true }).waitFor({ timeout: 30_000 })

    // 用**提前捕获的 webContents id** 定位页面视图：DevTools 打开后
    // `window.contentView.children` 会多出 devtools 视图，按"第一个非外壳子视图"找会抓错。
    const { id: pageViewId } = await viewContents(app, shell)
    const sendShortcut = () => app.evaluate(({ webContents }, id) => {
      const contents = webContents.fromId(id)
      if (!contents) throw new Error('页面视图已销毁')
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'I', modifiers: ['control', 'shift'] })
    }, pageViewId)
    const devtoolsOpened = () => app.evaluate(({ webContents }, id) => {
      const contents = webContents.fromId(id)
      return Boolean(contents && contents.isDevToolsOpened())
    }, pageViewId)

    await sendShortcut()
    await waitFor(async () => (await devtoolsOpened()) ? true : null,
      { message: 'Ctrl+Shift+I 没有打开 DevTools' })
    // 关闭 DevTools：全量跑时第二次按键可能落在打开动画里，重试几次（不放宽断言）。
    let closedOk = false
    for (let attempt = 0; attempt < 3 && !closedOk; attempt += 1) {
      await sendShortcut()
      closedOk = await waitFor(async () => (await devtoolsOpened()) ? null : true, {
        timeout: 8_000,
        message: 'Ctrl+Shift+I 没有关闭 DevTools'
      }).then(() => true).catch(() => false)
    }
    assert.equal(closedOk, true, 'Ctrl+Shift+I 没有关闭 DevTools（重试 3 次）')
  } finally {
    await close()
    await server.close()
  }
})
