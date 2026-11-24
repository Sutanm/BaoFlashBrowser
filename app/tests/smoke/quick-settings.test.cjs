const assert = require('node:assert/strict')
const { test } = require('node:test')
const { launchApp, page, startFixtureServer, waitFor } = require('./helpers.cjs')

/**
 * 齿轮快捷设置飞窗（共用 `?baoOverlay=overlay` 视图，靠根元素区分）的合同验证。
 *
 * 覆盖：入口与定位（顶边压齿轮下沿、永远在窗口内）、Chromium 样式数值（圆角 12）、
 * 写入设置后外壳/设置页同步、底部「全部设置」入口、Esc 与点外部关闭、
 * 最小窗口下的夹取与内部滚动。
 */

// panel 与 quick 共用同一个叠加层视图，靠根元素区分内容。
const QUICK_URL = 'baoOverlay=overlay'

async function quickContentsId(app) {
  return app.evaluate(({ webContents }, marker) => {
    const target = webContents.getAllWebContents().find((contents) => (contents.getURL() ?? '').includes(marker))
    return target ? target.id : null
  }, QUICK_URL)
}

async function inQuick(app, code) {
  // 视图可能正处在创建/替换之间（预热、回收、内容切换）：重试一次，避免「Script failed」抖动。
  let lastError
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const id = await quickContentsId(app)
    assert.ok(id, '没有找到快捷设置飞窗的 WebContents')
    try {
      return await app.evaluate(async ({ webContents }, payload) => {
        const target = webContents.fromId(payload.id)
        if (!target) throw new Error('飞窗已销毁')
        return target.executeJavaScript(payload.code)
      }, { id, code })
    } catch (error) {
      lastError = error
      await new Promise((done) => setTimeout(done, 250))
    }
  }
  throw lastError
}

async function quickView(app) {
  return app.evaluate(({ webContents, BrowserWindow }, marker) => {
    const target = webContents.getAllWebContents().find((contents) => (contents.getURL() ?? '').includes(marker))
    const win = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().endsWith('index.html'))
    if (!target || !win) return null
    // 边界属于 WebContentsView，不属于 webContents。
    const child = win.contentView.children.find((view) => view.webContents?.id === target.id)
    return {
      id: target.id,
      bounds: child ? child.getBounds() : null,
      attached: Boolean(child),
      contentSize: win.getContentSize()
    }
  }, QUICK_URL)
}

async function shellFacts(app, shell) {
  return {
    theme: await shell.evaluate('document.documentElement.dataset.theme'),
    dark: await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors),
    source: await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)
  }
}

const snapshot = (shell) => shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' }).then((result) => result.state))

