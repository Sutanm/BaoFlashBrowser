const assert = require('node:assert/strict')
const { resolve } = require('node:path')
const { test } = require('node:test')
const { launchApp, startFixtureServer } = require('./helpers.cjs')

test('本地 PPAPI 样本在独立测试 profile 中注册插件并保留 JS 桥', { timeout: 150_000 }, async () => {
  const server = await startFixtureServer()
  const { app, shell, profilePath, close } = await launchApp()
  try {
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.waitFor()
    await address.fill(`${server.baseUrl}/flash.html`)
    await address.press('Enter')

    // 标签名来自页面 document.title，由样本在插件就绪后写入。
    const tab = shell.getByRole('button', { name: /^flash:/ })
    await tab.waitFor({ timeout: 60_000 })
    assert.equal(await tab.getAttribute('title'), 'flash:loaded bridge')

    const processes = await app.evaluate(({ app }) => app.getAppMetrics().map((metric) => metric.type))
    assert.ok(processes.includes('Pepper Plugin'), `未发现独立 PPAPI 插件进程，实际：${processes.join(',')}`)

    const facts = await app.evaluate(async ({ webContents }) => {
      const target = webContents.getAllWebContents().find((contents) => contents.getURL().endsWith('/flash.html'))
      if (!target) return null
      return target.executeJavaScript(`({
        plugins: Array.from(navigator.plugins, (plugin) => plugin.name),
        mime: Boolean(navigator.mimeTypes['application/x-shockwave-flash']),
        state: document.documentElement.dataset.flash,
        percent: document.getElementById('flash') ? document.getElementById('flash').PercentLoaded() : -1
      })`)
    })
    assert.ok(facts, '未找到加载 PPAPI 样本的页面视图。')
    assert.ok(facts.plugins.includes('Shockwave Flash'), `插件未注册：${JSON.stringify(facts.plugins)}`)
    assert.equal(facts.mime, true)
    assert.equal(facts.state, 'loaded bridge')
    assert.equal(facts.percent, 100)

    // 独立测试 profile：运行数据落在本次临时目录，不触碰默认用户数据。
    const userData = await app.evaluate(({ app }) => app.getPath('userData'))
    assert.equal(resolve(userData), resolve(profilePath))
  } finally {
    await close()
    await server.close()
  }
})
