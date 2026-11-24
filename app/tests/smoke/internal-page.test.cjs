const assert = require('node:assert/strict')
const { test } = require('node:test')
const { launchApp, page, pressShortcut, startFixtureServer, waitFor } = require('./helpers.cjs')

/**
 * 内部设置页（`bao://settings`）的合同验证。
 *
 * 覆盖点：
 * - 入口：`Ctrl+,` 打开/复用设置标签，投影带 `internal`，工具栏据此隐藏引擎胶囊；
 * - 桥：内部页只有 `baoSettings`（read/write/subscribe），拿不到外壳桥；
 * - 自身可写：页面写设置 → 主进程落库 → 外壳与页面同时重绘；
 * - 边界：普通页面没有设置桥、页面标签不能导航到 `bao://`、页面里 fetch `bao://` 失败；
 * - 语义：设置页里输入 http(s) 会新开标签（内部会话永不承载网页）；
 * - 撤销关闭能恢复设置页。
 */

async function settingsViewId(app) {
  return app.evaluate(({ webContents }) => {
    const target = webContents.getAllWebContents().find((contents) => (contents.getURL() ?? '').startsWith('bao://settings'))
    return target ? target.id : null
  })
}

async function inSettings(app, code) {
  const id = await settingsViewId(app)
  assert.ok(id, '没有找到设置页的 WebContents')
  return app.evaluate(async ({ webContents }, payload) => {
    const target = webContents.fromId(payload.id)
    if (!target) throw new Error('设置页已销毁')
    return target.executeJavaScript(payload.code)
  }, { id, code })
}

const snapshot = (shell) => shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' }).then((result) => result.state))

