const assert = require('node:assert/strict')
const { test } = require('node:test')
const { launchApp, page, startFixtureServer, waitFor, waitForTabLabel } = require('./helpers.cjs')

/**
 * 自动化模式：`npm run smoke` 默认隐藏窗口。直接运行此文件仍支持两种模式：
 * - `BAO_SMOKE_HIDDEN=1`：窗口完全不 show（屏幕上什么都没有）；
 * - `BAO_SMOKE_BACKGROUND=1`：窗口在屏幕外、完全透明、跳过任务栏。
 * 前台验收用 `npm run smoke:foreground`。
 */
const HIDDEN = process.env.BAO_SMOKE_HIDDEN === '1'
const BACKGROUND = process.env.BAO_SMOKE_BACKGROUND === '1'
const AUTOMATED = HIDDEN || BACKGROUND

test('自编译运行时启动无边框外壳并保持单标签、导航与焦点', { timeout: 60_000 }, async (context) => {
  const server = await startFixtureServer({ '/one': page('第一个页面'), '/two': page('第二个页面') })
  const { app, shell, close } = await launchApp()
  try {
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.waitFor()
    const runtime = await shell.evaluate(() => ({
      versions: window.baoRuntime,
      nodeType: typeof window.require,
      overlay: navigator.windowControlsOverlay.visible,
      chromeHeight: document.querySelector('header').getBoundingClientRect().height,
      dragRegion: getComputedStyle(document.querySelector('.titlebar')).getPropertyValue('app-region'),
      buttonRegion: getComputedStyle(document.querySelector('.add-tab')).getPropertyValue('app-region')
    }))
    assert.deepEqual(runtime.versions, { electron: '39.8.10', chromium: '142.0.7444.265' })
    assert.equal(runtime.nodeType, 'undefined')
    assert.equal(runtime.overlay, true)
    assert.equal(runtime.dragRegion, 'drag')
    assert.equal(runtime.buttonRegion, 'no-drag')

    // 启动只开一个标签页。
    await waitForTabLabel(shell, '新标签页')
    assert.equal(await shell.locator('.tab').count(), 1)

    await address.fill(`${server.baseUrl}/one`)
    await address.press('Enter')
    await waitForTabLabel(shell, '第一个页面')
    await address.fill(`${server.baseUrl}/two`)
    await address.press('Enter')
    await waitForTabLabel(shell, '第二个页面')
    await shell.getByRole('button', { name: '后退', exact: true }).click()
    await waitForTabLabel(shell, '第一个页面')
    await shell.getByRole('button', { name: '前进', exact: true }).click()
    await waitForTabLabel(shell, '第二个页面')
    await shell.getByRole('button', { name: '后退', exact: true }).click()
    const firstTab = shell.getByRole('button', { name: '第一个页面', exact: true })
    await firstTab.waitFor()

    // 「新建标签页」按钮与同名标签按钮是不同控件：前者必须真的新增标签。
    await shell.getByRole('button', { name: '新建标签页', exact: true }).click()
    await waitFor(async () => (await shell.locator('.tab').count()) === 2, { message: '「新建标签页」未新增标签。' })
    await address.fill(`${server.baseUrl}/two`)
    await address.press('Enter')
    const secondTab = shell.getByRole('button', { name: '第二个页面', exact: true })
    await secondTab.waitFor()
    await firstTab.click()

    const windowHandle = await app.browserWindow(shell)
    const geometry = () => windowHandle.evaluate((window) => {
      const view = window.contentView.children.find((child) => child.webContents && child.webContents !== window.webContents)
      return { size: window.getContentSize(), bounds: view.getBounds() }
    })
    /**
     * 外壳高度**按当前标签**算，不能只量一次。
     *
     * 收藏夹横条（2026-11-26）在默认档下只在新标签页上占 32px：启动时量到的 116 是 NTP 的，
     * 导航到网页之后变成 84。拿启动时那个常量去比网页上的视图 y，就是在比较两个不同的页面。
     */
    const chromeHeight = () => shell.evaluate(() => document.querySelector('header').getBoundingClientRect().height)

    // 前台跑法下窗口是 `show: false` 创建、`loadURL` 完成后再 `show()`；页面在 `show()`
    // 之前就已经可交互，所以这里等一次可见性，避免把「还没 show」误判成回归。
    if (!AUTOMATED) {
      await waitFor(() => windowHandle.evaluate((window) => window.isVisible()), {
        message: '窗口没有变为可见。'
      })
    }

    const details = await windowHandle.evaluate(async (window) => {
      const { webContents } = window.contentView.children.find((child) => child.webContents && child.webContents !== window.webContents)
      return {
        id: webContents.id,
        url: webContents.getURL(),
        focused: webContents.isFocused(),
        isolated: await webContents.executeJavaScript('typeof window.baoBrowser === "undefined" && typeof window.require === "undefined"'),
        // 自动化模式下窗口必须完全透明（否则它会出现在屏幕上）。
        opacity: window.getOpacity(),
        visible: window.isVisible(),
        focusable: window.isFocusable()
      }
    })
    assert.deepEqual(details, {
      id: details.id,
      url: `${server.baseUrl}/one`,
      focused: !AUTOMATED,
      isolated: true,
      opacity: BACKGROUND ? 0 : 1,
      visible: !HIDDEN,
      focusable: !AUTOMATED
    })

    await windowHandle.evaluate(async (window) => {
      const resized = new Promise((resolve) => window.once('resize', resolve))
      window.setSize(940, 620)
      await resized
    })
    const resized = await geometry()
    const resizedChrome = await chromeHeight()
    assert.deepEqual(resized.bounds, {
      x: 0, y: resizedChrome, width: resized.size[0], height: resized.size[1] - resizedChrome
    })

    await context.test('最大化后视图随内容区调整', { skip: AUTOMATED && '原生最大化留给前台测试' }, async () => {
      await windowHandle.evaluate(async (window) => {
        const maximized = new Promise((resolve) => window.once('maximize', resolve))
        window.maximize()
        await maximized
      })
      const maximized = await geometry()
      const maximizedChrome = await chromeHeight()
      assert.deepEqual(maximized.bounds, {
        x: 0, y: maximizedChrome, width: maximized.size[0], height: maximized.size[1] - maximizedChrome
      })
    })

    await address.fill('file:///C:/Windows')
    await address.press('Enter')
    await shell.getByRole('status').filter({ hasText: '请输入有效的 HTTP 或 HTTPS 网址' }).waitFor()
    await shell.getByRole('button', { name: '关闭标签页：第一个页面' }).click()
    await firstTab.waitFor({ state: 'detached' })
    assert.equal(await secondTab.getAttribute('aria-pressed'), 'true')
    assert.equal(await app.evaluate(({ webContents }, id) => webContents.fromId(id)?.isDestroyed() ?? true, details.id), true)
    assert.equal(await address.inputValue(), `${server.baseUrl}/two`)
    if (HIDDEN) {
      assert.deepEqual(await windowHandle.evaluate((window) => [window.isVisible(), window.isFocused()]), [false, false])
    }
  } finally {
    await close()
    await server.close()
  }
})
