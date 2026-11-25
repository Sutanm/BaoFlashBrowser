const assert = require('node:assert/strict')
const { test } = require('node:test')
const { audioStateOf, isShellPage, launchApp, page, startFixtureServer, waitFor } = require('./helpers.cjs')

/**
 * 后台标签休眠（丢弃）：后台超过 TTL 的标签销毁视图省内存，切回时按原地址重建。
 *
 * 用 `BAO_DISCARD_TTL_MS` / `BAO_DISCARD_SWEEP_MS` 把时间片缩短到毫秒级，避免测试等 10 分钟。
 *
 * 「保持活跃」的判定权威是活动租约（`app/src/main/activity-lease.ts`，架构 §7）：
 * 用户标记 = `user` owner 的无期限 `preventsDiscard` 租约。租约的纯逻辑分支
 * （多个 owner、过期清理、按 tabId 隔离）在 `tests/unit/activity-lease.test.ts`；
 * 这里验证真实 Electron 下的生命周期接线：标记/取消、跨窗口移动、关闭清理。
 */

const state = (shell) => shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' })).then((result) => result.state)

function withDiscardEnv() {
  // TTL 要长于页面首次加载，否则会在加载途中就被休眠，测不到「加载完成后休眠」这条主路径。
  process.env.BAO_DISCARD_TTL_MS = '3000'
  process.env.BAO_DISCARD_SWEEP_MS = '300'
}

function clearDiscardEnv() {
  delete process.env.BAO_DISCARD_TTL_MS
  delete process.env.BAO_DISCARD_SWEEP_MS
}

test('后台标签超时休眠，切回时按原地址重建', { timeout: 120_000 }, async () => {
  withDiscardEnv()
  const server = await startFixtureServer({
    '/a': page('A'),
    '/b': page('B')
  })
  const { app, shell, close } = await launchApp()
  try {
    // 打开两个页面标签（起始页保持活动，A/B 都在后台）
    for (const path of ['/a', '/b']) {
      await shell.evaluate(() => window.baoBrowser.run({ type: 'add' }))
      await shell.evaluate((url) => window.baoBrowser.run({ type: 'navigate', address: url }), `${server.baseUrl}${path}`)
      await waitFor(async () => (await state(shell)).tabs.some((tab) => tab.title === path.slice(1).toUpperCase() && !tab.loading),
        { message: `标签 ${path} 没有加载完` })
    }

    // 只有 A 在后台（B 是当前标签），所以等 A 被休眠即可。
    const discarded = await waitFor(async () => {
      const list = (await state(shell)).tabs.filter((tab) => tab.discarded)
      return list.length >= 1 ? list : null
    }, { timeout: 20_000, message: '后台标签没有被休眠' })
    assert.deepEqual(discarded.map((tab) => tab.title), ['A'])
    // 休眠标签仍保留地址与标题，界面不会变成空白页
    assert.ok(discarded.every((tab) => tab.address.startsWith(server.baseUrl)))
    assert.ok(discarded.every((tab) => tab.loading === false && tab.crashed === false))

    // 切回休眠标签：应被唤醒并重新加载到同一地址
    const victim = discarded.find((tab) => tab.title === 'A')
    await shell.evaluate((id) => window.baoBrowser.run({ type: 'select', id }), victim.id)
    const revived = await waitFor(async () => {
      const tab = (await state(shell)).tabs.find((item) => item.id === victim.id)
      // 唤醒是「先重建视图、再重新加载」：等到标题与地址都恢复才算完成。
      return tab && !tab.discarded && !tab.loading && tab.title === 'A' ? tab : null
    }, { timeout: 15_000, message: '休眠标签没有被唤醒' })
    assert.equal(revived.title, 'A')
    assert.equal(revived.address, `${server.baseUrl}/a`)
  } finally {
    await close()
    await server.close()
    clearDiscardEnv()
  }
})

