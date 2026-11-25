const assert = require('node:assert/strict')
const { test } = require('node:test')
const { isShellPage, launchApp, page, startFixtureServer, waitFor, waitForTabLabel } = require('./helpers.cjs')
const { activeTabOf, navigate, snapshot } = require('./engine-helpers.cjs')

/**
 * 两阶段引擎切换（M2 退出条件）。
 *
 * 成功只认候选视图**真实加载完成**（did-finish-load）；准备期间旧视图/引擎/绑定代际保持有效。
 * 这里断言的是主进程现场（`__baoEngineDiagnostics` 暴露的真实 viewId/binding），
 * 不是只看 UI 快照。
 */

const setEngine = (shell, engine) =>
  shell.evaluate((value) => window.baoBrowser.run({ type: 'set-engine', engine: value }), engine)

function envInjection(app, values) {
  return app.evaluate((_electron, env) => {
    for (const [key, value] of Object.entries(env)) {
      if (value === null) delete process.env[key]
      else process.env[key] = String(value)
    }
  }, values)
}

/** 主进程诊断：每个窗口每个标签的真实视图、绑定代际与未提交候选。 */
function diagnostics(app) {
  return app.evaluate(async () => {
    const read = globalThis.__baoEngineDiagnostics
    return typeof read === 'function' ? read() : null
  })
}

async function tabDiagnostics(app, tabId) {
  const windows = await diagnostics(app)
  assert.ok(Array.isArray(windows), '主进程引擎诊断钩子不可用')
  for (const window of windows) {
    const tab = window.tabs.find((item) => item.id === tabId)
    if (tab) return tab
  }
  return undefined
}

/** 主进程里所有 http(s) 页面 WebContents（候选视图也算）。 */
function pageContents(app) {
  return app.evaluate(({ webContents }) => webContents.getAllWebContents().flatMap((contents) => {
    try {
      const url = contents.getURL()
      return /^https?:/.test(url) ? [{ id: contents.id, url, destroyed: contents.isDestroyed() }] : []
    } catch {
      return []
    }
  }))
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

async function activeViewId(app, shell) {
  const handle = await app.browserWindow(shell)
  return handle.evaluate((window) => {
    const view = window.contentView.children.find((child) => {
      const url = child.webContents?.getURL() ?? ''
      return /^https?:/.test(url)
    })
    return view ? view.webContents.id : -1
  })
}

async function addTab(shell) {
  const before = await snapshot(shell)
  await shell.evaluate(() => window.baoBrowser.run({ type: 'add' }))
  await waitFor(async () => {
    const state = await snapshot(shell)
    return state.tabs.length === before.tabs.length + 1 && state.tabs.every((tab) => !tab.loading)
  }, { message: '未新增标签' })
  return activeTabOf(await snapshot(shell))
}

async function windowBounds(app, shell) {
  const handle = await app.browserWindow(shell)
  return handle.evaluate((window) => window.getBounds())
}

const tearoff = (shell, id, bounds) => shell.evaluate(({ id: tabId, x, y }) =>
  window.baoBrowser.run({ type: 'tearoff', id: tabId, screenX: x, screenY: y }), { id, x: bounds.x - 240, y: bounds.y + 24 })

/** 等准备阶段的候选出现（pendingEngine），用来在提交前施加并发操作。 */
function waitPending(app, tabId, engine) {
  return waitFor(async () => {
    const tab = await tabDiagnostics(app, tabId)
    return tab?.pendingEngine === engine ? tab : null
  }, { message: `标签 ${tabId} 没有进入 ${engine} 的准备阶段` })
}

test('两阶段切换成功：加载完成后才提交，旧视图销毁、绑定代际推进', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({ '/one': page('第一页'), '/two': page('第二页') })
  const { app, shell, close } = await launchApp()
  try {
    await navigate(shell, `${server.baseUrl}/one`, '第一页')
    await navigate(shell, `${server.baseUrl}/two`, '第二页')
    const before = await snapshot(shell)
    const tabId = before.activeId
    const first = await tabDiagnostics(app, tabId)
    assert.equal(activeTabOf(before).engine, 'ppapi')
    assert.equal(activeTabOf(before).canGoBack, true)
    assert.ok(first)

    const switched = await setEngine(shell, 'ruffle')
    assert.equal(switched.ok, true, `切换失败：${switched.code ?? ''}`)
    const after = await snapshot(shell)
    assert.equal(activeTabOf(after).engine, 'ruffle')
    assert.equal(activeTabOf(after).engineSource, 'manual')
    assert.ok(activeTabOf(after).address.endsWith('/two'), `切换后地址丢失：${activeTabOf(after).address}`)
    assert.equal(activeTabOf(after).canGoBack, true, '切换后导航栈未恢复')
    assert.equal(activeTabOf(after).notice, undefined, '完整恢复不应出现降级提示')

    const second = await tabDiagnostics(app, tabId)
    assert.equal(second.binding, first.binding + 1, '提交时应只推进一代绑定')
    assert.notEqual(second.viewId, first.viewId, '提交后应换成候选 WebContents')
    assert.equal(second.viewAlive, true)
    assert.equal(second.pendingEngine, undefined)
    assert.equal(await contentsAlive(app, first.viewId), false, '旧视图必须销毁')
    assert.equal(await activeViewId(app, shell), second.viewId, '窗口里挂载的必须是已提交视图')

    // 再切回 PPAPI：同样两阶段提交，代际继续推进。
    const back = await setEngine(shell, 'ppapi')
    assert.equal(back.ok, true, `切回失败：${back.code ?? ''}`)
    const third = await tabDiagnostics(app, tabId)
    assert.equal(third.engine, 'ppapi')
    assert.equal(third.binding, second.binding + 1)
    assert.notEqual(third.viewId, second.viewId)
    assert.equal(await contentsAlive(app, second.viewId), false)
  } finally {
    await close()
    await server.close()
  }
})

