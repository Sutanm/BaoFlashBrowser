const assert = require('node:assert/strict')
const { test } = require('node:test')
const { launchApp, page, pressShortcut, startFixtureServer, waitFor, waitForTabLabel } = require('./helpers.cjs')

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
  await waitForTabLabel(shell, title)
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

/**
 * 通过外壳**真实的 pointer 事件**拖动标签：`pointerdown/pointermove/pointerup` →
 * 渲染层 `dropIndex`（插槽 → 最终索引换算）→ `move` IPC → 主进程重排。
 *
 * 坐标由窗口位置 + 客户区坐标反推（`dropIndex` 里正好相减），隐藏冒烟下也成立。
 */
async function dragTab(shell, fromTitle, toTitle, side) {
  await shell.evaluate(({ fromTitle, toTitle, side }) => {
    const find = (title) => [...document.querySelectorAll('.tab')].find(
      (tab) => tab.querySelector('.tab-title')?.getAttribute('title') === title)
    const dragged = find(fromTitle)
    const target = find(toTitle)
    if (!dragged || !target) throw new Error(`找不到标签：${fromTitle} → ${toTitle}`)
    const strip = document.querySelector('.tabs').getBoundingClientRect()
    const from = dragged.getBoundingClientRect()
    const to = target.getBoundingClientRect()
    const startX = window.screenX + from.left + from.width / 2
    const startY = window.screenY + strip.top + strip.height / 2
    const dropX = window.screenX + (side === 'left' ? to.left + to.width * 0.25 : to.left + to.width * 0.75)
    // 纵向留在标签栏里：dropIndex 任一轴越界都会交给 tearoff 判定。
    const dropY = startY
    const init = { bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true, pointerType: 'mouse' }
    const fire = (type, screenX, screenY) => dragged.dispatchEvent(new PointerEvent(type, {
      ...init, screenX, screenY, clientX: screenX - window.screenX, clientY: screenY - window.screenY
    }))
    fire('pointerdown', startX, startY)
    fire('pointermove', dropX, dropY)
    fire('pointerup', dropX, dropY)
  }, { fromTitle, toTitle, side })
}

/** 等主进程的标签顺序变成期望值；超时会把当前顺序带进报错。 */
async function waitForOrder(shell, expected) {
  return waitFor(async () => {
    const current = (await snapshot(shell)).tabs.map((tab) => tab.title)
    return current.join('|') === expected.join('|') ? current : null
  }, { message: `标签顺序应为 ${expected.join('|')}` })
}

async function pinByTitle(shell, title) {
  const tab = (await snapshot(shell)).tabs.find((item) => item.title === title)
  assert.ok(tab, `找不到标签 ${title}`)
  const result = await shell.evaluate((id) => window.baoBrowser.run({ type: 'pin', id }), tab.id)
  assert.equal(result.ok, true, `固定标签失败：${result.code ?? ''}`)
  return tab.id
}

test('横向拖拽按「移除被拖项后的最终索引」落位，固定前缀不被跨越', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({
    '/one': page('第一个页面'),
    '/two': page('第二个页面'),
    '/three': page('第三个页面')
  })
  const { app, shell, close } = await launchApp()
  try {
    await navigate(shell, `${server.baseUrl}/one`, '第一个页面')
    await addTab(shell)
    await navigate(shell, `${server.baseUrl}/two`, '第二个页面')
    await addTab(shell)
    await navigate(shell, `${server.baseUrl}/three`, '第三个页面')
    await waitForOrder(shell, ['第一个页面', '第二个页面', '第三个页面'])

    // 向右拖：落点在第二个标签右半（插槽 2）。最终索引必须是 1，否则会多移一位、
    // 把第三个标签吞到最左（本次回归点）。
    await dragTab(shell, '第一个页面', '第二个页面', 'right')
    await waitForOrder(shell, ['第二个页面', '第一个页面', '第三个页面'])

    // 相邻项中线左侧：不越过。
    await dragTab(shell, '第一个页面', '第二个页面', 'left')
    await waitForOrder(shell, ['第一个页面', '第二个页面', '第三个页面'])

    // 向左跨两项：插槽与最终索引相同。
    await dragTab(shell, '第三个页面', '第一个页面', 'left')
    await waitForOrder(shell, ['第三个页面', '第一个页面', '第二个页面'])

    // 固定分组边界：固定第一个页面后，固定标签始终占最左前缀。
    const pinnedId = await pinByTitle(shell, '第一个页面')
    await waitForOrder(shell, ['第一个页面', '第三个页面', '第二个页面'])

    // 未固定标签拖到固定标签左侧：夹到固定组之后，但仍在未固定组里移动。
    await dragTab(shell, '第二个页面', '第一个页面', 'left')
    await waitForOrder(shell, ['第一个页面', '第二个页面', '第三个页面'])

    // 固定标签拖向未固定组：不允许越过固定前缀，顺序不变。
    // 这里不睡固定时长断言"没变化"：紧接一次**可观察**的普通排序，IPC 同通道按序处理，
    // 等到它的结果落定就说明上一条 move 也已经被主进程处理过了。
    await dragTab(shell, '第一个页面', '第三个页面', 'right')
    await dragTab(shell, '第三个页面', '第二个页面', 'left')
    await waitForOrder(shell, ['第一个页面', '第三个页面', '第二个页面'])
    const final = await snapshot(shell)
    assert.equal(final.tabs[0].id, pinnedId, '固定标签应保持在最左前缀')
    assert.equal(final.tabs[0].pinned, true)
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