/**
 * 截获一次标签右键菜单的模板。
 *
 * 右键菜单是原生 `Menu`，冒烟里点不到；这里只把「构建 + 弹出」换成记录模板，
 * 命令仍然走真实的 `browser:command` IPC 与 `showTabMenu()`。传入 `clickLabel` 时
 * 会执行该菜单项的 click 回调（与用户点它等价）。
 */
async function withTabMenu(app, shell, tabId, clickLabel) {
  await app.evaluate(({ Menu }) => {
    const original = Menu.buildFromTemplate
    globalThis.__baoTabMenu = undefined
    Menu.buildFromTemplate = (template) => {
      globalThis.__baoTabMenu = template
      return { popup() {} }
    }
    globalThis.__baoRestoreTabMenu = () => {
      Menu.buildFromTemplate = original
      delete globalThis.__baoRestoreTabMenu
    }
  })
  try {
    const opened = await shell.evaluate((id) => window.baoBrowser.run({ type: 'tab-menu', id }), tabId)
    assert.equal(opened.ok, true, `打开右键菜单失败：${opened.code ?? ''}`)
    return app.evaluate((_electron, label) => {
      const template = globalThis.__baoTabMenu ?? []
      const items = template.map((item) => ({ label: item.label, type: item.type, checked: item.checked }))
      if (!label) return { items, clicked: null }
      const item = template.find((entry) => entry.label === label)
      if (!item) return { items, clicked: false }
      item.click()
      return { items, clicked: true }
    }, clickLabel ?? null)
  } finally {
    await app.evaluate(() => {
      globalThis.__baoRestoreTabMenu?.()
      delete globalThis.__baoTabMenu
    })
  }
}

test('静音标签休眠唤醒后仍静音；休眠标签的菜单读逻辑状态', { timeout: 150_000 }, async () => {
  withDiscardEnv()
  const server = await startFixtureServer({ '/j': page('J') })
  const { app, shell, close } = await launchApp()
  const url = `${server.baseUrl}/j`
  try {
    const tab = await openPage(shell, server.baseUrl, '/j', 'J')
    assert.equal((await shell.evaluate((id) => window.baoBrowser.run({ type: 'mute', id }), tab.id)).ok, true)
    await waitFor(async () => ((await audioStateOf(app, url))?.muted ? true : null),
      { message: '静音没有作用到实际的 WebContents' })

    // 让 J 真正进入后台并等 TTL：视图连同 WebContents 一起被销毁。
    await shell.evaluate(() => window.baoBrowser.run({ type: 'add' }))
    const discarded = await waitFor(async () => {
      const item = (await state(shell)).tabs.find((entry) => entry.id === tab.id)
      return item?.discarded ? item : null
    }, { timeout: 20_000, message: '静音标签没有被休眠' })
    assert.equal(discarded.muted, true, '休眠标签应保留逻辑静音状态')
    assert.equal(await audioStateOf(app, url), undefined, '休眠后不应还有该地址的 WebContents')

    // 休眠标签没有 WebContents：菜单必须读逻辑状态，显示「取消静音」。
    const menu = await withTabMenu(app, shell, tab.id)
    const labels = menu.items.map((item) => item.label).filter(Boolean)
    assert.ok(labels.includes('取消静音'),
      `休眠静音标签的菜单应显示「取消静音」，实际：${labels.join(' / ')}`)

    // 点菜单项只改逻辑状态（此时没有 WebContents 可设）；再静音回去，验证唤醒迁移。
    const clicked = await withTabMenu(app, shell, tab.id, '取消静音')
    assert.equal(clicked.clicked, true,
      `休眠标签的菜单项应可执行，实际：${clicked.items.map((item) => item.label ?? item.type).join(' / ')}`)
    await waitFor(async () => {
      const item = (await state(shell)).tabs.find((entry) => entry.id === tab.id)
      return item && item.muted === false ? item : null
    }, { message: '菜单「取消静音」没有更新逻辑静音状态' })
    assert.equal((await shell.evaluate((id) => window.baoBrowser.run({ type: 'mute', id }), tab.id)).ok, true)

    // 唤醒：重建出的 WebContents 必须实际静音（回归：旧实现只恢复了快照）。
    await shell.evaluate((id) => window.baoBrowser.run({ type: 'select', id }), tab.id)
    await waitFor(async () => {
      const item = (await state(shell)).tabs.find((entry) => entry.id === tab.id)
      return item && !item.discarded && !item.loading && item.address === url ? item : null
    }, { timeout: 15_000, message: '休眠标签没有被唤醒' })
    const actual = await waitFor(async () => {
      const entry = await audioStateOf(app, url)
      return entry && !entry.destroyed ? entry : null
    }, { message: '唤醒后找不到该地址的 WebContents' })
    assert.equal(actual.muted, true, '唤醒后的 WebContents 必须实际静音')
  } finally {
    await close()
    await server.close()
    clearDiscardEnv()
  }
})