test('恢复失败但已切换：导航历史降级，旧视图清理且文案不声称回退', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({ '/one': page('第一页'), '/two': page('第二页') })
  const { app, shell, close } = await launchApp()
  try {
    await navigate(shell, `${server.baseUrl}/one`, '第一页')
    await navigate(shell, `${server.baseUrl}/two`, '第二页')
    const before = await snapshot(shell)
    const tabId = before.activeId
    const first = await tabDiagnostics(app, tabId)
    await envInjection(app, { BAO_ENGINE_SWITCH_RESTORE_FAIL: 1 })

    const switched = await setEngine(shell, 'ruffle')
    assert.equal(switched.ok, true, `降级切换应已提交：${switched.code ?? ''}`)
    const after = await snapshot(shell)
    const tab = activeTabOf(after)
    assert.equal(tab.engine, 'ruffle', '降级路径仍然是已切换')
    assert.ok(tab.address.endsWith('/two'), `降级后地址不对：${tab.address}`)
    assert.ok(tab.notice, '降级提交必须有提示')
    assert.match(tab.notice.message, /已切换引擎，但导航历史未能恢复/)
    assert.match(tab.notice.message, /\/two/)
    assert.doesNotMatch(tab.notice.message, /退回|保留原引擎/)

    const second = await tabDiagnostics(app, tabId)
    // 注意：UI 的 canGoBack 还包含「从 NTP 进来的虚拟 Back」，这里直接查新视图的真实历史。
    const actualHistory = await app.evaluate(({ webContents }, id) => {
      const contents = webContents.fromId(id)
      if (!contents || contents.isDestroyed()) return null
      return {
        canGoBack: contents.navigationHistory.canGoBack(),
        entries: contents.navigationHistory.getAllEntries().length
      }
    }, second.viewId)
    assert.deepEqual(actualHistory, { canGoBack: false, entries: 1 },
      'restore 失败后不应声称历史已恢复')
    assert.equal(second.binding, first.binding + 1)
    assert.notEqual(second.viewId, first.viewId)
    assert.equal(await contentsAlive(app, first.viewId), false, '降级提交后旧视图仍要清理')
    assert.equal(await activeViewId(app, shell), second.viewId)
  } finally {
    await envInjection(app, { BAO_ENGINE_SWITCH_RESTORE_FAIL: null }).catch(() => {})
    await close()
    await server.close()
  }
})

