const assert = require('node:assert/strict')
const { resolve } = require('node:path')
const { test } = require('node:test')
const { appNativeFlashSkip, hasFlashPlugin, launchApp, startFixtureServer, waitFor } = require('./helpers.cjs')

test('本地 PPAPI 样本在独立测试 profile 中注册插件并保留 JS 桥', { timeout: 150_000, skip: appNativeFlashSkip() }, async (context) => {
  if (!hasFlashPlugin()) {
    // BYOP：开发环境可能没放插件。跳过并说明，避免误判成代码回归。
    context.skip('未检测到 .runtime/win-x64/pepflashplayer64.dll（BYOP）：跳过 PPAPI 用例。')
    return
  }
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

    const plugin = await app.evaluate(({ app }) =>
      app.getAppMetrics().find((metric) => metric.type === 'Pepper Plugin'))
    assert.ok(plugin, '未发现独立 PPAPI 插件进程')
    if (process.platform === 'win32' && process.env.BAO_SMOKE_HIDDEN === '1') {
      assert.equal(plugin.sandboxed, true, '后台原生 Flash 必须在 PPAPI 进程沙箱内运行')
    }

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

/**
 * 自动发现的优先级：本机可能装着系统 Flash（自动发现能找到），但用户自己投放在
 * `<exe目录>` 的那份必须优先——否则「我明明放了指定版本，实际加载的却是另一份」。
 */
test('设置页：手动投放的插件优先于自动发现', { timeout: 120_000, skip: appNativeFlashSkip() }, async (context) => {
  if (!hasFlashPlugin()) {
    context.skip('未检测到 .runtime/win-x64/pepflashplayer64.dll（BYOP）：跳过插件来源用例。')
    return
  }
  const { app, shell, close } = await launchApp()
  try {
    await shell.evaluate(() => window.baoBrowser.run({ type: 'open-settings' }))
    const id = await waitFor(async () => app.evaluate(({ webContents }) =>
      webContents.getAllWebContents()
        .find((contents) => (contents.getURL() ?? '').startsWith('bao://settings'))?.id ?? null), {
      message: '设置页没有打开'
    })
    const read = (code) => app.evaluate(({ webContents }, payload) =>
      webContents.fromId(payload.id).executeJavaScript(payload.code), { id, code })

    const status = await read('window.baoSettings.flashStatus()')
    assert.equal(status.ready, true)
    assert.equal(status.found, true, '磁盘上应当解析到了插件')
    assert.equal(status.version, '29.0.0.171', `加载的不是投放的那份插件：${status.path}`)
    assert.notEqual(status.source, 'scan', '用户投放在 exe 同级的插件应优先于自动发现')
  } finally {
    await close()
  }
})
