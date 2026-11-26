const assert = require('node:assert/strict')
const { test } = require('node:test')
const { isShellPage, launchApp, page, startFixtureServer, waitFor, waitForTabLabel } = require('./helpers.cjs')

/* ------------------------------------------------------------------ *
 * 跨窗口移交：宿主解析、失败分支与故障注入（2026-11-25 批次）
 * ------------------------------------------------------------------ */

const snapshotOf = (shell) => shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' }))
  .then((result) => result.state)

/** 当前还活着的外壳窗口。 */
const shellPages = async (app) =>
  (await app.windows()).filter((candidate) => !candidate.isClosed() && isShellPage(candidate))

/** 当前持有该 tabId 的外壳窗口；正常情况任何时刻都应 ≤ 1。 */
async function ownersOf(app, tabId) {
  const owners = []
  for (const candidate of await shellPages(app)) {
    try {
      const state = await snapshotOf(candidate)
      if (state.tabs.some((tab) => tab.id === tabId)) owners.push(candidate)
    } catch {
      // 窗口正在关闭：这一轮跳过。
    }
  }
  return owners
}

/** 在整个移交过程中持续检查「同一标签最多被一个窗口持有」，返回观察到双持有的次数。 */
async function watchOwnership(app, tabId, settled) {
  const duplicates = []
  while (!settled()) {
    if ((await ownersOf(app, tabId)).length > 1) duplicates.push(1)
    await new Promise((done) => setTimeout(done, 40))
  }
  return duplicates
}

/** 主进程环境注入：只影响跨窗口接管的两条冒烟钩子，`null` 表示删除。 */
function injectTearoffEnv(app, values) {
  return app.evaluate((_electron, env) => {
    for (const [key, value] of Object.entries(env)) {
      if (value === null) delete process.env[key]
      else process.env[key] = String(value)
    }
  }, values)
}

/** 按 URL 后缀找页面 WebContents（避免依赖「谁是活动视图」）。 */
function viewIdByUrl(app, suffix) {
  return app.evaluate(({ webContents }, target) => {
    const contents = webContents.getAllWebContents().find((item) => (item.getURL() ?? '').endsWith(target))
    return contents ? contents.id : null
  }, suffix)
}

function contentsAlive(app, id) {
  return app.evaluate(({ webContents }, target) => {
    const contents = webContents.fromId(target)
    return Boolean(contents && !contents.isDestroyed())
  }, id)
}

function evalInPage(app, id, code) {
  return app.evaluate(async ({ webContents }, payload) => {
    const contents = webContents.fromId(payload.id)
    if (!contents || contents.isDestroyed()) throw new Error('页面已销毁')
    return contents.executeJavaScript(payload.code)
  }, { id, code })
}

/** 在指定页面里点一次元素（先打标记，重试不会点两次）。 */
async function clickInPage(app, id, elementId) {
  return waitFor(async () => {
    const value = await evalInPage(app, id, `(() => {
      const node = document.getElementById(${JSON.stringify(elementId)})
      if (!node) return 'no-node'
      if (node.dataset.clicked === '1') return 'already'
      node.dataset.clicked = '1'
      node.click()
      return 'clicked'
    })()`).catch(() => null)
    return value === 'clicked' || value === 'already' ? value : null
  }, { message: `点击 #${elementId} 失败` })
}

/** 标签当前的租约投影（读主进程诊断钩子，仅未打包构建存在）。 */
function leasesOf(app, tabId) {
  return app.evaluate((_electron, id) => {
    const manager = globalThis.__baoActivityLeases
    if (!manager) return null
    return { size: manager.size, active: manager.active(id) }
  }, tabId)
}

const windowCount = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)

const tearoffAt = (shell, payload) => shell.evaluate(({ id, x, y }) =>
  window.baoBrowser.run({ type: 'tearoff', id, screenX: x, screenY: y }), payload)

