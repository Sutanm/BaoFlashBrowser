const assert = require('node:assert/strict')
const { test } = require('node:test')
const { isShellPage, launchApp, page, startFixtureServer, waitFor } = require('./helpers.cjs')

function activeViewId(windowHandle) {
  return windowHandle.evaluate((window) => {
    const view = window.contentView.children
      .find((child) => child.webContents && child.webContents !== window.webContents)
    return view ? view.webContents.id : -1
  })
}

/** 新标签要等起始页装载完再导航，否则导航栈里没有可回退项。 */
async function addTab(shell) {
  const before = await shell.locator('.tab').count()
  await shell.getByRole('button', { name: '新建标签页', exact: true }).click()
  await waitFor(async () => {
    const result = await shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' }))
    return result.state.tabs.length === before + 1 && result.state.tabs.every((tab) => !tab.loading)
  }, { message: '未新增第二个标签。' })
}

test('拖出标签在新窗口保留业务 ID、页面运行时状态与历史', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({
    '/one': page('第一个页面'),
    '/two': page('第二个页面'),
    '/three': page('第三个页面')
  })
  const { app, shell, close } = await launchApp()
  try {
    const shellsOf = async () => (await app.windows()).filter(isShellPage)

    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${server.baseUrl}/one`)
    await address.press('Enter')
    await shell.getByRole('button', { name: '第一个页面', exact: true }).waitFor()
    await addTab(shell)
    await address.fill(`${server.baseUrl}/two`)
    await address.press('Enter')
    await shell.getByRole('button', { name: '第二个页面', exact: true }).waitFor()
    // 从新标签页导航到网页时是「换视图」，NTP 不进历史；再走一步才有可回退项。
    await address.fill(`${server.baseUrl}/three`)
    await address.press('Enter')
    await shell.getByRole('button', { name: '第三个页面', exact: true }).waitFor()

    const windowHandle = await app.browserWindow(shell)
    const before = {
      viewId: await activeViewId(windowHandle),
      bounds: await windowHandle.evaluate((window) => window.getBounds()),
      state: await shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' }))
    }
    const movedId = before.state.state.activeId
    await windowHandle.evaluate(async (window, marker) => {
      const view = window.contentView.children
        .find((child) => child.webContents && child.webContents !== window.webContents)
      await view.webContents.executeJavaScript(`window.__baoState = ${JSON.stringify(marker)}`)
    }, { marker: 'tearoff' })

    // 窗口内释放：不是拖出，不应新建窗口。
    const inside = await shell.evaluate(({ id, x, y }) =>
      window.baoBrowser.run({ type: 'tearoff', id, screenX: x, screenY: y }),
      { id: movedId, x: before.bounds.x + 60, y: before.bounds.y + 12 })
    assert.equal(inside.ok, true)
    assert.equal((await shellsOf()).length, 1)

    // 拖出：新窗口接管同一 WebContents。
    const outside = await shell.evaluate(({ id, x, y }) =>
      window.baoBrowser.run({ type: 'tearoff', id, screenX: x, screenY: y }),
      { id: movedId, x: before.bounds.x - 240, y: before.bounds.y + 24 })
    assert.equal(outside.ok, true)

    const shells = await waitFor(async () => {
      const list = await shellsOf()
      return list.length >= 2 ? list : null
    }, { message: '拖出标签后未创建新窗口。' })
    const target = shells.find((candidate) => candidate !== shell)
    await target.getByRole('textbox', { name: '地址栏' }).waitFor()
    const targetWindow = await app.browserWindow(target)
    const after = await targetWindow.evaluate(async (window) => {
      const view = window.contentView.children
        .find((child) => child.webContents && child.webContents !== window.webContents)
      return {
        viewId: view.webContents.id,
        url: view.webContents.getURL(),
        marker: await view.webContents.executeJavaScript('JSON.stringify(window.__baoState)'),
        state: await window.webContents.executeJavaScript('window.baoBrowser.run({ type: "snapshot" })')
      }
    })
    assert.equal(after.viewId, before.viewId, '跨窗口移动应复用同一 WebContents（内存态与插件实例保留）。')
    assert.equal(after.marker, '{"marker":"tearoff"}')
    assert.ok(after.url.endsWith('/three'))
    assert.equal(after.state.state.activeId, movedId, '业务 ID 必须跨窗口稳定。')
    assert.deepEqual(after.state.state.tabs.map((tab) => tab.id), [movedId])
    assert.equal(after.state.state.tabs[0].canGoBack, true, '导航历史应随标签迁移。')

    const sourceState = await shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' }))
    assert.equal(sourceState.state.tabs.length, 1, JSON.stringify(sourceState.state))
    assert.ok(sourceState.state.tabs[0].address.endsWith('/one'), JSON.stringify(sourceState.state))
    assert.notEqual(sourceState.state.activeId, movedId)

    // 拖出最后一个标签：原窗口关闭，标签落到第三个窗口。
    await shell.evaluate(({ id, x, y }) =>
      window.baoBrowser.run({ type: 'tearoff', id, screenX: x, screenY: y }),
      { id: sourceState.state.activeId, x: before.bounds.x - 240, y: before.bounds.y + 24 }).catch(() => {})
    const remaining = await waitFor(async () => {
      const list = await shellsOf()
      if (list.length !== 2) return null
      return list.includes(shell) ? null : list
    }, { message: '最后一个标签拖出后原窗口未关闭。' })
    const lastIds = []
    for (const candidate of remaining) {
      const handle = await app.browserWindow(candidate)
      const state = await candidate.evaluate(() => window.baoBrowser.run({ type: 'snapshot' }))
      lastIds.push(...state.state.tabs.map((tab) => tab.id))
      void handle
    }
    assert.ok(lastIds.includes(sourceState.state.activeId), '最后一个标签应在新窗口中保留业务 ID。')

    // 未知标签：稳定错误码。
    const unknown = await remaining[0].evaluate(() => window.baoBrowser.run({ type: 'tearoff', id: 99999, screenX: -5000, screenY: -5000 }))
    assert.equal(unknown.ok, false)
    assert.equal(unknown.code, 'unknown-tab')
  } finally {
    await close()
    await server.close()
  }
})

test('指针拖出标签触发跨窗口移交', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({ '/one': page('第一个页面'), '/two': page('第二个页面') })
  const { app, shell, close } = await launchApp()
  try {
    const shellsOf = async () => (await app.windows()).filter(isShellPage)
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${server.baseUrl}/one`)
    await address.press('Enter')
    await shell.getByRole('button', { name: '第一个页面', exact: true }).waitFor()

    // 先建第二个标签：源窗口移交后仍有标签，不会因「标签数为 0」关闭。
    // 只留一个标签时源窗口会被关掉，两窗口状态是瞬时的，断言会变成赌时序。
    await shell.getByRole('button', { name: '新建标签页', exact: true }).click()
    await address.fill(`${server.baseUrl}/two`)
    await address.press('Enter')
    await shell.getByRole('button', { name: '第二个页面', exact: true }).waitFor({ timeout: 30_000 })

    const windowHandle = await app.browserWindow(shell)
    const bounds = await windowHandle.evaluate((window) => window.getBounds())
    const before = await shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' }))
    const moved = before.state.tabs.find((tab) => tab.title === '第一个页面')
    assert.ok(moved, '未找到要拖出的标签')
    const movedId = moved.id

    const tab = shell.getByRole('button', { name: '第一个页面', exact: true })
    await tab.dispatchEvent('pointerdown', { button: 0, pointerId: 1, screenX: bounds.x + 40, screenY: bounds.y + 12 })
    await tab.dispatchEvent('pointermove', { button: 0, pointerId: 1, screenX: bounds.x + 120, screenY: bounds.y + 200 })
    await tab.dispatchEvent('pointerup', { button: 0, pointerId: 1, screenX: bounds.x - 260, screenY: bounds.y + 30 })

    const shells = await waitFor(async () => {
      const list = await shellsOf()
      return list.length >= 2 ? list : null
    }, { message: '指针拖出后未创建新窗口。' })
    const target = shells.find((candidate) => candidate !== shell)
    // 新窗口的标签是异步激活的：立即快照可能读到 activeId = -1，这里等状态落定再断言。
    await waitFor(async () => {
      const state = await target.evaluate(() => window.baoBrowser.run({ type: 'snapshot' }))
      return state.state.activeId === movedId ? state : null
    }, { message: `移交后的目标窗口没有把标签 ${movedId} 设为当前标签。` })

    // 源窗口保留其余标签，移交是「移动」而不是「复制」。
    const sourceState = await shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' }))
    assert.equal(sourceState.state.tabs.length, 1, '源窗口的标签数不对')
    assert.ok(!sourceState.state.tabs.some((tab) => tab.id === movedId), '源窗口仍持有已移交的标签')

    // 快捷键归属（审计 P1-4）：在新窗口里按 Ctrl+W，必须关**新窗口**的标签，
    // 而不是穿透到源窗口的旧处理器上关掉源标签。
    // 注意：本产品的 `closeTab` 在标签清零时会补一个新标签（窗口不留空），
    // 所以断言看的是「关掉的是哪个标签」，不是窗口是否消失。
    const targetHandle = await app.browserWindow(target)
    if (process.env.BAO_SMOKE_HIDDEN === '1') {
      assert.deepEqual(await targetHandle.evaluate((window) => [window.isVisible(), window.isFocusable(), window.isFocused()]),
        [false, false, false], '拖出标签创建的新窗口必须保持隐藏且不获取焦点')
    }
    await targetHandle.evaluate((window) => {
      const view = window.contentView.children
        .find((child) => child.webContents && child.webContents !== window.webContents)
      if (window.isFocused()) view.webContents.focus()
      view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['control'] })
    })
    await waitFor(async () => {
      const state = await target.evaluate(() => window.baoBrowser.run({ type: 'snapshot' }))
      return state.state.tabs.length === 1 && state.state.tabs[0].id !== movedId ? state : null
    }, { message: 'Ctrl+W 没有关掉新窗口里被移交的标签。' })
    const afterShortcut = await shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' }))
    assert.equal(afterShortcut.state.tabs.length, 1, '源窗口的标签被 Ctrl+W 误关')
    assert.ok(afterShortcut.state.tabs.some((tab) => tab.title === '第二个页面'), '源窗口丢失了原有标签')
  } finally {
    await close()
    await server.close()
  }
})
