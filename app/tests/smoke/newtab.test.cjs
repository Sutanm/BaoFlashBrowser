const assert = require('node:assert/strict')
const { test } = require('node:test')
const { launchApp, page, pressShortcut, startFixtureServer, waitFor } = require('./helpers.cjs')

/**
 * 新标签页（`bao://newtab`）的合同验证——对齐 Chrome 的 NTP 语义。
 *
 * 覆盖点：
 * - 身份：启动首个标签就是真实内部页 `bao://newtab/`，地址栏为空、没有引擎胶囊；
 * - 覆盖：设置页把当前 NTP **就地**导航掉（不是新开标签），后退可回 NTP；
 * - 复用：已经有设置标签时，NTP 上的入口只是切过去，NTP 保留；
 * - 离开：NTP 里输入 http(s) 走同一个标签（内部会话永不承载网页）；
 * - 撤销关闭：纯 NTP 标签不入栈（Chrome 的 `IsTabInteresting`）；
 * - 边界：NTP 没有任何外壳桥；普通页面也访问不到 `bao://newtab`。
 */

const snapshot = (shell) =>
  shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' })).then((result) => result.state)

const activeTab = (state) => state.tabs.find((tab) => tab.id === state.activeId)

async function internalContentsId(app, prefix) {
  return app.evaluate(({ webContents }, urlPrefix) => {
    const target = webContents.getAllWebContents()
      .find((contents) => (contents.getURL() ?? '').startsWith(urlPrefix))
    return target ? target.id : null
  }, prefix)
}

function inContents(app, id, code) {
  return app.evaluate(({ webContents }, payload) => {
    const target = webContents.fromId(payload.id)
    if (!target) throw new Error('目标 WebContents 已销毁')
    return target.executeJavaScript(payload.code)
  }, { id, code })
}

test('新标签页：接管已完成首帧的预渲染视图，并在后台补池', { timeout: 120_000 }, async () => {
  const { app, shell, close } = await launchApp({ env: {
    BAO_SMOKE_HIDDEN: '0',
    BAO_SMOKE_BACKGROUND: '1',
    BAO_NTP_PREWARM_IN_SMOKE: '1'
  } })
  try {
    const views = () => app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().endsWith('index.html'))
      return window?.contentView.children
        .filter((child) => child.webContents && child.webContents !== window.webContents)
        .map((child) => ({ id: child.webContents.id, url: child.webContents.getURL() })) ?? []
    })

    // index 0 是被活动 NTP 完全覆盖的热实例；两次 RAF 完成后页面本体也应已经挂载。
    const before = await waitFor(async () => {
      const current = await views()
      if (current.length !== 2 || current.some(({ url }) => url !== 'bao://newtab/')) return null
      const ready = await inContents(app, current[0].id, `Boolean(document.querySelector('.newtab'))`)
      return ready ? current : null
    }, { message: '新标签页预渲染池没有就绪' })

    await shell.getByRole('button', { name: '新建标签页', exact: true }).click()
    await waitFor(async () => (await snapshot(shell)).tabs.length === 2 ? true : null,
      { message: '没有新建标签页' })

    const after = await waitFor(async () => {
      const current = await views()
      if (current.length !== 2 || current.some(({ url }) => url !== 'bao://newtab/')) return null
      return current[0].id !== before[0].id ? current : null
    }, { message: '接管后没有补充新的预渲染实例' })

    assert.equal(after[1].id, before[0].id, '活动标签必须复用原先已完成首帧的热视图')
    assert.notEqual(after[0].id, before[0].id, '池中应补入一个新的 NTP 视图')
    const stateApplied = await waitFor(async () => {
      const text = await inContents(app, after[1].id, `document.querySelector('.flash')?.textContent ?? ''`)
      return text ? text : null
    }, { message: '预渲染视图接管后没有收到 NTP 状态快照' })
    assert.match(stateApplied, /Flash/)
  } finally {
    await close()
  }
})

