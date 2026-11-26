const assert = require('node:assert/strict')
const { test } = require('node:test')
const { isShellPage, launchApp, page, startFixtureServer, waitFor, waitForTabLabel } = require('./helpers.cjs')
const { activeTabOf, engineSettings, navigate, overlay, overlayControl, panelNames, snapshot } = require('./engine-helpers.cjs')

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

/**
 * 窗口里挂着的页面视图（按 children 顺序，先挂的在前面）。
 *
 * 候选视图在提交前就已经挂上来（2026-11-27），所以准备期间这里会是两个：
 * `[旧视图, 候选]`——顺序本身就是要断言的（候选必须盖在旧页上面）。
 *
 * 不能按 `http(s)` 过滤：候选是**先挂载再导航**的，此刻地址还是 `about:blank`。
 * 所以反过来排除外壳侧的视图（叠加层找不到 `bao://` 内部页也一并排除）。
 */
async function mountedPageIds(app, shell) {
  const handle = await app.browserWindow(shell)
  return handle.evaluate((window) => window.contentView.children
    .filter((child) => {
      const url = child.webContents?.getURL() ?? ''
      return !url.includes('baoOverlay=') && !url.startsWith('bao://')
    })
    .map((child) => child.webContents.id))
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
    // 准备期间候选已经挂载（盖在旧页上面），但引擎**尚未提交**：快照里仍是旧引擎。
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

/**
 * 审计 P1（2026-11-26）：准备期间旧页仍可交互，用户/页面可以在这时导航。
 * 提交只校验「切换任务 + 视图身份」不够——必须同时校验**导航版本**，否则会把用户刚导航到的 B
 * 换回快照里的 A（B 的页面状态被丢弃，属于静默数据丢失）。
 *
 * 这里用**页面内**导航（`location.href`）而不是 IPC `navigate`：后者本身就会取消切换
 * （`navigateTab()` 里的 `cancelEngineSwitch`），测不到版本校验。
 */
test('准备期间旧页导航：切换取消，不覆盖更新的页面', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({ '/a': page('A'), '/b': page('B') })
  const { app, shell, close } = await launchApp()
  try {
    await envInjection(app, { BAO_ENGINE_SWITCH_PREPARE_DELAY_MS: 2500 })
    await navigate(shell, `${server.baseUrl}/a`, 'A')
    const tabId = (await snapshot(shell)).activeId
    const oldViewId = await activeViewId(app, shell)

    const switching = setEngine(shell, 'ruffle')
    await waitPending(app, tabId, 'ruffle')

    // 旧页在准备期间导航到 B（真实用户点链接就是这个路径）。
    await evalInPage(app, oldViewId, `location.href = ${JSON.stringify(`${server.baseUrl}/b`)}`)
    await waitForTabLabel(shell, 'B')

    const result = await switching
    assert.equal(result.ok, false, '准备期间旧页导航过，切换不能提交')
    assert.equal(result.code, 'engine-switch-cancelled')

    const after = await snapshot(shell)
    assert.equal(activeTabOf(after).address, `${server.baseUrl}/b`, '不能把页面换回快照里的 A')
    assert.equal(activeTabOf(after).engine, 'ppapi', '未提交时引擎必须保持原值')
    assert.equal(await activeViewId(app, shell), oldViewId, '未提交时视图不能被替换')
  } finally {
    await close()
    await server.close()
  }
})

/**
 * 审计 P2（2026-11-26）：`navigationHistory.restore()` 没有独立截止时间，候选可能一直占着
 * `engineSwitch`（连带卡住休眠门禁与后续切换）。取消路径必须真的销毁候选，且要按
 * **WebContents ID** 验证——按 URL 找会漏掉"还没拿到 http URL 的候选"。
 */
