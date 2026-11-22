const assert = require('node:assert/strict')
const { test } = require('node:test')
const { launchApp, page, pressShortcut, startFixtureServer, waitFor } = require('./helpers.cjs')

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
  await shell.getByRole('button', { name: title, exact: true }).waitFor({ timeout: 30_000 })
}

async function addTab(shell) {
  const before = await shell.locator('.tab').count()
  await shell.getByRole('button', { name: '新建标签页', exact: true }).click()
  await waitFor(async () => (await shell.locator('.tab').count()) === before + 1, { message: '未新增标签。' })
}

test('标签排序、关闭按钮可见性与鼠标手势', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({
    '/one': page('第一个页面'),
    '/two': page('第二个页面'),
    '/three': page('第三个页面')
  })
  const { app, shell, close } = await launchApp()
  try {
    const labels = shell.locator('.tab .tab-label')
    await navigate(shell, `${server.baseUrl}/one`, '第一个页面')
    await addTab(shell)
    await navigate(shell, `${server.baseUrl}/two`, '第二个页面')
    await addTab(shell)
    await navigate(shell, `${server.baseUrl}/three`, '第三个页面')
    assert.deepEqual(await labels.allTextContents(), ['第一个页面', '第二个页面', '第三个页面'])

    // 排序：第三个标签移到最前，选中关系不丢。
    const before = await snapshot(shell)
    const third = before.tabs[2]
    await shell.evaluate(({ id }) => window.baoBrowser.run({ type: 'move', id, index: 0 }), { id: third.id })
    await waitFor(async () => (await labels.allTextContents())[0] === '第三个页面', { message: '排序未生效。' })
    assert.deepEqual(await labels.allTextContents(), ['第三个页面', '第一个页面', '第二个页面'])
    assert.equal((await snapshot(shell)).activeId, third.id)

    // 关闭按钮按需显示：未选中且未悬停时隐藏。
    const closeButton = shell.getByRole('button', { name: '关闭标签页：第一个页面' })
    assert.equal(await closeButton.evaluate((element) => getComputedStyle(element).opacity), '0')
    await closeButton.hover()
    assert.equal(await closeButton.evaluate((element) => getComputedStyle(element).opacity), '1')

    // 中键关闭。
    await shell.locator('.tab').nth(1).click({ button: 'middle' })
    await waitFor(async () => (await labels.allTextContents()).length === 2, { message: '中键未关闭标签。' })
    assert.deepEqual(await labels.allTextContents(), ['第三个页面', '第二个页面'])

    // 双击标签栏空白处新建。
    await shell.locator('.tabs').dispatchEvent('dblclick')
    await waitFor(async () => (await labels.allTextContents()).length === 3, { message: '双击标签栏未新建标签。' })
  } finally {
    await close()
    await server.close()
  }
})

test('快捷键与撤销关闭恢复导航栈', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({ '/one': page('第一个页面'), '/two': page('第二个页面') })
  const { app, shell, close } = await launchApp()
  try {
    await navigate(shell, `${server.baseUrl}/one`, '第一个页面')
    await navigate(shell, `${server.baseUrl}/two`, '第二个页面')
    assert.equal((await snapshot(shell)).tabs[0].canGoBack, true)

    // Ctrl+W 关闭唯一标签：自动补一个空白标签，并进入可撤销状态。
    await pressShortcut(app, 'w', ['control'])
    await waitFor(async () => (await snapshot(shell)).undoCount === 1, { message: '关闭标签后未进入可撤销状态。' })
    assert.equal((await snapshot(shell)).tabs.length, 1)

    // Ctrl+Shift+T 撤销关闭：恢复原地址与导航栈。
    await pressShortcut(app, 'T', ['control', 'shift'])
    const restored = await waitFor(async () => {
      const state = await snapshot(shell)
      return state.tabs.find((tab) => tab.address.endsWith('/two') && tab.canGoBack) ?? null
    }, { message: '撤销关闭未恢复导航栈。' })
    assert.ok(restored)
    assert.equal((await snapshot(shell)).undoCount, 0)

    // 没有可撤销项时返回稳定错误码。
    const empty = await shell.evaluate(() => window.baoBrowser.run({ type: 'undo-close' }))
    assert.equal(empty.ok, false)
    assert.equal(empty.code, 'nothing-to-undo')

    // Ctrl+T 新建、Ctrl+Tab 切换。
    const beforeAdd = (await snapshot(shell)).tabs.length
    await pressShortcut(app, 't', ['control'])
    await waitFor(async () => (await snapshot(shell)).tabs.length === beforeAdd + 1, { message: 'Ctrl+T 未新建标签。' })
    const activeBefore = (await snapshot(shell)).activeId
    await pressShortcut(app, 'Tab', ['control'])
    await waitFor(async () => (await snapshot(shell)).activeId !== activeBefore, { message: 'Ctrl+Tab 未切换标签。' })
  } finally {
    await close()
    await server.close()
  }
})