/** 打开无 features 新标签 / 带 features 弹窗的页面（与 link-target 用例同形）。 */
function pageWithActions(title) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1>
  <a id="blank" href="/extra-link" target="_blank">新标签</a>
  <button id="plain" type="button">无 features</button>
  <button id="features" type="button">有 features</button>
  <script>
    document.getElementById('plain').onclick = () => window.open('/extra-plain', '_blank')
    document.getElementById('features').onclick = () =>
      window.open('/extra-popup', '_blank', 'width=320,height=240')
  </script>`
}

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
    await waitForTabLabel(shell, '第一个页面')
    await addTab(shell)
    await address.fill(`${server.baseUrl}/two`)
    await address.press('Enter')
    await waitForTabLabel(shell, '第二个页面')
    // 从新标签页导航到网页时是「换视图」，NTP 不进历史；再走一步才有可回退项。
    await address.fill(`${server.baseUrl}/three`)
    await address.press('Enter')
    await waitForTabLabel(shell, '第三个页面')

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
    await waitForTabLabel(shell, '第一个页面')

    // 先建第二个标签：源窗口移交后仍有标签，不会因「标签数为 0」关闭。
    // 只留一个标签时源窗口会被关掉，两窗口状态是瞬时的，断言会变成赌时序。
    await shell.getByRole('button', { name: '新建标签页', exact: true }).click()
    await address.fill(`${server.baseUrl}/two`)
    await address.press('Enter')
    await waitForTabLabel(shell, '第二个页面')

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

test('移交标签的 window.open 落在当前宿主窗口，并保留租约、页面与键盘路由', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({
    '/host': pageWithActions('宿主页'),
    '/other': page('其它页'),
    '/extra-link': page('链接目标'),
    '/extra-plain': page('开窗目标'),
    '/extra-popup': pageWithActions('弹窗目标')
  })
  const { app, shell, close } = await launchApp()
  try {
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${server.baseUrl}/host`)
    await address.press('Enter')
    await waitForTabLabel(shell, '宿主页')
    await addTab(shell)
    await address.fill(`${server.baseUrl}/other`)
    await address.press('Enter')
    await waitForTabLabel(shell, '其它页')

    const sourceState = await snapshotOf(shell)
    const hosted = sourceState.tabs.find((tab) => tab.title === '宿主页')
    const other = sourceState.tabs.find((tab) => tab.title === '其它页')
    assert.ok(hosted && other, '前置标签没有建好')
    assert.equal((await shell.evaluate((id) => window.baoBrowser.run({ type: 'keep-awake', id, value: true }), hosted.id)).ok, true)

    const hostViewId = await viewIdByUrl(app, '/host')
    assert.ok(hostViewId, '找不到宿主页 WebContents')
    await evalInPage(app, hostViewId, `window.__pageMarker = 'kept'`)

    const bounds = await (await app.browserWindow(shell)).evaluate((window) => window.getBounds())
    // 拉长目标窗口初始化：给「已摘下、尚未接管」的窗口期留出可观察时间。
    await injectTearoffEnv(app, { BAO_TEAROFF_INIT_DELAY_MS: 800, BAO_TEAROFF_INIT_FAIL: null })
    let settled = false
    const pending = tearoffAt(shell, { id: hosted.id, x: bounds.x - 240, y: bounds.y + 24 })
      .finally(() => { settled = true })
    const monitor = watchOwnership(app, hosted.id, () => settled)
    const moved = await pending
    assert.equal(moved.ok, true, `移交失败：${moved.code ?? ''}`)
    assert.deepEqual(await monitor, [], '移交过程中同一标签被两个窗口同时持有')
    await injectTearoffEnv(app, { BAO_TEAROFF_INIT_DELAY_MS: null })

    const target = await waitFor(async () => {
      const candidate = (await shellPages(app)).find((pageObject) => pageObject !== shell)
      if (!candidate) return null
      const state = await snapshotOf(candidate)
      return state.tabs.some((tab) => tab.id === hosted.id) ? candidate : null
    }, { message: '移交后没有在新窗口里找到标签' })

    const targetState = await snapshotOf(target)
    const migrated = targetState.tabs.find((tab) => tab.id === hosted.id)
    assert.ok(migrated, '目标窗口没有同一个 tabId')
    assert.equal(migrated.title, '宿主页')
    assert.equal(migrated.keepAwake, true, '移交后应保留保持活跃租约')
    assert.equal(await activeViewId(await app.browserWindow(target)), hostViewId, '移交应复用同一个 WebContents')
    assert.equal(await evalInPage(app, hostViewId, 'window.__pageMarker'), 'kept', '页面运行时状态应保留')

    // 源窗口仍有其它标签：所有新标签都必须落在 target。
    assert.deepEqual((await snapshotOf(shell)).tabs.map((tab) => tab.id), [other.id])

    // 键盘路由：Ctrl+T 必须由新宿主处理，不能穿透到源窗口。
    await app.evaluate(({ webContents }, id) => {
      const contents = webContents.fromId(id)
      if (contents && !contents.isDestroyed()) {
        contents.sendInputEvent({ type: 'keyDown', keyCode: 'T', modifiers: ['control'] })
      }
    }, hostViewId)
    await waitFor(async () => (await snapshotOf(target)).tabs.length === 2 ? true : null,
      { message: 'Ctrl+T 没有在新窗口开标签' })
    assert.equal((await snapshotOf(shell)).tabs.length, 1, '键盘事件穿透到了源窗口')

    // 无 features 的 window.open：按**当前宿主**开新标签。
    await clickInPage(app, hostViewId, 'plain')
    await waitFor(async () => (await snapshotOf(target)).tabs.some((tab) => tab.address.endsWith('/extra-plain')) ? true : null,
      { message: '无 features 的 window.open 没有在当前宿主开标签' })
    assert.equal((await snapshotOf(target)).tabs.length, 3)
    assert.equal((await snapshotOf(shell)).tabs.length, 1, '新标签被开到了旧窗口')

    // target=_blank 链接同样按当前宿主解析。
    await clickInPage(app, hostViewId, 'blank')
    await waitFor(async () => (await snapshotOf(target)).tabs.some((tab) => tab.address.endsWith('/extra-link')) ? true : null,
      { message: 'target=_blank 没有在当前宿主开标签' })
    assert.equal((await snapshotOf(target)).tabs.length, 4)
    assert.equal((await snapshotOf(shell)).tabs.length, 1)

    // 带 features 的 window.open：仍是弹窗窗口（策略不变），不变成标签。
    const windowsBeforePopup = await windowCount(app)
    const popupPromise = app.waitForEvent('window', {
      predicate: (candidate) => candidate.url().endsWith('/extra-popup'),
      timeout: 30_000
    })
    await clickInPage(app, hostViewId, 'features')
    const popup = await popupPromise
    await waitFor(async () => (await windowCount(app)) > windowsBeforePopup ? true : null,
      { message: '带 features 的 window.open 没有开弹窗' })
    assert.equal((await snapshotOf(target)).tabs.length, 4, '弹窗不应变成标签')

    // 子弹窗不是标签：它内部的 target=_blank 继承 opener 的**当前**宿主，而不是创建它时捕获的窗口。
    await popup.evaluate(() => document.querySelector('#blank')?.click())
    await waitFor(async () => (await snapshotOf(target)).tabs.length === 5 ? true : null,
      { message: '子弹窗的 target=_blank 没有落到 opener 的当前宿主' })
    assert.equal((await snapshotOf(shell)).tabs.length, 1, '子弹窗的新标签被开到了旧窗口')
    assert.equal(await windowCount(app), windowsBeforePopup + 1, '子弹窗的 target=_blank 不应再开窗口')

    // 租约跟随稳定 tabId，而不是某个窗口/WebContents。
    const leases = await leasesOf(app, hosted.id)
    assert.ok(leases, '主进程租约诊断钩子不可用')
    assert.equal(leases.active.some((lease) => lease.owner === 'user'), true, '租约应跟随 tabId 一起移交')
  } finally {
    await injectTearoffEnv(app, { BAO_TEAROFF_INIT_DELAY_MS: null, BAO_TEAROFF_INIT_FAIL: null }).catch(() => {})
    await close()
    await server.close()
  }
})