test('候选加载失败：未提交，旧视图/引擎/代际保持可用，候选被清理', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({ '/one': page('第一页') })
  const { app, shell, close } = await launchApp()
  try {
    await navigate(shell, `${server.baseUrl}/one`, '第一页')
    const before = await snapshot(shell)
    const tabId = before.activeId
    const first = await tabDiagnostics(app, tabId)
    const viewId = await activeViewId(app, shell)
    await evalInPage(app, viewId, `window.__engineMarker = 'old-page'`)
    await envInjection(app, { BAO_ENGINE_SWITCH_FAIL: 1 })

    const switched = await setEngine(shell, 'ruffle')
    assert.equal(switched.ok, false)
    assert.equal(switched.code, 'engine-switch-failed')
    assert.equal(switched.message, '引擎切换失败，已保留原引擎与原视图')

    const after = await snapshot(shell)
    assert.equal(activeTabOf(after).engine, 'ppapi', '失败后引擎不应变化')
    assert.equal(activeTabOf(after).address, `${server.baseUrl}/one`)
    const second = await tabDiagnostics(app, tabId)
    assert.equal(second.binding, first.binding, '失败时绑定代际不应推进')
    assert.equal(second.viewId, first.viewId, '失败时不应替换视图')
    assert.equal(second.viewAlive, true)
    assert.equal(await activeViewId(app, shell), viewId, '窗口里仍是旧视图')
    assert.equal(await contentsAlive(app, viewId), true)
    assert.equal(await evalInPage(app, viewId, 'window.__engineMarker'), 'old-page', '旧页面应仍可执行脚本')
    const pages = await pageContents(app)
    assert.equal(pages.length, 1, `候选视图没有清理：${JSON.stringify(pages)}`)
    assert.equal(pages[0].id, viewId)
  } finally {
    await envInjection(app, { BAO_ENGINE_SWITCH_FAIL: null }).catch(() => {})
    await close()
    await server.close()
  }
})

test('准备期间被新切换取代：第一次取消，只有第二次提交', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({ '/one': page('第一页') })
  const { app, shell, close } = await launchApp()
  try {
    await navigate(shell, `${server.baseUrl}/one`, '第一页')
    const before = await snapshot(shell)
    const tabId = before.activeId
    const first = await tabDiagnostics(app, tabId)
    await envInjection(app, { BAO_ENGINE_SWITCH_PREPARE_DELAY_MS: 1200 })

    const pending = setEngine(shell, 'ruffle')
    await waitPending(app, tabId, 'ruffle')
    // 准备期间旧视图仍是唯一「已挂载页面」，候选尚未提交。
    assert.equal((await snapshot(shell)).tabs.find((tab) => tab.id === tabId)?.engine, 'ppapi')
    const replaced = await setEngine(shell, 'ruffle')
    const superseded = await pending

    assert.equal(superseded.ok, false)
    assert.equal(superseded.code, 'engine-switch-cancelled', '被取代的请求不能声称成功或失败')
    assert.equal(superseded.message, '引擎切换已取消，未提交任何变更')
    assert.equal(replaced.ok, true, `第二次切换应成功：${replaced.code ?? ''}`)

    const after = await tabDiagnostics(app, tabId)
    assert.equal(after.engine, 'ruffle')
    assert.equal(after.binding, first.binding + 1, '只有最后一次提交推进一代')
    assert.notEqual(after.viewId, first.viewId)
    assert.equal(after.pendingEngine, undefined)
    assert.equal(await contentsAlive(app, first.viewId), false, '旧视图应清理')
    const pages = await pageContents(app)
    assert.equal(pages.length, 1, `被取代的候选没有清理：${JSON.stringify(pages)}`)
    assert.equal(pages[0].id, after.viewId)
  } finally {
    await envInjection(app, { BAO_ENGINE_SWITCH_PREPARE_DELAY_MS: null }).catch(() => {})
    await close()
    await server.close()
  }
})

