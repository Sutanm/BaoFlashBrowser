const assert = require('node:assert/strict')
const { test } = require('node:test')
const { launchApp, page, startFixtureServer, waitFor } = require('./helpers.cjs')
const {
  activeTabOf, engineSettings, expectEngine, navigate, overlay, overlayControl, panelNames, snapshot
} = require('./engine-helpers.cjs')

test('引擎面板分别切换引擎与记住站点规则，起始页不可记住', { timeout: 240_000 }, async () => {
  const server = await startFixtureServer({
    '/one': page('规则测试页'),
    '/two': page('同站点新标签'),
    '/three': page('已取消规则的新标签')
  })
  const { app, shell, close } = await launchApp()
  try {
    const windowHandle = await app.browserWindow(shell)
    const settings = engineSettings(shell)
    const control = (name, options) => overlayControl(windowHandle, 'panel', name, options)
    const rememberSwitch = (value, click = false) => control(panelNames.remember, { attribute: 'aria-checked', value, click })
    const selected = (name, value, click = false) => control(name, { attribute: 'aria-pressed', value, click })
    const panelClosed = () => waitFor(async () => !await overlay(windowHandle, 'panel'), {
      message: '切换引擎后原生面板仍挂在窗口上。'
    })
    const newTab = shell.getByRole('button', { name: '新建标签页', exact: true })

    // 起始页现在是内部页（`bao://newtab`）：没有引擎胶囊，也不能写入站点规则。
    assert.equal(await shell.locator('.engine-pill').count(), 0, '起始页不应显示引擎胶囊')
    const noSite = await shell.evaluate(() => window.baoBrowser.run({ type: 'remember-engine' }))
    assert.equal(noSite.ok, false, '起始页不应能写站点规则')
    assert.equal(noSite.code, 'no-site')

    await navigate(shell, `${server.baseUrl}/one`, '规则测试页')
    await settings.click()
    await selected(panelNames.ruffle, 'false', true)
    await panelClosed()
    await expectEngine(shell, 'ruffle', 'manual')
    await shell.getByRole('button', { name: '规则测试页', exact: true }).waitFor({ timeout: 30_000 })

    await settings.click()
    await selected(panelNames.ruffle, 'true')
    await rememberSwitch('false', true)
    await rememberSwitch('true')
    await expectEngine(shell, 'ruffle', 'site-rule', 'ruffle')

    await newTab.click()
    await navigate(shell, `${server.baseUrl}/two`, '同站点新标签')
    await expectEngine(shell, 'ruffle', 'site-rule', 'ruffle')

    await settings.click()
    await selected(panelNames.flash, 'false', true)
    await panelClosed()
    await expectEngine(shell, 'ppapi', 'manual', 'ruffle')
    await settings.click()
    await control(panelNames.replaceWithFlash, { text: '已记住 Ruffle · 当前使用 Flash', click: true })
    await rememberSwitch('true')
    await expectEngine(shell, 'ppapi', 'site-rule', 'ppapi')

    await selected(panelNames.ruffle, 'false', true)
    await panelClosed()
    await expectEngine(shell, 'ruffle', 'manual', 'ppapi')
    await settings.click()
    await control(panelNames.forget, { text: '已记住 Flash · 当前使用 Ruffle', click: true })
    await rememberSwitch('false')
    await expectEngine(shell, 'ruffle', 'manual')

    await newTab.click()
    await navigate(shell, `${server.baseUrl}/three`, '已取消规则的新标签')
    await expectEngine(shell, 'ppapi', 'default')
  } finally {
    await close()
    await server.close()
  }
})