test('源窗口已关闭时，移交标签的无 features 开窗仍落在当前宿主', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({
    '/solo': pageWithActions('独页'),
    '/extra-link': page('链接目标'),
    '/extra-plain': page('开窗目标'),
    '/extra-popup': page('弹窗目标')
  })
  const { app, shell, close } = await launchApp()
  try {
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${server.baseUrl}/solo`)
    await address.press('Enter')
    await waitForTabLabel(shell, '独页')
    const solo = (await snapshotOf(shell)).tabs[0]
    const viewId = await viewIdByUrl(app, '/solo')
    await evalInPage(app, viewId, `window.__soloMarker = 'kept'`)
    const bounds = await (await app.browserWindow(shell)).evaluate((window) => window.getBounds())

    // 移走唯一标签：源窗口应关闭，回复可能送不到已销毁的发送者。
    await tearoffAt(shell, { id: solo.id, x: bounds.x - 240, y: bounds.y + 24 }).catch(() => null)
    await waitFor(async () => shell.isClosed() ? true : null, { message: '移走最后一个标签后源窗口没有关闭' })
    const target = await waitFor(async () => (await shellPages(app))[0] ?? null,
      { message: '移交后找不到目标窗口' })
    await waitFor(async () => (await snapshotOf(target)).tabs.some((tab) => tab.id === solo.id) ? true : null,
      { message: '目标窗口没有接管标签' })
    assert.equal(await windowCount(app), 1, '源窗口关闭后不应多出窗口')
    assert.equal(await evalInPage(app, viewId, 'window.__soloMarker'), 'kept')

    // 旧窗口已销毁：无 features 开窗必须落到当前宿主，而不是被旧窗口的 closing 守卫吞掉。
    await clickInPage(app, viewId, 'plain')
    await waitFor(async () => (await snapshotOf(target)).tabs.some((tab) => tab.address.endsWith('/extra-plain')) ? true : null,
      { message: '源窗口关闭后 window.open 没有开标签' })
    assert.equal((await snapshotOf(target)).tabs.length, 2)

    await clickInPage(app, viewId, 'blank')
    await waitFor(async () => (await snapshotOf(target)).tabs.some((tab) => tab.address.endsWith('/extra-link')) ? true : null,
      { message: '源窗口关闭后 target=_blank 没有开标签' })
    assert.equal((await snapshotOf(target)).tabs.length, 3)
    assert.equal(await windowCount(app), 1, '无 features 开窗不应创建新窗口')
  } finally {
    await close()
    await server.close()
  }
})

test('目标窗初始化失败：按当前固定分组回挂，保留页面、租约与键盘路由', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({
    '/a': page('A'),
    '/b': page('B'),
    '/c': page('C'),
    '/d': page('D')
  })
  const { app, shell, close } = await launchApp()
  try {
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${server.baseUrl}/a`)
    await address.press('Enter')
    await waitForTabLabel(shell, 'A')
    for (const [path, title] of [['/b', 'B'], ['/c', 'C'], ['/d', 'D']]) {
      await addTab(shell)
      await address.fill(`${server.baseUrl}${path}`)
      await address.press('Enter')
      await waitForTabLabel(shell, title)
    }

    const initial = await snapshotOf(shell)
    const tabOf = (title) => initial.tabs.find((tab) => tab.title === title)
    const [a, b, c, d] = ['A', 'B', 'C', 'D'].map(tabOf)
    assert.ok(a && b && c && d, '前置标签没有建好')
    assert.equal((await shell.evaluate((id) => window.baoBrowser.run({ type: 'keep-awake', id, value: true }), a.id)).ok, true)
    const aViewId = await viewIdByUrl(app, '/a')
    await evalInPage(app, aViewId, `window.__pageMarker = 'kept'`)
    const bounds = await (await app.browserWindow(shell)).evaluate((window) => window.getBounds())

    // 确定性的失败注入：初始化一定会失败，但被延迟到源窗口完成排序/固定之后。
    await injectTearoffEnv(app, { BAO_TEAROFF_INIT_DELAY_MS: 1200, BAO_TEAROFF_INIT_FAIL: 1 })
    let settled = false
    const pending = tearoffAt(shell, { id: a.id, x: bounds.x - 240, y: bounds.y + 24 })
      .finally(() => { settled = true })
    const monitor = watchOwnership(app, a.id, () => settled)
    await waitFor(async () => (await snapshotOf(shell)).tabs.some((tab) => tab.id === a.id) ? null : true,
      { timeout: 5_000, message: '标签没有被摘下' })

    // 等待期间改变源窗口的固定分组与顺序：固定 D、把 B 移到未固定组末尾。
    assert.equal((await shell.evaluate((id) => window.baoBrowser.run({ type: 'pin', id }), d.id)).ok, true)
    assert.equal((await shell.evaluate(({ id, index }) => window.baoBrowser.run({ type: 'move', id, index }),
      { id: b.id, index: 2 })).ok, true)

    const result = await pending
    assert.deepEqual(await monitor, [], '失败回挂过程中同一标签被两个窗口同时持有')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'tearoff-failed')
    assert.equal(result.message, '无法在新窗口打开此标签页，已退回原窗口')

    const after = await snapshotOf(shell)
    // 固定 D 占最左前缀；A 的旧索引是 0，但必须落回未固定组（不能插到 D 前面）。
    assert.deepEqual(after.tabs.map((tab) => tab.id), [d.id, a.id, c.id, b.id], '回挂没有按当前固定分组落位')
    assert.equal(after.tabs[0].pinned, true)
    assert.equal(after.tabs.find((tab) => tab.id === a.id).pinned, false)
    assert.equal((await shellPages(app)).length, 1, '失败时不应残留目标窗口')
    assert.equal(await viewIdByUrl(app, '/a'), aViewId, '回挂应复用同一个 WebContents')
    assert.equal(await evalInPage(app, aViewId, 'window.__pageMarker'), 'kept', '页面运行时状态应保留')
    const leases = await leasesOf(app, a.id)
    assert.ok(leases)
    assert.equal(leases.active.some((lease) => lease.owner === 'user'), true, '回挂后租约应仍在')

    // 键盘路由：回挂后事件必须由源窗口处理。
    await app.evaluate(({ webContents }, id) => {
      const contents = webContents.fromId(id)
      if (contents && !contents.isDestroyed()) {
        contents.sendInputEvent({ type: 'keyDown', keyCode: 'T', modifiers: ['control'] })
      }
    }, aViewId)
    await waitFor(async () => (await snapshotOf(shell)).tabs.length === 5 ? true : null,
      { message: '回挂后键盘事件没有路由到源窗口' })
  } finally {
    await injectTearoffEnv(app, { BAO_TEAROFF_INIT_DELAY_MS: null, BAO_TEAROFF_INIT_FAIL: null }).catch(() => {})
    await close()
    await server.close()
  }
})