test('设置页：Ctrl+, 打开/复用标签，只有设置桥，写入后外壳同步', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({ '/': page('设置测试页') })
  const { app, shell, close } = await launchApp()
  try {
    assert.equal((await snapshot(shell)).tabs.length, 1)

    // ① 入口：Ctrl+, 打开设置标签。
    await pressShortcut(app, ',', ['control'])
    const state = await waitFor(async () => {
      const value = await snapshot(shell)
      if (value.tabs.length !== 2) return null
      const tab = value.tabs.find((item) => item.internal === 'settings')
      return tab && tab.address === 'bao://settings/' && tab.title === '设置' ? value : null
    }, { message: 'Ctrl+, 没有打开设置标签' })

    const internal = state.tabs.find((tab) => tab.internal === 'settings')
    assert.ok(internal, '设置标签必须带 internal 标记')
    assert.equal(internal.address, 'bao://settings/')
    assert.equal(internal.title, '设置')
    assert.equal(state.activeId, internal.id, '新开的设置标签应当是选中态')

    // 再按一次：Edge 语义，复用而不是再开一个。
    await pressShortcut(app, ',', ['control'])
    await new Promise((done) => setTimeout(done, 400))
    assert.equal((await snapshot(shell)).tabs.filter((tab) => tab.internal).length, 1, '设置标签应被复用')

    // ② 桥面：内部页只有设置桥，没有外壳桥。
    const surface = await inSettings(app, `({
      settings: typeof window.baoSettings,
      read: typeof window.baoSettings?.read,
      write: typeof window.baoSettings?.write,
      browser: typeof window.baoBrowser,
      overlay: typeof window.baoOverlay,
      windowControl: typeof window.baoWindowControl,
      require: typeof window.require,
      process: typeof window.process
    })`)
    assert.deepEqual(surface, {
      settings: 'object',
      read: 'function',
      write: 'function',
      browser: 'undefined',
      overlay: 'undefined',
      windowControl: 'undefined',
      require: 'undefined',
      process: 'undefined'
    })

    // ③ 页面写设置：主进程落库 → 外壳与页面同时重绘。
    const written = await inSettings(app, `window.baoSettings.write('theme.mode', 'dark')`)
    assert.equal(written.ok, true, `设置页写入失败：${written.code}`)
    assert.equal(written.snapshot.settings.themeMode, 'dark')
    assert.equal(written.snapshot.theme, 'dark')

    await waitFor(async () => (await shell.evaluate(`document.documentElement.dataset.theme`)) === 'dark'
      ? true : null, { message: '设置页改主题后外壳没有重绘' })
    await waitFor(async () => (await inSettings(app, `document.documentElement.dataset.theme`)) === 'dark'
      ? true : null, { message: '设置页自身没有重绘' })

    const checked = await inSettings(app, `document.querySelector('.theme-stop[aria-checked="true"]')?.getAttribute('aria-label')`)
    assert.equal(checked, '深色', '设置页的选中态没有跟随写入结果')

    assert.equal((await snapshot(shell)).settings.themeMode, 'dark')
    assert.equal(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'dark')

    // ④ 页面没有设置桥，也不能把自己导航到 bao://settings。
    await shell.getByRole('textbox', { name: '地址栏' }).fill(server.baseUrl)
    await shell.getByRole('textbox', { name: '地址栏' }).press('Enter')
    await shell.getByRole('button', { name: '设置测试页', exact: true }).waitFor()
    const pageFact = await app.evaluate(({ webContents }) => {
      const page = webContents.getAllWebContents().find((contents) => (contents.getURL() ?? '').startsWith('http://127.0.0.1'))
      return page ? { id: page.id, bridge: typeof page.executeJavaScript('typeof window.baoSettings') } : null
    })
    assert.ok(pageFact, '没有找到页面视图')
    const pageBridge = await app.evaluate(async ({ webContents }, id) =>
      webContents.fromId(id).executeJavaScript('typeof window.baoSettings'), pageFact.id)
    assert.equal(pageBridge, 'undefined', '普通页面不该有设置桥')

    const blocked = await shell.evaluate(() =>
      window.baoBrowser.run({ type: 'navigate', address: 'bao://settings/' }))
    assert.equal(blocked.ok, false, '页面标签不应能直接导航到内部页')
    assert.equal(blocked.code, 'invalid-address')

    // ⑤ 设置页里输入 http(s)：新开标签，设置页原地不动（P2）。
    const settingsId = (await snapshot(shell)).tabs.find((tab) => tab.internal === 'settings').id
    const selected = await shell.evaluate((id) => window.baoBrowser.run({ type: 'select', id }), settingsId)
    assert.equal(selected.state.tabs.find((tab) => tab.id === settingsId).internal, 'settings',
      '设置标签应能重新选中')

    // 外壳 UI：设置页没有引擎胶囊，标签用齿轮图标（否则用户会以为能给设置页切引擎）。
    const shellUi = await shell.evaluate(() => ({
      pill: document.querySelector('.engine-pill') !== null,
      settingsIcon: document.querySelector('.tab.selected .settings-icon') !== null,
      address: document.querySelector('.address-bar input')?.value
    }))
    assert.equal(shellUi.pill, false, '设置页不应显示引擎胶囊')
    assert.equal(shellUi.settingsIcon, true, '设置标签应显示齿轮图标')
    assert.equal(shellUi.address, 'bao://settings/')
    const beforeCount = selected.state.tabs.length
    const navigated = await shell.evaluate((address) =>
      window.baoBrowser.run({ type: 'navigate', address }), server.baseUrl)
    assert.equal(navigated.ok, true, `从设置页导航失败：${navigated.code}`)
    const after = navigated.state
    assert.equal(after.tabs.length, beforeCount + 1, '应当新开一个普通标签')
    const stillThere = after.tabs.find((tab) => tab.internal === 'settings')
    assert.equal(stillThere.address, 'bao://settings/', '设置页必须原地不动')
    assert.equal(after.tabs.find((tab) => tab.id === after.activeId).internal, undefined,
      '选中态应当切到新开的普通标签')

    // ⑥ 撤销关闭恢复设置页（导航栈恢复）。
    await shell.evaluate((id) => window.baoBrowser.run({ type: 'close', id }), stillThere.id)
    const closedState = await snapshot(shell)
    assert.equal(closedState.tabs.filter((tab) => tab.internal).length, 0)
    assert.ok(closedState.undoCount >= 1)
    const undone = await shell.evaluate(() => window.baoBrowser.run({ type: 'undo-close' }))
    assert.equal(undone.ok, true, `撤销关闭失败：${undone.code}`)
    const restored = undone.state.tabs.find((tab) => tab.internal === 'settings')
    assert.ok(restored, '撤销关闭应恢复设置页')
    assert.equal(restored.address, 'bao://settings/')
    const restoredUrl = await waitFor(async () => {
      const id = await settingsViewId(app)
      if (!id) return null
      return app.evaluate(({ webContents }, target) => webContents.fromId(target)?.getURL(), id)
    }, { message: '恢复后的设置页没有加载' })
    assert.equal(restoredUrl, 'bao://settings/')
  } finally {
    await close()
    await server.close()
  }
})

test('设置页：页面会话无法访问 bao:// 资源', { timeout: 120_000 }, async () => {
  const server = await startFixtureServer({ '/': page('设置会话测试页') })
  const { app, shell, close } = await launchApp()
  try {
    await shell.getByRole('textbox', { name: '地址栏' }).fill(server.baseUrl)
    await shell.getByRole('textbox', { name: '地址栏' }).press('Enter')
    await shell.getByRole('button', { name: '设置会话测试页', exact: true }).waitFor()

    const pageId = await app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().find((contents) => (contents.getURL() ?? '').startsWith('http://127.0.0.1'))?.id ?? null)
    assert.ok(pageId, '没有找到页面视图')

    // 页面会话里 fetch 内部页资源：协议没绑定在该会话上，必须失败。
    const result = await app.evaluate(async ({ webContents }, id) => {
      const page = webContents.fromId(id)
      if (!page) return { ok: false, reason: 'missing' }
      return page.executeJavaScript(`
        fetch('bao://settings/').then(
          (response) => ({ ok: true, status: response.status }),
          (error) => ({ ok: false, reason: String(error) })
        )
      `)
    }, pageId)
    assert.equal(result.ok, false, `页面不该读到 bao:// 资源：${JSON.stringify(result)}`)
  } finally {
    await close()
    await server.close()
  }
})