test('被取代的候选必须销毁，且不残留挂载', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({ '/a': page('A') })
  const { app, shell, close } = await launchApp()
  const allIds = () => app.evaluate(({ webContents }) => webContents.getAllWebContents().map((item) => item.id))
  try {
    await envInjection(app, { BAO_ENGINE_SWITCH_PREPARE_DELAY_MS: 2000 })
    await navigate(shell, `${server.baseUrl}/a`, 'A')
    const tabId = (await snapshot(shell)).activeId
    const beforeIds = new Set(await allIds())

    const first = setEngine(shell, 'ruffle')
    await waitPending(app, tabId, 'ruffle')
    const fresh = (await allIds()).filter((id) => !beforeIds.has(id))
    assert.equal(fresh.length, 1, `准备阶段应恰好多一个候选 WebContents：${JSON.stringify(fresh)}`)
    const candidateId = fresh[0]

    // 切回当前引擎 = 取消在途候选（不走 prepare，直接清候选）。
    const cancelled = await setEngine(shell, 'ppapi')
    assert.equal(cancelled.ok, true, `切回当前引擎应直接成功：${cancelled.code ?? ''}`)
    const firstResult = await first
    assert.equal(firstResult.ok, false)
    assert.equal(firstResult.code, 'engine-switch-cancelled')

    await waitFor(async () => {
      const alive = await contentsAlive(app, candidateId)
      return alive ? null : true
    }, { message: `被取代的候选 WebContents ${candidateId} 没有被销毁` })

    const after = await snapshot(shell)
    assert.equal(activeTabOf(after).engine, 'ppapi', '未提交时引擎必须保持原值')
    assert.deepEqual((await allIds()).filter((id) => !beforeIds.has(id)), [], '取消后不应残留候选')
  } finally {
    await close()
    await server.close()
  }
})

/**
 * 「切换过程看得见」（2026-11-27）。
 *
 * 旧行为是等 `did-finish-load` 才把候选挂进窗口：点击到提交之间（实测 4 s，上限 15 s）
 * 界面一个字节都不变，第二次点击还会被渲染层的 `busy` 静默吞掉。现在候选先挂上来、
 * 旧视图留在下面当退路——所以这里断言的是**同时挂两个视图**，以及取消后回到一个。
 */
test('准备期间候选已挂载且旧视图仍存活：取消后只剩旧视图并可用', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({ '/one': page('第一页') })
  const { app, shell, close } = await launchApp()
  try {
    await envInjection(app, { BAO_ENGINE_SWITCH_PREPARE_DELAY_MS: 1200 })
    await navigate(shell, `${server.baseUrl}/one`, '第一页')
    const tabId = (await snapshot(shell)).activeId
    const before = await tabDiagnostics(app, tabId)
    assert.equal(await mountedPageIds(app, shell).then((ids) => ids.length), 1, '准备前只应挂一个页面视图')

    const pending = setEngine(shell, 'ruffle')
    await waitPending(app, tabId, 'ruffle')

    // 1) 可见性：候选已经盖在旧页上面；旧视图没被销毁（失败/取消的退路就是它）。
    const mounted = await mountedPageIds(app, shell)
    assert.equal(mounted.length, 2, `准备期间应同时挂载旧视图与候选：${JSON.stringify(mounted)}`)
    assert.equal(mounted[0], before.viewId, '旧视图必须留在窗口里')
    const candidateId = mounted[1]
    assert.notEqual(candidateId, before.viewId)
    assert.equal(await contentsAlive(app, before.viewId), true, '准备期间旧视图不得销毁')

    // 2) 回执：快照给出「正在切向谁」，标签在转圈，引擎还没变。
    const during = activeTabOf(await snapshot(shell))
    assert.equal(during.engine, 'ppapi', '未提交时 engine 必须保持原值')
    assert.equal(during.pendingEngine, 'ruffle', '快照必须给出在途引擎')
    assert.equal(during.loading, true, '准备期间标签必须显示加载中')

    // 3) 取消：候选卸载并销毁，旧视图回到唯一挂载且仍然可用。
    const cancelled = await setEngine(shell, 'ppapi')
    assert.equal(cancelled.ok, true, `切回当前引擎应直接成功：${cancelled.code ?? ''}`)
    const first = await pending
    assert.equal(first.code, 'engine-switch-cancelled')
    assert.deepEqual(await mountedPageIds(app, shell), [before.viewId], '取消后必须只剩旧视图')
    await waitFor(() => contentsAlive(app, candidateId).then((alive) => (alive ? null : true)), {
      message: `被取消的候选 ${candidateId} 没有被销毁`
    })
    const after = await tabDiagnostics(app, tabId)
    assert.equal(after.pendingEngine, undefined)
    assert.equal(after.viewId, before.viewId, '取消不得替换已提交视图')
    assert.equal(await evalInPage(app, before.viewId, 'document.title'), '第一页', '旧页必须还能用')
  } finally {
    await envInjection(app, { BAO_ENGINE_SWITCH_PREPARE_DELAY_MS: null }).catch(() => {})
    await close()
    await server.close()
  }
})