test('新标签页：启动即是真实内部页，地址栏为空、无引擎胶囊', { timeout: 120_000 }, async () => {
  const { app, shell, close } = await launchApp()
  try {
    const id = await waitFor(() => internalContentsId(app, 'bao://newtab'), { message: '新标签页没有加载' })
    const state = await snapshot(shell)
    assert.equal(state.tabs.length, 1, '启动只应有一个标签页')
    assert.equal(state.tabs[0].internal, 'newtab', '首个标签必须带新标签页身份')
    assert.equal(state.tabs[0].address, '', '地址栏不显示新标签页的 URL（Chrome 同款）')
    assert.equal(state.tabs[0].title, '新标签页')
    assert.equal(state.tabs[0].canGoBack, false)

    const url = await app.evaluate(({ webContents }, target) => webContents.fromId(target)?.getURL(), id)
    assert.equal(url, 'bao://newtab/', `新标签页的文档地址不对：${url}`)

    // 页面本体：独立 origin。两种内部页共用同一个 preload，所以 `baoSettings` 这个对象存在，
    // 但它对新标签页**没有能力**：读被主进程拒、写返回 forbidden-sender。
    const surface = await inContents(app, id, `({
      origin: location.origin,
      title: document.title,
      browser: typeof window.baoBrowser,
      settings: typeof window.baoSettings,
      overlay: typeof window.baoOverlay,
      require: typeof window.require
    })`)
    assert.equal(surface.origin, 'bao://newtab', `origin 不对：${surface.origin}`)
    assert.equal(surface.title, '新标签页')
    assert.equal(surface.settings, 'object', '内部页共用 preload（按 kind 换 preload 会打断就地导航）')
    for (const key of ['browser', 'overlay', 'require']) {
      assert.equal(surface[key], 'undefined', `新标签页不该拿到 ${key}`)
    }

    const read = await inContents(app, id, 'window.baoSettings.read()')
    assert.equal(read, undefined, '新标签页不该读到设置快照')
    const write = await inContents(app, id, `window.baoSettings.write('theme.mode', 'dark')`)
    assert.equal(write.ok, false, '新标签页不该写设置')
    assert.equal(write.code, 'forbidden-sender')

    // 新标签页自己的窄桥：只有状态与两个动词，非法地址在进导航前就被拒。
    const ntpFacts = await inContents(app, id, `(async () => {
      const state = await window.baoNtp.read()
      const bad = await window.baoNtp.run({ type: 'navigate', address: 'not a url' })
      return {
        type: typeof window.baoNtp,
        theme: state?.theme,
        flash: state?.flash,
        settings: state ? Object.keys(state.settings) : [],
        bad
      }
    })()`)
    assert.equal(ntpFacts.type, 'object')
    assert.ok(ntpFacts.theme === 'light' || ntpFacts.theme === 'dark', `主题解析不对：${ntpFacts.theme}`)
    assert.equal(typeof ntpFacts.flash, 'boolean')
    assert.deepEqual(ntpFacts.settings.sort(), ['defaultEngine', 'locale', 'themeMode'])
    assert.equal(ntpFacts.bad.ok, false)
    assert.equal(ntpFacts.bad.code, 'invalid-address')

    // 外壳 UI：地址栏空、没有引擎胶囊。
    const ui = await shell.evaluate(() => ({
      address: document.querySelector('.address-bar input')?.value,
      placeholder: document.querySelector('.address-bar input')?.placeholder,
      pill: document.querySelector('.engine-pill') !== null
    }))
    assert.equal(ui.address, '')
    assert.equal(ui.pill, false, '新标签页不应显示引擎胶囊')
  } finally {
    await close()
  }
})