/**
 * `tab.discard = never` 必须真的关掉休眠机制。
 *
 * 旧用例的待测网页一直是**当前标签**，而扫描器本来就不休眠当前标签——把 never 设置
 * 忽略掉用例照样通过（伪阳性）。这里先用同一条件跑 `auto` 正向对照：后台标签必须被
 * 休眠，证明 TTL 与扫描都真的跑过；再切到 `never`，同样后台、同样等两倍 TTL。
 */
test('tab.discard=never：同条件的 auto 对照会休眠，never 下不被休眠', { timeout: 150_000 }, async () => {
  withDiscardEnv()
  const server = await startFixtureServer({ '/c': page('C'), '/d': page('D') })
  const { app, shell, close } = await launchApp()
  try {
    // 正向对照：默认 auto，后台标签 C 必须被休眠。
    const auto = await openPage(shell, server.baseUrl, '/c', 'C')
    await shell.evaluate(() => window.baoBrowser.run({ type: 'add' }))
    assert.notEqual((await state(shell)).activeId, auto.id, '新标签应接管活动状态，让 C 进入后台')
    await waitFor(async () => {
      const item = (await state(shell)).tabs.find((entry) => entry.id === auto.id)
      return item?.discarded ? item : null
    }, { timeout: 20_000, message: 'auto 对照失败：后台标签没有被休眠（TTL 或扫描器没跑）' })

    // 同条件的 never 场景：只改这一个变量。
    const written = await shell.evaluate(() =>
      window.baoBrowser.run({ type: 'set-setting', key: 'tab.discard', value: 'never' }))
    assert.equal(written.ok, true, `设置 tab.discard 应写入成功：${written.code ?? ''}`)

    const never = await openPage(shell, server.baseUrl, '/d', 'D')
    await shell.evaluate(() => window.baoBrowser.run({ type: 'add' }))
    assert.notEqual((await state(shell)).activeId, never.id, '标签 D 必须真的在后台')

    // 两倍 TTL + 期间约 20 次扫描：auto 对照已经证明足够丢弃一个后台标签。
    await new Promise((done) => setTimeout(done, 2 * Number(process.env.BAO_DISCARD_TTL_MS)))
    const item = (await state(shell)).tabs.find((entry) => entry.id === never.id)
    assert.ok(item, '标签 D 不应消失')
    assert.equal(item.discarded, undefined, 'tab.discard=never 时后台标签不应被休眠')
    assert.equal((await state(shell)).tabs.filter((tab) => tab.discarded).length, 1,
      '只有 auto 对照的那个标签应处于休眠状态')
  } finally {
    await close()
    await server.close()
    clearDiscardEnv()
  }
})