test('准备期间关闭标签：请求取消、候选清理、不残留孤儿', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({ '/one': page('第一页'), '/two': page('第二页') })
  const { app, shell, close } = await launchApp()
  try {
    await navigate(shell, `${server.baseUrl}/one`, '第一页')
    const victim = await addTab(shell)
    await shell.evaluate((url) => window.baoBrowser.run({ type: 'navigate', address: url }), `${server.baseUrl}/two`)
    await waitForTabLabel(shell, '第二页')
    const before = await tabDiagnostics(app, victim.id)
    await envInjection(app, { BAO_ENGINE_SWITCH_PREPARE_DELAY_MS: 1200 })

    const pending = setEngine(shell, 'ruffle')
    await waitPending(app, victim.id, 'ruffle')
    assert.equal((await shell.evaluate((id) => window.baoBrowser.run({ type: 'close', id }), victim.id)).ok, true)
    const cancelled = await pending
    assert.equal(cancelled.ok, false)
    assert.equal(cancelled.code, 'engine-switch-cancelled')
    assert.equal(await tabDiagnostics(app, victim.id), undefined, '关闭后标签不应再出现在诊断里')
    assert.equal(await contentsAlive(app, before.viewId), false, '旧视图应随标签关闭')
    const pages = await pageContents(app)
    assert.equal(pages.filter((entry) => entry.url.endsWith('/two')).length, 0, '候选/旧视图都不应残留')
    assert.equal(pages.filter((entry) => entry.url.endsWith('/one')).length, 1, '其它标签不应受影响')
  } finally {
    await envInjection(app, { BAO_ENGINE_SWITCH_PREPARE_DELAY_MS: null }).catch(() => {})
    await close()
    await server.close()
  }
})

test('准备期间跨窗口移交：请求取消，新窗口保留旧引擎与同一视图', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({ '/one': page('第一页'), '/two': page('第二页') })
  const { app, shell, close } = await launchApp()
  try {
    await navigate(shell, `${server.baseUrl}/one`, '第一页')
    const moving = activeTabOf(await snapshot(shell))
    await addTab(shell)
    await navigate(shell, `${server.baseUrl}/two`, '第二页')
    await shell.evaluate((id) => window.baoBrowser.run({ type: 'select', id }), moving.id)
    const before = await tabDiagnostics(app, moving.id)
    const bounds = await windowBounds(app, shell)
    await envInjection(app, { BAO_ENGINE_SWITCH_PREPARE_DELAY_MS: 1200 })

    const pending = setEngine(shell, 'ruffle')
    await waitPending(app, moving.id, 'ruffle')
    await tearoff(shell, moving.id, bounds)
    const cancelled = await pending
    assert.equal(cancelled.ok, false)
    assert.equal(cancelled.code, 'engine-switch-cancelled')

    const target = await waitFor(async () => {
      const candidates = (await app.windows()).filter((candidate) => isShellPage(candidate) && !candidate.isClosed())
      return candidates.find((candidate) => candidate !== shell) ?? null
    }, { message: '移交后没有新窗口' })
    const targetState = await waitFor(async () => {
      const state = await snapshot(target)
      return state.tabs.some((tab) => tab.id === moving.id) ? state : null
    }, { message: '新窗口没有接管标签' })
    const migrated = targetState.tabs.find((tab) => tab.id === moving.id)
    assert.equal(migrated.engine, 'ppapi', '移交期间取消的切换不应改引擎')
    const after = await tabDiagnostics(app, moving.id)
    assert.equal(after.binding, before.binding, '移交不推进绑定代际')
    assert.equal(after.viewId, before.viewId, '移交应复用旧视图')
    assert.equal(after.viewAlive, true)
    assert.equal(after.pendingEngine, undefined)
    assert.equal(await contentsAlive(app, before.viewId), true)
    const pages = await pageContents(app)
    assert.equal(pages.filter((entry) => entry.url.endsWith('/one')).length, 1, '候选视图没有清理')
  } finally {
    await envInjection(app, { BAO_ENGINE_SWITCH_PREPARE_DELAY_MS: null }).catch(() => {})
    await close()
    await server.close()
  }
})