test('新标签页：输入 http(s) 走同一个标签（内部会话永不承载网页）', { timeout: 120_000 }, async () => {
  const server = await startFixtureServer({ '/': page('落地页') })
  const { app, shell, close } = await launchApp()
  try {
    const initial = await snapshot(shell)
    const tabId = initial.tabs[0].id
    assert.equal(initial.tabs[0].internal, 'newtab')

    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(server.baseUrl)
    await address.press('Enter')
    await shell.getByRole('button', { name: '落地页', exact: true }).waitFor({ timeout: 30_000 })

    const state = await snapshot(shell)
    assert.equal(state.tabs.length, 1, 'NTP 里导航不应新开标签')
    assert.equal(state.tabs[0].id, tabId, '标签 id 必须保持不变')
    assert.equal(state.tabs[0].internal, undefined, '标签已变成普通网页')
    assert.equal(state.tabs[0].address, `${server.baseUrl}/`)
    assert.equal(await shell.locator('.engine-pill').count(), 1, '网页标签应显示引擎胶囊')

    // 页面会话没有 `bao://newtab` 的协议 handler：读不到内部页资源。
    const pageId = await app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().find((contents) => (contents.getURL() ?? '').startsWith('http://127.0.0.1'))?.id ?? null)
    assert.ok(pageId, '没有找到页面视图')
    const fetched = await inContents(app, pageId, `
      fetch('bao://newtab/').then(
        (response) => ({ ok: true, status: response.status }),
        (error) => ({ ok: false, reason: String(error) })
      )
    `)
    assert.equal(fetched.ok, false, `页面不该读到内部页资源：${JSON.stringify(fetched)}`)
  } finally {
    await close()
    await server.close()
  }
})

test('新标签页：复制出 NTP，关闭 NTP 不进撤销栈', { timeout: 120_000 }, async () => {
  const { shell, app, close } = await launchApp()
  try {
    const initial = await snapshot(shell)
    const tabId = initial.tabs[0].id

    const duplicated = await shell.evaluate((id) => window.baoBrowser.run({ type: 'duplicate', id }), tabId)
    assert.equal(duplicated.ok, true, `复制标签失败：${duplicated.code}`)
    assert.equal(duplicated.state.tabs.length, 2)
    const copy = duplicated.state.tabs.find((tab) => tab.id !== tabId)
    assert.equal(copy.internal, 'newtab', '复制新标签页应得到新标签页（不是空白的页面视图）')
    assert.equal(copy.address, '')
    await waitFor(async () => {
      const id = await internalContentsId(app, 'bao://newtab')
      return id ? true : null
    }, { message: '复制出的新标签页没有加载' })

    // 关闭复制出来的 NTP：不入「最近关闭」（Chrome 的 IsTabInteresting）。
    const closed = await shell.evaluate((id) => window.baoBrowser.run({ type: 'close', id }), copy.id)
    assert.equal(closed.ok, true)
    assert.equal(closed.state.tabs.length, 1)
    assert.equal(closed.state.undoCount, 0, '纯新标签页不应进入撤销关闭队列')
  } finally {
    await close()
  }
})

test('新标签页：页面里的设置入口与 realbox 都作用在本标签', { timeout: 120_000 }, async () => {
  const server = await startFixtureServer({ '/': page('落地页') })
  const { app, shell, close } = await launchApp()
  try {
    const id = await waitFor(() => internalContentsId(app, 'bao://newtab'), { message: '新标签页没有加载' })
    const initial = await snapshot(shell)
    const tabId = initial.tabs[0].id

    // ① 设置入口：与 Ctrl+, 同一条规则 → 同一个标签就地变成设置页。
    await inContents(app, id, `document.querySelector('.foot .link').click()`).catch(() => {})
    const settingsState = await waitFor(async () => {
      const state = await snapshot(shell)
      const tab = state.tabs[0]
      return state.tabs.length === 1 && tab?.internal === 'settings' && tab.address === 'bao://settings/' ? state : null
    }, { message: '页面里的设置入口没有就地打开设置页' })
    assert.equal(settingsState.tabs[0].id, tabId)

    // 设置页共用 preload，所以 `baoNtp` 对象在，但主进程按发送者拒绝它的动词。
    const rejected = await inContents(app, id, `(async () => ({
      read: await window.baoNtp.read(),
      run: await window.baoNtp.run({ type: 'open-settings' })
    }))()`)
    assert.equal(rejected.read, undefined, '设置页不该读到新标签页的快照')
    assert.equal(rejected.run.ok, false, '设置页不该使用新标签页的动词')
    assert.equal(rejected.run.code, 'forbidden-sender')

    // ② 后退回新标签页，再用 realbox 在本标签导航。
    const back = await shell.evaluate(() => window.baoBrowser.run({ type: 'back' }))
    assert.equal(back.ok, true)
    await waitFor(async () => (await snapshot(shell)).tabs[0]?.internal === 'newtab' ? true : null,
      { message: '后退没有回到新标签页' })
    await waitFor(async () => (await inContents(app, id, `Boolean(document.querySelector('.realbox input'))`))
      ? true : null, { message: '新标签页页面没有就绪' })

    await inContents(app, id, `(() => {
      const input = document.querySelector('.realbox input')
      input.value = ${JSON.stringify(server.baseUrl)}
      input.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('.realbox').requestSubmit()
    })()`).catch(() => {})
    await shell.getByRole('button', { name: '落地页', exact: true }).waitFor({ timeout: 30_000 })

    const navigated = await snapshot(shell)
    assert.equal(navigated.tabs.length, 1, 'realbox 导航不应新开标签')
    assert.equal(navigated.tabs[0].id, tabId, 'realbox 导航必须留在同一个标签')
    assert.equal(navigated.tabs[0].internal, undefined)
    assert.equal(navigated.tabs[0].address, `${server.baseUrl}/`)
  } finally {
    await close()
    await server.close()
  }
})