test('标记「保持活跃」的标签不被休眠，取消标记后恢复休眠', { timeout: 120_000 }, async () => {
  withDiscardEnv()
  const server = await startFixtureServer({ '/d': page('D') })
  const { app, shell, close } = await launchApp()
  try {
    await shell.evaluate(() => window.baoBrowser.run({ type: 'add' }))
    await shell.evaluate((url) => window.baoBrowser.run({ type: 'navigate', address: url }), `${server.baseUrl}/d`)
    const tab = await waitFor(async () => {
      const found = (await state(shell)).tabs.find((item) => item.title === 'D' && !item.loading)
      return found ?? null
    }, { message: '标签 D 没有加载完' })

    const marked = await shell.evaluate((id) => window.baoBrowser.run({ type: 'keep-awake', id, value: true }), tab.id)
    assert.equal(marked.ok, true)
    // 让 D 退到后台：扫描器不会休眠当前标签，所以必须先把别的标签切成活动。
    await shell.evaluate(() => window.baoBrowser.run({ type: 'add' }))
    await new Promise((done) => setTimeout(done, 400))

    // 等三倍 TTL：标记期间不应该被休眠
    await new Promise((done) => setTimeout(done, 3000))
    const kept = (await state(shell)).tabs.find((item) => item.id === tab.id)
    assert.equal(kept.discarded, undefined, '标记保持活跃后不应被休眠')
    assert.equal(kept.keepAwake, true)

    // 取消标记后重新计入后台时间，TTL 到点后应休眠
    await shell.evaluate((id) => window.baoBrowser.run({ type: 'keep-awake', id, value: false }), tab.id)
    const discarded = await waitFor(async () => {
      const item = (await state(shell)).tabs.find((entry) => entry.id === tab.id)
      return item?.discarded ? item : null
    }, { timeout: 15_000, message: '取消标记后仍未休眠' })
    assert.equal(discarded.title, 'D')
  } finally {
    await close()
    await server.close()
    clearDiscardEnv()
  }
})

/** 打开一个页面标签并等它加载完（`add` 会新建并选中一个 NTP，随后导航它）。 */
async function openPage(shell, baseUrl, path, title) {
  await shell.evaluate(() => window.baoBrowser.run({ type: 'add' }))
  await shell.evaluate((url) => window.baoBrowser.run({ type: 'navigate', address: url }), `${baseUrl}${path}`)
  return waitFor(async () => {
    const found = (await state(shell)).tabs.find((item) => item.title === title && !item.loading)
    return found ?? null
  }, { message: `标签 ${title} 没有加载完` })
}

test('保持活跃只作用于该标签：另一个后台标签照常休眠', { timeout: 120_000 }, async () => {
  withDiscardEnv()
  const server = await startFixtureServer({ '/e': page('E'), '/f': page('F') })
  const { app, shell, close } = await launchApp()
  try {
    // E 标记「保持活跃」，F 不标记：两个标签随后都退到后台。
    const kept = await openPage(shell, server.baseUrl, '/e', 'E')
    const marked = await shell.evaluate((id) => window.baoBrowser.run({ type: 'keep-awake', id, value: true }), kept.id)
    assert.equal(marked.ok, true)
    const plain = await openPage(shell, server.baseUrl, '/f', 'F')

    // 再开一个新标签页，让 E 和 F 都进入后台（扫描器不休眠当前标签）。
    await shell.evaluate(() => window.baoBrowser.run({ type: 'add' }))

    // 没租约的 F 到点休眠；持有 user 租约的 E 不动：任意一条 preventsDiscard 租约按 tabId 生效。
    const discarded = await waitFor(async () => {
      const item = (await state(shell)).tabs.find((entry) => entry.id === plain.id)
      return item?.discarded ? item : null
    }, { timeout: 20_000, message: '未标记保持活跃的后台标签没有被休眠' })
    assert.equal(discarded.title, 'F')

    const awake = (await state(shell)).tabs.find((entry) => entry.id === kept.id)
    assert.equal(awake.discarded, undefined, '持有 user 租约的标签不应被休眠')
    assert.equal(awake.keepAwake, true)
  } finally {
    await close()
    await server.close()
    clearDiscardEnv()
  }
})