test('等待期间源窗口关闭：清理 WebContents 与租约，不回挂到已销毁窗口', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({
    '/lost': page('待移交'),
    '/stay': page('观察标签')
  })
  const { app, shell, close } = await launchApp()
  try {
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${server.baseUrl}/lost`)
    await address.press('Enter')
    await waitForTabLabel(shell, '待移交')
    await addTab(shell)
    await address.fill(`${server.baseUrl}/stay`)
    await address.press('Enter')
    await waitForTabLabel(shell, '观察标签')

    const initial = await snapshotOf(shell)
    const lost = initial.tabs.find((tab) => tab.title === '待移交')
    const stay = initial.tabs.find((tab) => tab.title === '观察标签')
    assert.ok(lost && stay)
    assert.equal((await shell.evaluate((id) => window.baoBrowser.run({ type: 'keep-awake', id, value: true }), lost.id)).ok, true)
    const lostViewId = await viewIdByUrl(app, '/lost')
    const bounds = await (await app.browserWindow(shell)).evaluate((window) => window.getBounds())

    // 先成功移出「观察标签」，留下一个存活窗口；否则关闭源窗会直接退出整个应用。
    const first = await tearoffAt(shell, { id: stay.id, x: bounds.x - 240, y: bounds.y + 24 })
    assert.equal(first.ok, true, `第一次移交失败：${first.code ?? ''}`)
    const observer = await waitFor(async () => {
      const candidate = (await shellPages(app)).find((pageObject) => pageObject !== shell)
      if (!candidate) return null
      const state = await snapshotOf(candidate)
      return state.tabs.some((tab) => tab.id === stay.id) ? candidate : null
    }, { message: '没有观察窗口' })
    assert.equal((await snapshotOf(shell)).tabs.length, 1)

    await injectTearoffEnv(app, { BAO_TEAROFF_INIT_DELAY_MS: 1500, BAO_TEAROFF_INIT_FAIL: 1 })
    let settled = false
    const pending = tearoffAt(shell, { id: lost.id, x: bounds.x - 240, y: bounds.y + 24 })
      .catch(() => null)
      .finally(() => { settled = true })
    const monitor = watchOwnership(app, lost.id, () => settled)
    await waitFor(async () => {
      try {
        return (await snapshotOf(shell)).tabs.length === 0 ? true : null
      } catch {
        return true
      }
    }, { timeout: 5_000, message: '标签没有被摘下' })

    // 等待期间关闭源窗口：回挂路径必须识别出来并清理，而不是往已销毁窗口里塞标签。
    const sourceHandle = await app.browserWindow(shell)
    await sourceHandle.evaluate((window) => window.close()).catch(() => {})
    await waitFor(async () => shell.isClosed() ? true : null, { message: '源窗口没有关闭' })
    await pending
    assert.deepEqual(await monitor, [], '清理过程中同一标签被两个窗口同时持有')

    await waitFor(async () => (await contentsAlive(app, lostViewId)) ? null : true,
      { timeout: 10_000, message: '孤立的 WebContents 没有被清理' })
    assert.equal(await contentsAlive(app, lostViewId), false)
    const leases = await leasesOf(app, lost.id)
    assert.ok(leases)
    assert.deepEqual(leases.active, [], '清理后不应残留租约')
    assert.deepEqual(await ownersOf(app, lost.id), [], '已清理的标签不应再属于任何窗口')

    const alive = await shellPages(app)
    assert.equal(alive.length, 1, '失败时不应创建目标窗口')
    assert.equal(alive[0], observer)
    assert.ok((await snapshotOf(observer)).tabs.some((tab) => tab.id === stay.id), '观察窗口不应受影响')
  } finally {
    await injectTearoffEnv(app, { BAO_TEAROFF_INIT_DELAY_MS: null, BAO_TEAROFF_INIT_FAIL: null }).catch(() => {})
    await close()
    await server.close()
  }
})

test('等待期间被移交页面失效：清理并返回 tearoff-page-lost', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({
    '/gone': page('待销毁'),
    '/stay': page('旁观页')
  })
  const { app, shell, close } = await launchApp()
  try {
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${server.baseUrl}/gone`)
    await address.press('Enter')
    await waitForTabLabel(shell, '待销毁')
    await addTab(shell)
    await address.fill(`${server.baseUrl}/stay`)
    await address.press('Enter')
    await waitForTabLabel(shell, '旁观页')

    const initial = await snapshotOf(shell)
    const gone = initial.tabs.find((tab) => tab.title === '待销毁')
    const stay = initial.tabs.find((tab) => tab.title === '旁观页')
    assert.ok(gone && stay)
    assert.equal((await shell.evaluate((id) => window.baoBrowser.run({ type: 'keep-awake', id, value: true }), gone.id)).ok, true)
    const goneViewId = await viewIdByUrl(app, '/gone')
    const bounds = await (await app.browserWindow(shell)).evaluate((window) => window.getBounds())

    await injectTearoffEnv(app, { BAO_TEAROFF_INIT_DELAY_MS: 2500, BAO_TEAROFF_INIT_FAIL: 1 })
    let settled = false
    const pending = tearoffAt(shell, { id: gone.id, x: bounds.x - 240, y: bounds.y + 24 })
      .finally(() => { settled = true })
    const monitor = watchOwnership(app, gone.id, () => settled)
    await waitFor(async () => (await snapshotOf(shell)).tabs.some((tab) => tab.id === gone.id) ? null : true,
      { timeout: 5_000, message: '标签没有被摘下' })

    // 等待期间页面被销毁（源窗口仍有效）：回挂没有意义，必须走清理分支。
    await app.evaluate(({ webContents }, id) => {
      const contents = webContents.fromId(id)
      if (contents && !contents.isDestroyed()) contents.close()
    }, goneViewId)
    await waitFor(async () => (await contentsAlive(app, goneViewId)) ? null : true,
      { timeout: 2_000, message: '页面没有在等待期间销毁' })

    const result = await pending
    assert.deepEqual(await monitor, [], '清理过程中同一标签被两个窗口同时持有')
    assert.equal(result.ok, false)
    assert.equal(result.code, 'tearoff-page-lost')
    assert.equal(result.message, '新窗口未能创建，标签页面已失效，标签已关闭')

    await waitFor(async () => {
      const leases = await leasesOf(app, gone.id)
      return leases && leases.active.length === 0 ? true : null
    }, { timeout: 5_000, message: '页面失效清理后仍残留租约' })
    const after = await snapshotOf(shell)
    assert.deepEqual(after.tabs.map((tab) => tab.id), [stay.id], '失效页面不应被回挂')
    assert.deepEqual(await ownersOf(app, gone.id), [])
  } finally {
    await injectTearoffEnv(app, { BAO_TEAROFF_INIT_DELAY_MS: null, BAO_TEAROFF_INIT_FAIL: null }).catch(() => {})
    await close()
    await server.close()
  }
})

