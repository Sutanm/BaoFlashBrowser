const assert = require('node:assert/strict')
const { test } = require('node:test')
const { launchApp, page, startFixtureServer, waitFor } = require('./helpers.cjs')

/**
 * 自动化模式（见 `scripts/smoke-background.cjs`）：
 * - `BAO_SMOKE_BACKGROUND=1`：窗口 `showInactive()` + `focusable: false`（可见但不激活）；
 * - `BAO_SMOKE_HIDDEN=1`：窗口完全不 show。
 * 两种模式都不会让窗口获得焦点，所以焦点断言按模式取值（前台验收仍是 `npm run smoke`）。
 */
const AUTOMATED = process.env.BAO_SMOKE_BACKGROUND === '1' || process.env.BAO_SMOKE_HIDDEN === '1'

test('自编译运行时启动无边框外壳并保持单标签、导航与焦点', { timeout: 60_000 }, async () => {
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
    await shell.getByRole('button', { name: '新标签页', exact: true }).waitFor()
    assert.equal(await shell.locator('.tab').count(), 1)

    await address.fill(`${server.baseUrl}/one`)
    await address.press('Enter')
    await shell.getByRole('button', { name: '第一个页面', exact: true }).waitFor()
    await address.fill(`${server.baseUrl}/two`)
    await address.press('Enter')
    await shell.getByRole('button', { name: '第二个页面', exact: true }).waitFor()
    await shell.getByRole('button', { name: '后退', exact: true }).click()
    await shell.getByRole('button', { name: '第一个页面', exact: true }).waitFor()
    await shell.getByRole('button', { name: '前进', exact: true }).click()
    await shell.getByRole('button', { name: '第二个页面', exact: true }).waitFor()
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

    const details = await windowHandle.evaluate(async (window) => {
      const { webContents } = window.contentView.children.find((child) => child.webContents && child.webContents !== window.webContents)
      return {
        id: webContents.id,
        url: webContents.getURL(),
        focused: webContents.isFocused(),
        isolated: await webContents.executeJavaScript('typeof window.baoBrowser === "undefined" && typeof window.require === "undefined"')
      }
    })
    assert.deepEqual(details, {
      id: details.id,
      url: `${server.baseUrl}/one`,
      focused: !AUTOMATED,
      isolated: true
    })

    await windowHandle.evaluate(async (window) => {
      const resized = new Promise((resolve) => window.once('resize', resolve))
      window.setSize(940, 620)
      await resized
    })
    const resized = await geometry()
    assert.deepEqual(resized.bounds, {
      x: 0, y: runtime.chromeHeight, width: resized.size[0], height: resized.size[1] - runtime.chromeHeight
    })

    await windowHandle.evaluate(async (window) => {
      const maximized = new Promise((resolve) => window.once('maximize', resolve))
      window.maximize()
      await maximized
    })
    const maximized = await geometry()
    assert.deepEqual(maximized.bounds, {
      x: 0, y: runtime.chromeHeight, width: maximized.size[0], height: maximized.size[1] - runtime.chromeHeight
    })

    await address.fill('file:///C:/Windows')
    await address.press('Enter')
    await shell.getByRole('status').filter({ hasText: '请输入有效的 HTTP 或 HTTPS 网址' }).waitFor()
    await shell.getByRole('button', { name: '关闭标签页：第一个页面' }).click()
    await firstTab.waitFor({ state: 'detached' })
    assert.equal(await secondTab.getAttribute('aria-pressed'), 'true')
    assert.equal(await app.evaluate(({ webContents }, id) => webContents.fromId(id)?.isDestroyed() ?? true, details.id), true)
    assert.equal(await address.inputValue(), `${server.baseUrl}/two`)
  } finally {
    await close()
    await server.close()
  }
})
