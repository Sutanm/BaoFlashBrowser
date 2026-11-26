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
  // 事件驱动：等设置页的 WebContents 出现（并行跑用例时它可能比快捷键晚几十毫秒才建好），
  // 而不是查一次就断言——「这一刻还没有」不等于「打不开」（2026-11-24 抖动来源）。
  const id = await waitFor(() => settingsViewId(app), { timeout: 10_000, interval: 30, message: '没有找到设置页的 WebContents' })
  return app.evaluate(async ({ webContents }, payload) => {
    const target = webContents.fromId(payload.id)
    if (!target) throw new Error('设置页已销毁')
    return target.executeJavaScript(payload.code)
  }, { id, code })
}

const snapshot = (shell) => shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' }).then((result) => result.state))

test('设置页：Ctrl+, 就地覆盖新标签页，只有设置桥，写入后外壳同步', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({ '/': page('设置测试页') })
  const { app, shell, close } = await launchApp()
  try {
    const initial = await snapshot(shell)
    assert.equal(initial.tabs.length, 1)
    assert.equal(initial.tabs[0].internal, 'newtab', '启动首个标签应是新标签页')
    const tabId = initial.tabs[0].id

    // ① 入口：在新标签页上按 Ctrl+, → 就地覆盖（Chrome 的 ShowSingletonTabOverwritingNTP）。
    await pressShortcut(app, ',', ['control'])
    const state = await waitFor(async () => {
      const value = await snapshot(shell)
      const tab = value.tabs[0]
      return value.tabs.length === 1 && tab?.internal === 'settings' &&
        tab.address === 'bao://settings/' && tab.title === '设置' ? value : null
    }, { message: 'Ctrl+, 没有把新标签页就地切换到设置页' })

    const internal = state.tabs[0]
    assert.equal(internal.id, tabId, '就地覆盖必须保留同一个标签（id/位置不变）')
    assert.equal(internal.address, 'bao://settings/')
    assert.equal(internal.title, '设置')
    assert.equal(state.activeId, internal.id, '设置页应当是选中态')
    assert.equal(internal.canGoBack, true, '新标签页应当留在历史里（可后退）')

    // 后退：同一个标签回到新标签页（Chrome 的 NTP 是历史第 0 项）。
    const back = await shell.evaluate(() => window.baoBrowser.run({ type: 'back' }))
    assert.equal(back.ok, true, `后退失败：${back.code}`)
    const backState = await waitFor(async () => {
      const value = await snapshot(shell)
      return value.tabs[0]?.internal === 'newtab' ? value : null
    }, { message: '后退没有回到新标签页' })
    assert.equal(backState.tabs[0].id, tabId)

    // 再按一次：仍然就地覆盖，不会多出第二个设置标签。
    await pressShortcut(app, ',', ['control'])
    const again = await waitFor(async () => {
      const value = await snapshot(shell)
      return value.tabs[0]?.internal === 'settings' ? value : null
    }, { message: '再次 Ctrl+, 没有回到设置页' })
    assert.equal(again.tabs.length, 1, '设置页应覆盖新标签页，而不是新建')

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

    // ⑦ 飞窗预热在「性能」分区（2026-11-26 按 Edge 重新分类）：先切过去再断言。
    await inSettings(app, `[...document.querySelectorAll('.settings-nav button')].find((el) => el.textContent.trim() === '性能')?.click()`)
    await waitFor(async () => (await inSettings(app, `document.querySelector('.settings-nav button[aria-current="page"]')?.textContent?.trim()`)) === '性能'
      ? true : null, { message: '没有切到「性能」分区' })

    // 「飞窗预热」是开/关开关（不是三选一），说明行要跟着开关走、悬浮说明不能为空。
    //    2026-11-26 收敛：删掉中间档 `auto`，并顺手钉住"默认在描述里"这条（不在档位名上加徽标）。
    const prewarm = await inSettings(app, `(() => {
      const toggle = document.querySelector('[role="switch"][aria-label="飞窗预热"]')
      if (!toggle) return null
      const row = toggle.closest('.toggle-row')
      const read = () => ({
        checked: toggle.getAttribute('aria-checked'),
        summary: row?.querySelector('.preference-copy p')?.textContent?.trim() ?? '',
        hint: (toggle.getAttribute('title') ?? '').length,
        width: toggle.getBoundingClientRect().width
      })
      return { initial: read(), segmented: document.querySelectorAll('#perf-title ~ * .segmented-control').length }
    })()`)
    assert.ok(prewarm, '没有找到「飞窗预热」开关')
    assert.equal(prewarm.initial.checked, 'true', '飞窗预热默认应当打开（常驻）')
    assert.ok(prewarm.initial.summary.startsWith('默认'),
      `默认档的说明行必须以「默认」开头（不在档位名上加徽标）：${prewarm.initial.summary}`)
    assert.ok(prewarm.initial.hint > 20, `开关必须有悬浮说明：${prewarm.initial.hint}`)
    assert.ok(prewarm.initial.width > 20, `开关没有实际布局宽度（隐藏窗口），几何断言会变成空断言：${prewarm.initial.width}`)
    assert.equal(prewarm.segmented, 0, '性能分区不该再有分段控件（预热已退化为开关）')

    // 点一下关掉：写入 never → 外壳与页面同时重绘，说明行换成"不提前创建"。
    await inSettings(app, `document.querySelector('[role="switch"][aria-label="飞窗预热"]').click()`)
    const off = await waitFor(async () => {
      const value = await inSettings(app, `(() => {
        const toggle = document.querySelector('[role="switch"][aria-label="飞窗预热"]')
        return {
          checked: toggle?.getAttribute('aria-checked'),
          summary: toggle?.closest('.toggle-row')?.querySelector('.preference-copy p')?.textContent?.trim() ?? ''
        }
      })()`)
      return value.checked === 'false' && !value.summary.startsWith('默认') ? value : null
    }, { message: '关掉飞窗预热后开关/说明没有跟着变' })
    assert.ok(off.summary.length > 0, '关掉后说明行不能为空')
    assert.equal((await snapshot(shell)).settings.overlayPrewarm, 'never', '开关没有写进设置')
    // 复原：后面的用例（以及重启恢复类断言）都假设默认档。
    await inSettings(app, `document.querySelector('[role="switch"][aria-label="飞窗预热"]').click()`)
    await waitFor(async () => (await snapshot(shell)).settings.overlayPrewarm === 'always' ? true : null,
      { message: '再次打开飞窗预热没有恢复 always' })

    // ⑧ 左侧导航是真分区（不是摆设）：每一项切过去都有真实内容，且切换不重载文档。
    //    2026-11-26 反馈：导航四项里三项是置灰假条目。现在「下载」不再列（本版本按安全策略
    //    拒绝所有下载，见 sessions.ts），另外三项各有内容。
    const nav = await inSettings(app, `(() => {
      globalThis.__navMarker = 'still-here'
      return [...document.querySelectorAll('.settings-nav button')].map((el) => el.textContent.trim())
    })()`)
    // 2026-11-26 按 Edge 的切法重排：只列我们真有内容的项（Edge 的个人资料/密码/默认浏览器/
    // 下载/辅助功能/重置设置/扩展都没有数据源，不列）。
    assert.deepEqual(nav, ['外观', '引擎', '隐私、搜索和服务', '启动', '性能', '语言', '关于'],
      '导航项必须逐项有真实内容（不列空分区）')

    await inSettings(app, `[...document.querySelectorAll('.settings-nav button')].find((el) => el.textContent.trim() === '关于')?.click()`)
    const about = await waitFor(async () => {
      const value = await inSettings(app, `(() => {
        const section = document.getElementById('about-title')?.closest('.setting-section')
        const current = document.querySelector('.settings-nav button[aria-current="page"]')?.textContent?.trim() ?? ''
        if (!section || section.hidden) return null
        return { text: section.innerText.replace(/\\s+/g, ' ').trim(), current }
      })()`)
      return value && value.text.includes('Electron') ? value : null
    }, { message: '「关于」分区没有显示版本信息' })
    assert.ok(/Chromium \d/.test(about.text), `关于里应有 Chromium 版本：${about.text}`)
    assert.equal(about.current, '关于', '切换后导航的 aria-current 要跟着走')

    // 「关于」里的 Flash 只是摘要：点了要能回到真正那张卡（2026-11-26 反馈：
    // 关于里只放「打开所在文件夹」，看起来像导入/自动发现被砍掉了）。
    await inSettings(app, `[...document.querySelectorAll('#about-title')]
      .map((title) => title.closest('.setting-section'))
      .flatMap((section) => [...section.querySelectorAll('button.action')])
      .find((el) => el.textContent.trim() === 'Flash 插件设置')?.click()`)
    const backToFlash = await waitFor(async () => {
      const value = await inSettings(app, `(() => {
        const section = document.getElementById('flash-section')
        if (!section || section.hidden) return null
        return {
          current: document.querySelector('.settings-nav button[aria-current="page"]')?.textContent?.trim() ?? '',
          actions: [...section.querySelectorAll('button.action')].map((el) => el.textContent.trim())
        }
      })()`)
      return value && value.actions.length ? value : null
    }, { message: '「关于」里的 Flash 设置入口没有把用户送回 Flash 卡片' })
    assert.equal(backToFlash.current, '引擎', '跳转后导航应切到「引擎」（Flash 卡片所在分区）')
    assert.deepEqual(backToFlash.actions, ['打开所在文件夹', '导入'],
      'Flash 卡片必须同时有「打开所在文件夹」和「导入」（导入是 BYOP 的主路径）')

    await inSettings(app, `[...document.querySelectorAll('.settings-nav button')].find((el) => el.textContent.trim() === '隐私、搜索和服务')?.click()`)
    const privacy = await waitFor(async () => {
      const value = await inSettings(app, `(() => {
        const section = document.getElementById('privacy-title')?.closest('.setting-section')
        if (!section || section.hidden) return null
        return [...section.querySelectorAll('button.action')].map((el) => el.getAttribute('aria-label'))
      })()`)
      return value && value.length ? value : null
    }, { message: '「隐私、搜索和服务」分区没有清除入口' })
    // 站点引擎规则搬到「引擎」分区（它清的是引擎记忆，不是隐私），隐私页只剩浏览数据。
    assert.deepEqual(privacy, ['清除已保存的会话'])

    // 「引擎」分区必须把三件事收在一起：默认引擎、Flash 插件、站点引擎规则。
    await inSettings(app, `[...document.querySelectorAll('.settings-nav button')].find((el) => el.textContent.trim() === '引擎')?.click()`)
    const enginePage = await waitFor(async () => {
      const value = await inSettings(app, `(() => {
        const section = document.getElementById('rules-title')?.closest('.setting-section')
        const flash = document.getElementById('flash-section')
        if (!section || section.hidden || !flash || flash.hidden) return null
        return {
          rules: section.querySelector('button.action')?.getAttribute('aria-label') ?? '',
          flashButtons: [...flash.querySelectorAll('button.action')].map((el) => el.textContent.trim())
        }
      })()`)
      return value && value.rules ? value : null
    }, { message: '「引擎」分区没有把 Flash 与站点规则收在一起' })
    assert.equal(enginePage.rules, '清除站点引擎规则')
    assert.deepEqual(enginePage.flashButtons, ['打开所在文件夹', '导入'])

    assert.equal(await inSettings(app, 'globalThis.__navMarker'), 'still-here', '分区切换不该重载文档（那是"刷新感"的来源）')
    // 回到默认分区，后面的断言/用例都按「外观与偏好」看。
    await inSettings(app, `[...document.querySelectorAll('.settings-nav button')].find((el) => el.textContent.trim() === '外观')?.click()`)
    await waitFor(async () => (await inSettings(app, `document.querySelector('.settings-nav button[aria-current="page"]')?.textContent?.trim()`)) === '外观'
      ? true : null, { message: '没能切回「外观」' })
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

    // 引擎选项在「引擎」分区（默认展示的是「外观」）：先切过去，隐藏分区里的控件不可聚焦。
    await probe(`[...document.querySelectorAll('.settings-nav button')].find((el) => el.textContent.trim() === '引擎')?.click()`)
    await new Promise((done) => setTimeout(done, 200))

    // ① 键盘：Tab 到引擎选项，应当有 2px 实线环
    const keyboard = await app.evaluate(async ({ webContents }, target) => {
      const page = webContents.fromId(target)
      page.focus()
      // 左侧导航现在是**可聚焦的真按钮**（3 个），Tab 顺序里排在内容之前，所以要给够步数：
      // 导航 3 → 主题 3 → 引擎选项。
      for (let step = 0; step < 14; step += 1) {
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
test('设置页：启动行为是单选项且不带括号说明，点击即写入', { timeout: 120_000 }, async () => {
  const { app, shell, close } = await launchApp()
  try {
    await shell.evaluate(() => window.baoBrowser.run({ type: 'open-settings' }))
    const id = await waitFor(async () => app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().find((contents) => (contents.getURL() ?? '').startsWith('bao://settings'))?.id ?? null))
    const inPage = (code) => app.evaluate(({ webContents }, payload) =>
      webContents.fromId(payload.id).executeJavaScript(payload.code), { id, code })
    const radios = `[...document.querySelectorAll('[role="radiogroup"][aria-label="启动时"] [role="radio"]')]`

    // 控件形态：单选组、两个选项、文案不带括号（对齐 Chrome/Edge 的 On startup）。
    const shape = await inPage(`(() => {
      const options = ${radios}.map((node) => ({
        text: node.textContent.trim(),
        checked: node.getAttribute('aria-checked') === 'true'
      }))
      return { options }
    })()`)
    assert.deepEqual(shape.options.map((option) => option.text),
      ['打开新标签页', '打开上一个会话中的标签页'], '启动选项的文案不应带括号说明')
    assert.equal(shape.options[0].checked, true, '默认应选中「打开新标签页」')

    // 点击第二个选项：写入 session.startup，单选状态跟着更新。
    await inPage(`(() => { ${radios}[1].click(); return true })()`)
    const written = await waitFor(async () => {
      const result = await shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' }))
      return result.state.settings.sessionStartup === 'continue' ? result.state : null
    }, { message: '点击「打开上一个会话中的标签页」没有写入设置' })
    assert.equal(written.settings.sessionStartup, 'continue')

    const after = await waitFor(async () => {
      const checked = await inPage(`${radios}.map((node) => node.getAttribute('aria-checked') === 'true')`)
      return Array.isArray(checked) && checked[1] === true ? checked : null
    }, { message: '单选状态没有跟着写入结果更新' })
    assert.deepEqual(after, [false, true])
  } finally {
    await close()
  }
})