test('新标签页：realbox 非 URL 输入给出稳定提示，页面不跳转', { timeout: 120_000 }, async () => {
  const { app, shell, close } = await launchApp()
  try {
    const id = await waitFor(() => internalContentsId(app, 'bao://newtab'), { message: '新标签页没有加载' })
    await waitFor(async () => (await inContents(app, id, `Boolean(document.querySelector('.realbox input'))`))
      ? true : null, { message: '新标签页页面没有就绪' })
    await inContents(app, id, `(() => {
      const input = document.querySelector('.realbox input')
      input.value = 'not a url'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('.realbox').requestSubmit()
    })()`)
    const text = await waitFor(async () => {
      const value = await inContents(app, id, `document.querySelector('.error')?.textContent ?? ''`)
      return value ? value : null
    }, { message: '非法地址没有给出提示' })
    assert.match(text, /HTTP/)
    const state = await snapshot(shell)
    assert.equal(state.tabs.length, 1)
    assert.equal(state.tabs[0].internal, 'newtab', '非法输入不应离开新标签页')
  } finally {
    await close()
  }
})

test('新标签页：网页上 Back 回到 NTP，Forward 重新打开该网页', { timeout: 120_000 }, async () => {
  const server = await startFixtureServer({ '/a': page('页面 A'), '/b': page('页面 B') })
  const { app, shell, close } = await launchApp()
  try {
    const initial = await snapshot(shell)
    const tabId = initial.tabs[0].id
    const address = shell.getByRole('textbox', { name: '地址栏' })

    // NTP → 页面 A：最早一条历史之前就是 NTP，所以 Back 可用。
    await address.fill(`${server.baseUrl}/a`)
    await address.press('Enter')
    await shell.getByRole('button', { name: '页面 A', exact: true }).waitFor({ timeout: 30_000 })
    assert.equal((await snapshot(shell)).tabs[0].canGoBack, true, '从 NTP 进入网页后应能后退回 NTP')

    // 站内再走一步：Back 先回 A，再 Back 回 NTP。
    await address.fill(`${server.baseUrl}/b`)
    await address.press('Enter')
    await shell.getByRole('button', { name: '页面 B', exact: true }).waitFor({ timeout: 30_000 })
    assert.equal((await snapshot(shell)).tabs[0].canGoBack, true)

    await shell.evaluate(() => window.baoBrowser.run({ type: 'back' }))
    await waitFor(async () => (await snapshot(shell)).tabs[0]?.address.endsWith('/a') ? true : null,
      { message: '第一次后退没有回到页面 A' })

    const back = await shell.evaluate(() => window.baoBrowser.run({ type: 'back' }))
    assert.equal(back.ok, true, `后退失败：${back.code}`)
    const onNewTab = await waitFor(async () => {
      const value = await snapshot(shell)
      return value.tabs[0]?.internal === 'newtab' ? value : null
    }, { message: '后退没有回到新标签页' })
    assert.equal(onNewTab.tabs[0].id, tabId, 'Back 回 NTP 必须留在同一个标签')
    assert.equal(onNewTab.tabs[0].address, '')
    assert.equal(onNewTab.tabs[0].canGoBack, false)
    assert.equal(onNewTab.tabs[0].canGoForward, true, '回到 NTP 后应能前进回网页')
    assert.equal(await shell.locator('.engine-pill').count(), 0, 'NTP 不应显示引擎胶囊')
    const focused = await shell.evaluate(() =>
      document.activeElement === document.querySelector('.address-bar input'))
    assert.equal(focused, true, 'Back 回到 NTP 后焦点应在地址栏')

    // Forward：重新打开刚才那个网页（页面状态不保留，重新加载）。
    const forward = await shell.evaluate(() => window.baoBrowser.run({ type: 'forward' }))
    assert.equal(forward.ok, true, `前进失败：${forward.code}`)
    await shell.getByRole('button', { name: '页面 A', exact: true }).waitFor({ timeout: 30_000 })
    const backOnPage = await snapshot(shell)
    assert.equal(backOnPage.tabs[0].id, tabId)
    assert.equal(backOnPage.tabs[0].address, `${server.baseUrl}/a`)
    assert.equal(backOnPage.tabs[0].canGoBack, true, 'Forward 重开网页后仍能 Back 回 NTP')

    // 从 NTP 里直接输入新地址：旧的 Forward 目标作废。
    await shell.evaluate(() => window.baoBrowser.run({ type: 'back' }))
    await waitFor(async () => (await snapshot(shell)).tabs[0]?.internal === 'newtab' ? true : null,
      { message: '第二次 Back 没有回到新标签页' })
    await address.fill(`${server.baseUrl}/b`)
    await address.press('Enter')
    await shell.getByRole('button', { name: '页面 B', exact: true }).waitFor({ timeout: 30_000 })
    const fresh = await snapshot(shell)
    assert.equal(fresh.tabs[0].canGoForward, false, 'NTP 里新导航后不应再前进到旧页面')
  } finally {
    await close()
    await server.close()
  }
})