test('拖出标签到新窗口后仍保留保持活跃租约', { timeout: 180_000 }, async () => {
  withDiscardEnv()
  const server = await startFixtureServer({ '/g': page('G') })
  const { app, shell, close } = await launchApp()
  try {
    const moved = await openPage(shell, server.baseUrl, '/g', 'G')
    const marked = await shell.evaluate((id) => window.baoBrowser.run({ type: 'keep-awake', id, value: true }), moved.id)
    assert.equal(marked.ok, true)

    // 拖出窗口：标签对象与 tabId 一起换宿主（租约按 tabId 归属，不能跟着窗口走）。
    const windowHandle = await app.browserWindow(shell)
    const bounds = await windowHandle.evaluate((window) => window.getBounds())
    const torn = await shell.evaluate(({ id, x, y }) =>
      window.baoBrowser.run({ type: 'tearoff', id, screenX: x, screenY: y }),
      { id: moved.id, x: bounds.x - 240, y: bounds.y + 24 })
    assert.equal(torn.ok, true)

    const target = await waitFor(async () => {
      const list = (await app.windows()).filter(isShellPage).filter((candidate) => candidate !== shell)
      return list.length >= 1 ? list[0] : null
    }, { message: '拖出标签后未创建新窗口' })

    // 新窗口里再开一个标签，让被移交的标签退到后台；等 1.5 倍 TTL（3 s TTL，留出扫描误差）
    // 确认它没被休眠。正向对照在下面：取消标记后同一个窗口确实会休眠它，说明扫描器在跑。
    await target.evaluate(() => window.baoBrowser.run({ type: 'add' }))
    await new Promise((done) => setTimeout(done, 4500))
    const movedState = (await state(target)).tabs.find((item) => item.id === moved.id)
    assert.equal(movedState.keepAwake, true, '跨窗口移动后应仍能看到保持活跃标记')
    assert.equal(movedState.discarded, undefined, '跨窗口移动后租约丢失，标签被错误休眠')

    // 在新窗口里取消标记：应恢复休眠资格（释放也按 tabId 走，不认原窗口）。
    await target.evaluate((id) => window.baoBrowser.run({ type: 'keep-awake', id, value: false }), moved.id)
    const discarded = await waitFor(async () => {
      const item = (await state(target)).tabs.find((entry) => entry.id === moved.id)
      return item?.discarded ? item : null
    }, { timeout: 20_000, message: '跨窗口取消标记后仍未休眠' })
    assert.equal(discarded.title, 'G')
  } finally {
    await close()
    await server.close()
    clearDiscardEnv()
  }
})

test('关闭持有租约的标签后，其余标签的休眠判定不受影响', { timeout: 120_000 }, async () => {
  withDiscardEnv()
  const server = await startFixtureServer({ '/h': page('H'), '/i': page('I') })
  const { app, shell, close } = await launchApp()
  try {
    const kept = await openPage(shell, server.baseUrl, '/h', 'H')
    assert.equal((await shell.evaluate((id) => window.baoBrowser.run({ type: 'keep-awake', id, value: true }), kept.id)).ok, true)
    const plain = await openPage(shell, server.baseUrl, '/i', 'I')

    // 关掉持有租约的标签：它的租约必须随标签一起清掉，不能残留成「全局锁」。
    const closed = await shell.evaluate((id) => window.baoBrowser.run({ type: 'close', id }), kept.id)
    assert.equal(closed.ok, true)
    assert.equal((await state(shell)).tabs.some((tab) => tab.id === kept.id), false, '标签 H 应已关闭')
    assert.equal((await state(shell)).tabs.some((tab) => tab.keepAwake === true), false,
      '关闭标签后快照里不应残留保持活跃标记')

    // I 进入后台后照常休眠：关闭路径没有把租约表弄脏，也没有让扫描器提前退出。
    await shell.evaluate(() => window.baoBrowser.run({ type: 'add' }))
    const discarded = await waitFor(async () => {
      const item = (await state(shell)).tabs.find((entry) => entry.id === plain.id)
      return item?.discarded ? item : null
    }, { timeout: 20_000, message: '关闭持有租约的标签后，普通后台标签不再休眠' })
    assert.equal(discarded.title, 'I')
  } finally {
    await close()
    await server.close()
    clearDiscardEnv()
  }
})