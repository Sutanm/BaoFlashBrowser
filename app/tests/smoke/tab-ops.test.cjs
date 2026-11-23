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

test('标签操作：复制、固定排序、静音与 DevTools 快捷键', { timeout: 180_000 }, async () => {
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
    state = await run(shell, { type: 'mute', id: copyId })
    assert.equal(state.tabs.find((tab) => tab.id === copyId).muted, false, '取消静音未生效')

    // DevTools：Ctrl+Shift+I 命中页面视图的 before-input-event。
    const { handle } = await viewContents(app, shell)
    const sendShortcut = () => handle.evaluate((window) => {
      const view = window.contentView.children
        .find((child) => child.webContents && child.webContents !== window.webContents)
      view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'I', modifiers: ['control', 'shift'] })
      return view.webContents.id
    })
    await sendShortcut()
    const opened = await waitFor(async () => {
      const value = await handle.evaluate((window) => {
        const view = window.contentView.children
          .find((child) => child.webContents && child.webContents !== window.webContents)
        return view.webContents.isDevToolsOpened()
      })
      return value ? value : null
    }, { message: 'Ctrl+Shift+I 没有打开 DevTools' })
    assert.equal(opened, true)
    await sendShortcut()
    const closed = await waitFor(async () => {
      const value = await handle.evaluate((window) => {
        const view = window.contentView.children
          .find((child) => child.webContents && child.webContents !== window.webContents)
        return view.webContents.isDevToolsOpened()
      })
      return value ? null : true
    }, { message: 'Ctrl+Shift+I 没有关闭 DevTools' })
    assert.equal(closed, true)
  } finally {
    await close()
    await server.close()
  }
})