test('新标签页：已有设置标签时，Ctrl+, 只切过去而不覆盖 NTP', { timeout: 120_000 }, async () => {
  const { app, shell, close } = await launchApp()
  try {
    // 先把当前 NTP 就地变成设置页，再开一个新的 NTP。
    await pressShortcut(app, ',', ['control'])
    const withSettings = await waitFor(async () => {
      const state = await snapshot(shell)
      return state.tabs.length === 1 && state.tabs[0].internal === 'settings' ? state : null
    }, { message: 'Ctrl+, 没有就地打开设置页' })
    const settingsId = withSettings.tabs[0].id

    await pressShortcut(app, 't', ['control'])
    const withNewTab = await waitFor(async () => {
      const state = await snapshot(shell)
      return state.tabs.length === 2 && activeTab(state)?.internal === 'newtab' ? state : null
    }, { message: 'Ctrl+T 没有新建新标签页' })
    assert.notEqual(withNewTab.tabs[0].id, withNewTab.tabs[1].id)

    // 此时已有设置标签：Ctrl+, 应切到它，而不是把 NTP 覆盖掉。
    await pressShortcut(app, ',', ['control'])
    const switched = await waitFor(async () => {
      const state = await snapshot(shell)
      return state.activeId === settingsId ? state : null
    }, { message: 'Ctrl+, 没有切到已有设置标签' })
    assert.equal(switched.tabs.length, 2, '不应新建第三个标签')
    assert.equal(switched.tabs.find((tab) => tab.id === settingsId)?.internal, 'settings')
    assert.equal(switched.tabs.filter((tab) => tab.internal === 'newtab').length, 1, 'NTP 应保留')
  } finally {
    await close()
  }
})