test('齿轮飞窗：贴合齿轮、写入同步、入口行与关闭路径', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({ '/game': page('游戏页面') })
  const { app, shell, close } = await launchApp()
  try {
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${server.baseUrl}/game`)
    await address.press('Enter')
    await shell.getByRole('button', { name: '游戏页面', exact: true }).waitFor({ timeout: 30_000 })

    // ① 齿轮打开飞窗；顶边压齿轮下沿（0 缝）、右边缘对齐按钮。
    const gear = shell.getByRole('button', { name: '快捷设置', exact: true })
    await gear.click()
    const opened = await waitFor(async () => {
      const view = await quickView(app)
      return view?.attached ? view : null
    }, { message: '齿轮没有打开快捷设置飞窗' })

    const geometry = await shell.evaluate(() => {
      const button = document.querySelector('.gear-button').getBoundingClientRect()
      return { right: Math.round(button.right), bottom: Math.round(button.bottom) }
    })
    // 紧贴按钮：顶边就是按钮下缘、右边缘与按钮右缘对齐；视图不额外留白。
    assert.equal(opened.bounds.y, geometry.bottom, '飞窗顶边应贴着按钮下沿')
    assert.equal(opened.bounds.x + opened.bounds.width, geometry.right, '飞窗右边缘应与齿轮按钮对齐')
    assert.equal(opened.bounds.width, 320, '视图宽度就是面板宽度（没有投影留白）')
    assert.ok(opened.bounds.x >= 0 && opened.bounds.y >= 0, '飞窗不能越出窗口左侧/顶部')
    assert.ok(opened.bounds.x + opened.bounds.width <= opened.contentSize[0], '飞窗不能越出窗口右侧')
    assert.ok(opened.bounds.y + opened.bounds.height <= opened.contentSize[1], '飞窗不能越出窗口底部')

    // Chromium 数值：四角圆角 12（kMenuRadius → kMediumSmall），且不要投影。
    const look = await inQuick(app, `(() => {
      const style = getComputedStyle(document.querySelector('.quick'))
      return { top: style.borderTopLeftRadius, bottom: style.borderBottomLeftRadius, shadow: style.boxShadow,
               border: style.borderTopWidth }
    })()`)
    assert.equal(look.top, '12px', '上侧也应是 12px 圆角')
    assert.equal(look.bottom, '12px', '下侧应是 12px 圆角')
    assert.match(look.shadow, /inset/, '分层靠 inset 描边，不用外投影（架构铁律：首帧表面用 stroke）')
    assert.equal(look.border, '0px', '不画外边框（Chromium 菜单 use_outer_border = false）')

    // 打开时不该有焦点：否则面板会被画上默认焦点环（实测出现过一圈黄边）。
    assert.equal(await inQuick(app, `document.activeElement?.tagName`), 'BODY', '打开飞窗后不应程序化聚焦任何元素')
    const afterTab = await app.evaluate(async ({ webContents }, marker) => {
      const quick = webContents.getAllWebContents().find((contents) => (contents.getURL() ?? '').includes(marker))
      quick.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
      quick.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
      await new Promise((done) => setTimeout(done, 150))
      return quick.executeJavaScript(`document.activeElement?.className ?? ''`)
    }, QUICK_URL)
    assert.match(afterTab, /theme-option/, '按 Tab 应落到简约主题选择的第一档')

    // 菜单式键盘焦点：行用整行高亮，不画环（与 Chrome 菜单一致）。
    const rowFocus = await app.evaluate(async ({ webContents }, marker) => {
      const quick = webContents.getAllWebContents().find((contents) => (contents.getURL() ?? '').includes(marker))
      quick.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
      quick.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
      await new Promise((done) => setTimeout(done, 150))
      return quick.executeJavaScript(`(() => {
        const el = document.activeElement
        const style = getComputedStyle(el)
        return { cls: String(el.className), outline: style.outlineStyle, background: style.backgroundColor }
      })()`)
    }, QUICK_URL)
    assert.match(rowFocus.cls, /\brow\b/, `第二次 Tab 应落到引擎行：${JSON.stringify(rowFocus)}`)
    assert.equal(rowFocus.outline, 'none', `行不该画焦点环：${JSON.stringify(rowFocus)}`)
    assert.notEqual(rowFocus.background, 'rgba(0, 0, 0, 0)', `行应该整行高亮：${JSON.stringify(rowFocus)}`)

    // ② 面板里改主题：外壳与系统按钮一起变。
    const stops = await inQuick(app, `Array.from(document.querySelectorAll('.theme-option'), (stop) => [
      stop.getAttribute('aria-label'), stop.getAttribute('aria-checked')
    ])`)
    assert.deepEqual(stops, [['跟随系统', 'true'], ['浅色', 'false'], ['深色', 'false']])
    assert.equal(await inQuick(app, `document.querySelector('.theme-rotor')`), null,
      '快捷面板不再加载动态主题表盘（动画只留在新标签页）')
    await inQuick(app, `document.querySelector('.theme-option[aria-label="深色"]').click()`)
    await waitFor(async () => (await shellFacts(app, shell)).theme === 'dark' ? true : null,
      { message: '飞窗改主题后外壳没有变暗' })
    const facts = await shellFacts(app, shell)
    assert.equal(facts.source, 'dark')
    assert.equal(facts.dark, true)

    // ③ 与设置页双向同步：设置页读到的也是深色；页面再次改写后飞窗跟着变。
    await shell.evaluate(() => window.baoBrowser.run({ type: 'open-settings' }))
    const settingsId = await waitFor(async () => {
      const id = await app.evaluate(({ webContents }) =>
        webContents.getAllWebContents().find((contents) => (contents.getURL() ?? '').startsWith('bao://settings'))?.id ?? null)
      return id
    }, { message: '设置页没有打开' })
    const settingsEval = (code) => app.evaluate(async ({ webContents }, payload) => {
      const target = webContents.fromId(payload.id)
      if (!target) throw new Error('设置页已销毁')
      return target.executeJavaScript(payload.code)
    }, { id: settingsId, code })
    const pageChecked = await waitFor(async () => {
      const value = await settingsEval(`document.querySelector('.theme-stop[aria-checked="true"]')?.getAttribute('aria-label')`)
      return value === '深色' ? value : null
    }, { message: '设置页没有同步到飞窗写入的主题' })
    assert.equal(pageChecked, '深色')

    await settingsEval(`window.baoSettings.write('theme.mode', 'light')`)
    const quickChecked = await waitFor(async () => {
      const value = await inQuick(app, `document.querySelector('.theme-option[aria-checked="true"]')?.getAttribute('aria-label')`)
      return value?.includes('浅色') ? value : null
    }, { message: '设置页改主题后飞窗没有同步' })
    assert.match(quickChecked, /浅色/)
    assert.equal((await shellFacts(app, shell)).theme, 'light')

    // ④ 底部「全部设置」：关飞窗、切到设置标签页。
    await inQuick(app, `document.querySelector('.row.footer').click()`)
    await waitFor(async () => (await quickView(app))?.attached !== true ? true : null,
      { message: '点「全部设置」后飞窗没有关闭' })
    const afterFooter = await snapshot(shell)
    assert.equal(afterFooter.tabs.find((tab) => tab.id === afterFooter.activeId)?.internal, 'settings',
      '「全部设置」应切到设置标签页')

    // ⑤ Esc 关闭：飞窗自己处理键盘，把焦点还给齿轮。
    await gear.click()
    await waitFor(async () => (await quickView(app))?.attached ? true : null, { message: '飞窗没有再次打开' })
    const quickId = await quickContentsId(app)
    // 重试：整套用例连续跑时机器忙，按键偶发落在视图完成布局之前。
    let escaped = false
    for (let attempt = 0; attempt < 3 && !escaped; attempt += 1) {
      await app.evaluate(({ webContents }, id) => {
        const target = webContents.fromId(id)
        target.focus()
        target.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
        target.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
      }, quickId)
      await new Promise((done) => setTimeout(done, 250))
      escaped = (await quickView(app))?.attached !== true
    }
    assert.equal(escaped, true, 'Esc 没有关闭飞窗')

    // ⑥ 点外壳其它地方关闭。
    await gear.click()
    await waitFor(async () => (await quickView(app))?.attached ? true : null, { message: '飞窗没有再次打开' })
    await shell.evaluate(() => {
      document.querySelector('.address-bar input')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    await waitFor(async () => (await quickView(app))?.attached !== true ? true : null,
      { message: '点外壳其它位置没有关闭飞窗' })
  } finally {
    await close()
    await server.close()
  }
})

test('齿轮飞窗：最小窗口下按内容区夹取，内容需要时可内部滚动', { timeout: 120_000 }, async () => {
  const { app, shell, close } = await launchApp()
  try {
    const windowHandle = await app.browserWindow(shell)
    await windowHandle.evaluate((window) => window.setSize(520, 360))
    await new Promise((done) => setTimeout(done, 400))

    await shell.getByRole('button', { name: '快捷设置', exact: true }).click()
    const view = await waitFor(async () => {
      const value = await quickView(app)
      return value?.attached ? value : null
    }, { message: '最小窗口下飞窗没有打开' })

    const [width, height] = view.contentSize
    assert.ok(view.bounds.y + view.bounds.height <= height, `飞窗越出内容区底部：${JSON.stringify(view.bounds)} vs ${height}`)
    assert.ok(view.bounds.x + view.bounds.width <= width, '飞窗越出内容区右侧')

    // 面板始终保留滚动能力；简约主题控件让当前内容可以直接装进最小窗口，不应强造滚动条。
    const overflow = await inQuick(app, `(() => {
      const panel = document.querySelector('.quick')
      return { scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight, overflowY: getComputedStyle(panel).overflowY }
    })()`)
    assert.equal(overflow.overflowY, 'auto', '夹取后面板必须可滚动')
    assert.ok(overflow.scrollHeight >= overflow.clientHeight,
      `最小窗口下面板内容尺寸异常：${JSON.stringify(overflow)}`)
  } finally {
    await close()
  }
})