/**
 * 候选挂载跟着活动标签走（2026-11-27）。
 *
 * 挂载是「用户此刻看见什么」，所以只能在活动标签上挂：准备期间用户切走再切回，
 * 候选必须跟着摘掉、再挂回，绝不能留在窗口里挡住别的标签，也不能因此在后台被取消。
 */
test('准备期间切换标签：候选跟着活动标签摘挂，不挡别人也不被取消', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({ '/one': page('第一页'), '/two': page('第二页') })
  const { app, shell, close } = await launchApp()
  try {
    await envInjection(app, { BAO_ENGINE_SWITCH_PREPARE_DELAY_MS: 1800 })
    await navigate(shell, `${server.baseUrl}/one`, '第一页')
    const first = (await snapshot(shell)).activeId
    const firstView = (await tabDiagnostics(app, first)).viewId
    const second = await addTab(shell)
    await navigate(shell, `${server.baseUrl}/two`, '第二页')
    const secondView = (await tabDiagnostics(app, second.id)).viewId

    await shell.evaluate((id) => window.baoBrowser.run({ type: 'select', id }), first)
    const pending = setEngine(shell, 'ruffle')
    await waitPending(app, first, 'ruffle')
    assert.equal((await mountedPageIds(app, shell)).length, 2, '活动标签上应同时挂旧视图与候选')

    await shell.evaluate((id) => window.baoBrowser.run({ type: 'select', id }), second.id)
    const away = await mountedPageIds(app, shell)
    assert.deepEqual(away, [secondView], `切走后窗口里只应剩当前标签的视图：${JSON.stringify(away)}`)

    await shell.evaluate((id) => window.baoBrowser.run({ type: 'select', id }), first)
    const back = await mountedPageIds(app, shell)
    assert.equal(back.length, 2, `切回后候选应重新挂上：${JSON.stringify(back)}`)
    assert.equal(back[0], firstView, '旧视图仍在候选下面')

    const result = await pending
    assert.equal(result.ok, true, `切换应成功：${result.code ?? ''}`)
    assert.equal((await mountedPageIds(app, shell)).length, 1, '提交后只应剩已提交视图')
  } finally {
    await envInjection(app, { BAO_ENGINE_SWITCH_PREPARE_DELAY_MS: null }).catch(() => {})
    await close()
    await server.close()
  }
})

/**
 * 「点了就有回执」的失败半边（2026-11-27）：
 * 面板在点击瞬间就关（不再挂在可能 15 s 的 await 上），失败要说得出话。
 *
 * 这里同时守住一个易碎点：面板关掉之后 `report-failure` 的发送者角色校验
 * （`shell-overlays.ts` 的 `role`）不能再按「面板还开着」来要求，否则失败提示会被静默丢掉。
 */
test('点档位即关面板：切换失败时旧引擎保留，失败提示仍然到达', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({ '/one': page('第一页') })
  const { app, shell, close } = await launchApp()
  try {
    await envInjection(app, { BAO_ENGINE_SWITCH_FAIL: '1' })
    await navigate(shell, `${server.baseUrl}/one`, '第一页')
    const windowHandle = await app.browserWindow(shell)
    const tabId = (await snapshot(shell)).activeId

    await engineSettings(shell).click()
    await overlayControl(windowHandle, 'panel', panelNames.ruffle, {
      attribute: 'aria-pressed', value: 'false', click: true
    })
    // 面板不等结果：点击后立刻消失。
    await waitFor(async () => !await overlay(windowHandle, 'panel'), {
      message: '点档位后面板没有立即关闭。'
    })
    // 失败提示必须能到（role 校验已经不再依赖面板可见）。
    await overlayControl(windowHandle, 'toast', '关闭提示', { text: '引擎切换失败，已保留原引擎与原视图' })

    const after = await tabDiagnostics(app, tabId)
    assert.equal(after.engine, 'ppapi', '失败时引擎必须保持原值')
    assert.equal(after.pendingEngine, undefined, '候选必须清理')
    assert.equal((await mountedPageIds(app, shell)).length, 1, '失败后窗口里只应剩旧视图')
  } finally {
    await envInjection(app, { BAO_ENGINE_SWITCH_FAIL: null }).catch(() => {})
    await close()
    await server.close()
  }
})