test('设置页：Flash 插件状态可读（版本号来自 PE 资源）', { timeout: 120_000 }, async () => {
  const { hasFlashPlugin } = require('./helpers.cjs')
  if (!hasFlashPlugin()) {
    // BYOP：没有插件时这条没有意义（导入入口靠 UI 手工验证）。
    return
  }
  const { app, shell, close } = await launchApp()
  try {
    await shell.evaluate(() => window.baoBrowser.run({ type: 'open-settings' }))
    const id = await waitFor(async () => {
      const value = await app.evaluate(({ webContents }) =>
        webContents.getAllWebContents().find((contents) => (contents.getURL() ?? '').startsWith('bao://settings'))?.id ?? null)
      return value
    }, { message: '设置页没有打开' })
    const status = await app.evaluate(({ webContents }, target) =>
      webContents.fromId(target).executeJavaScript('window.baoSettings.flashStatus()'), id)
    assert.equal(status.ready, true, '运行中的内核应已注册插件')
    assert.equal(status.version, '29.0.0.171', `PE 版本解析结果不对：${status.version}`)
    assert.ok(String(status.path).toLowerCase().includes('pepflashplayer64.dll'), `插件路径不对：${status.path}`)
    assert.equal(status.restartRequired, false, '已注册的插件不应该要求重启')
  } finally {
    await close()
  }
})

test('设置页：焦点环只在键盘操作时出现（鼠标点击不出环）', { timeout: 120_000 }, async () => {
  const { app, shell, close } = await launchApp()
  try {
    await shell.evaluate(() => window.baoBrowser.run({ type: 'open-settings' }))
    const id = await waitFor(async () => app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().find((contents) => (contents.getURL() ?? '').startsWith('bao://settings'))?.id ?? null))
    const probe = (code) => app.evaluate(({ webContents }, payload) =>
      webContents.fromId(payload.id).executeJavaScript(payload.code), { id, code })
    const readActive = `(() => {
      const el = document.activeElement
      const style = getComputedStyle(el)
      return { cls: String(el.className), focusVisible: el.matches(':focus-visible'),
               outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth }
    })()`

    // ① 键盘：Tab 到引擎选项，应当有 2px 实线环
    const keyboard = await app.evaluate(async ({ webContents }, target) => {
      const page = webContents.fromId(target)
      page.focus()
      for (let step = 0; step < 6; step += 1) {
        page.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
        page.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
        await new Promise((done) => setTimeout(done, 90))
        const cls = await page.executeJavaScript('String(document.activeElement.className)')
        if (cls.includes('choice')) return cls
      }
      return ''
    }, id)
    assert.match(keyboard, /choice/, 'Tab 没有落到引擎选项上')
    const ring = await probe(readActive)
    assert.equal(ring.focusVisible, true)
    assert.equal(ring.outlineStyle, 'solid', `键盘焦点应该有环：${JSON.stringify(ring)}`)
    assert.equal(ring.outlineWidth, '2px')

    // ② 鼠标：点另一个选项（Ruffle），它应获得焦点但不匹配 :focus-visible
    const point = await probe(`(() => {
      const el = document.querySelectorAll('.choice')[1]
      const rect = el.getBoundingClientRect()
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
    })()`)
    await app.evaluate(({ webContents }, payload) => {
      const page = webContents.fromId(payload.id)
      const common = { x: payload.x, y: payload.y, button: 'left', clickCount: 1 }
      page.sendInputEvent({ type: 'mouseMove', ...common })
      page.sendInputEvent({ type: 'mouseDown', ...common })
      page.sendInputEvent({ type: 'mouseUp', ...common })
    }, { id, ...point })
    await new Promise((done) => setTimeout(done, 250))
    const click = await probe(`(() => {
      const el = document.activeElement
      const style = getComputedStyle(el)
      return { text: (el.textContent || '').trim(), focusVisible: el.matches(':focus-visible'),
               outlineStyle: style.outlineStyle }
    })()`)
    assert.match(click.text, /Ruffle/, `鼠标点击没有落到 Ruffle 选项：${JSON.stringify(click)}`)
    assert.equal(click.focusVisible, false, `鼠标点击不该匹配 :focus-visible：${JSON.stringify(click)}`)
    assert.equal(click.outlineStyle, 'none', `鼠标点击不该画环：${JSON.stringify(click)}`)
  } finally {
    await close()
  }
})