/**
 * 审计 P2（2026-11-26）：休眠标签**本来就没有视图**，不能当成"页面已失效"——那样会把用户的
 * 标签（连同租约与会话）直接丢掉。失败回挂必须只挂元数据，**不唤醒**。
 */
test('拖出休眠标签失败：按休眠态退回源窗口，不丢标签', { timeout: 180_000 }, async () => {
  /**
   * TTL 取 8 s（而不是 2 s）：并行跑满时页面加载本身就慢，2 s 会让"标签在准备阶段就被休眠"
   * 与"打开第二个标签"抢时序，表现为 `addTab` 的「未新增标签」超时（实测）。
   * 8 s 足够两个页面都加载完，再让休眠发生。
   */
  process.env.BAO_DISCARD_TTL_MS = '8000'
  process.env.BAO_DISCARD_SWEEP_MS = '200'
  const server = await startFixtureServer({ '/sleep': page('SLEEP'), '/other': page('OTHER') })
  const { app, shell, close } = await launchApp()
  try {
    for (const [path, title] of [['/sleep', 'SLEEP'], ['/other', 'OTHER']]) {
      await shell.evaluate(() => window.baoBrowser.run({ type: 'add' }))
      await shell.evaluate((url) => window.baoBrowser.run({ type: 'navigate', address: url }), `${server.baseUrl}${path}`)
      await waitForTabLabel(shell, title)
    }
    const sleeping = await waitFor(async () => {
      const { state } = await shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' }))
      return state.tabs.find((tab) => tab.title === 'SLEEP' && tab.discarded) ?? null
    }, { timeout: 40_000, message: 'SLEEP 标签没有进入休眠' })

    await injectTearoffEnv(app, { BAO_TEAROFF_INIT_FAIL: '1' })
    const windowHandle = await app.browserWindow(shell)
    const bounds = await windowHandle.evaluate((window) => window.getBounds())
    const result = await tearoffAt(shell, { id: sleeping.id, x: bounds.x - 240, y: bounds.y + 24 })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'tearoff-failed')

    const { state } = await shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' }))
    const kept = state.tabs.find((tab) => tab.id === sleeping.id)
    assert.ok(kept, '休眠标签被丢掉了（当成页面失效）')
    assert.equal(kept.discarded, true, '回挂不能把休眠标签唤醒')
    assert.equal(kept.address, `${server.baseUrl}/sleep`)
  } finally {
    await injectTearoffEnv(app, { BAO_TEAROFF_INIT_DELAY_MS: null, BAO_TEAROFF_INIT_FAIL: null }).catch(() => {})
    delete process.env.BAO_DISCARD_TTL_MS
    delete process.env.BAO_DISCARD_SWEEP_MS
    await close()
    await server.close()
  }
})
