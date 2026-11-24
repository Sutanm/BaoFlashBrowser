const assert = require('node:assert/strict')
const { test } = require('node:test')
const { launchApp, page, startFixtureServer, waitFor } = require('./helpers.cjs')

/**
 * 主窗口 chrome（架构 A5）：无原生标题栏，系统只画窗口按钮，其余由我们控制。
 *
 * 实测要点（2026-11-23）：
 * - `navigator.windowControlsOverlay` 可用，`.titlebar` 的右内边距 = 窗口按钮宽度 + 间隙，
 *   因此标签不会压到系统按钮下面；
 * - 双击标题栏最大化是**我们自己转发**的（`bao:window-control`），不依赖系统拖拽区的双击识别。
 */
async function mainWindow(app, shell) {
  const handle = await app.browserWindow(shell)
  return handle.evaluate((window) => window)
}

async function isMaximized(app) {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().endsWith('index.html'))
    return window ? window.isMaximized() : null
  })
}

test('主窗口 chrome：窗口按钮不压标签、双击标题栏最大化、双击标签不影响', { timeout: 120_000 }, async (context) => {
  const automated = process.env.BAO_SMOKE_HIDDEN === '1' || process.env.BAO_SMOKE_BACKGROUND === '1'
  const server = await startFixtureServer({ '/': page('标题栏测试页') })
  const { app, shell, close } = await launchApp()
  try {
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(server.baseUrl)
    await address.press('Enter')
    await shell.getByRole('button', { name: '标题栏测试页', exact: true }).waitFor({ timeout: 30_000 })

    // 1) 窗口按钮区与拖动区的布局契约。
    const layout = await shell.evaluate(() => {
      const titlebar = document.querySelector('.titlebar')
      const tabs = document.querySelector('.tabs')
      const addTab = document.querySelector('.add-tab-slot')
      const overlay = navigator.windowControlsOverlay
      const rect = overlay?.getTitlebarAreaRect?.()
      const titlebarRect = titlebar.getBoundingClientRect()
      const tabsRect = tabs.getBoundingClientRect()
      const addTabRect = addTab.getBoundingClientRect()
      return {
        wcoVisible: overlay?.visible ?? null,
        titlebarAreaWidth: rect ? rect.width : null,
        innerWidth: window.innerWidth,
        firstTabOffset: tabsRect.left - titlebarRect.left,
        addTabOffset: addTabRect.left - tabsRect.right,
        paddingRight: parseFloat(getComputedStyle(titlebar).paddingRight),
        titlebarRegion: getComputedStyle(titlebar).getPropertyValue('-webkit-app-region'),
        tabsRegion: getComputedStyle(tabs).getPropertyValue('-webkit-app-region')
      }
    })
    assert.equal(layout.titlebarRegion, 'drag', '标题栏必须是拖动区')
    assert.equal(layout.tabsRegion, 'no-drag', '标签必须不是拖动区')
    assert.ok(Math.abs(layout.firstTabOffset) < 0.5, `标签栏左侧没有贴边：偏移 ${layout.firstTabOffset}px`)
    assert.ok(Math.abs(layout.addTabOffset + 2) < 0.5,
      `新建按钮没有保留预期的细缝：偏移 ${layout.addTabOffset}px`)
    if (layout.wcoVisible) {
      const controlsWidth = layout.innerWidth - layout.titlebarAreaWidth
      assert.ok(
        layout.paddingRight >= controlsWidth,
        `标题栏右侧留白不足：${layout.paddingRight} < 按钮区 ${controlsWidth}`
      )
    }

    // 2) 双击标题栏空白：最大化；再双击：还原。
    await context.test('双击标题栏最大化和还原', { skip: automated && '原生最大化留给前台测试' }, async () => {
      const dblclickTitlebar = () => shell.evaluate(() => {
        document.querySelector('.titlebar').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      })
      await dblclickTitlebar()
      await waitFor(async () => (await isMaximized(app)) ? true : null, { message: '双击标题栏没有最大化' })
      await dblclickTitlebar()
      await waitFor(async () => (await isMaximized(app)) ? null : true, { message: '再次双击标题栏没有还原' })
    })

    // 3) 双击标签不触发最大化。
    await shell.evaluate(() => {
      const tab = document.querySelector('.tab')
      tab.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    await new Promise((done) => setTimeout(done, 600))
    assert.equal(await isMaximized(app), false, '双击标签误触发了最大化')

    // 4) 双击标签栏空白 = 新建标签页（Chrome 语义），且不触发最大化。
    const before = (await shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' }))).state.tabs.length
    await shell.evaluate(() => {
      document.querySelector('.tabs').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    await waitFor(async () => {
      const state = (await shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' }))).state
      return state.tabs.length === before + 1 ? state : null
    }, { message: '双击标签栏空白没有新建标签页' })
    assert.equal(await isMaximized(app), false, '双击标签栏空白误触发了最大化')
  } finally {
    await close()
    await server.close()
  }
})
