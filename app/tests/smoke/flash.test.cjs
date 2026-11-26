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

/**
 * 实验（2026-11-26 审计 P2）：**同一渲染进程里能否存在两个 PPAPI 实例**。
 *
 * 这是 B6「标签进程合并」的承重假设：我们此前只有 `clone()` 的**间接**证据（克隆帧与源同进程时
 * 第二个实例退化成普通元素），却据此同时否决了「复制标签」和「按站点合并进程」两条路线。
 *
 * 判据：同一页面里两个 `<embed>` 都必须实例化到 `PercentLoaded() === 100`。
 * 若成立 → 「一进程一实例」不成立，进程合并对 Flash 标签也可行；若不成立 → 硬约束得到确认。
 */
test('同页两个 <embed>：两个 PPAPI 实例都能初始化', { timeout: 180_000, skip: appNativeFlashSkip() }, async (context) => {
  if (!hasFlashPlugin()) {
    context.skip('未检测到 .runtime/win-x64/pepflashplayer64.dll（BYOP）：跳过双实例实验。')
    return
  }
  const doubleHtml = [
    '<!doctype html><meta charset="utf-8"><title>DOUBLE</title><body>',
    '<embed id="a" src="probe.swf" type="application/x-shockwave-flash" width="200" height="150">',
    '<embed id="b" src="probe.swf" type="application/x-shockwave-flash" width="200" height="150">',
    '</body>'
  ].join('')
  const server = await startFixtureServer({ '/double.html': doubleHtml })
  const { app, shell, close } = await launchApp()
  try {
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.waitFor()
    await address.fill(`${server.baseUrl}/double.html`)
    await address.press('Enter')

    // 直接轮询两个 `<embed>` 的 `PercentLoaded()`：不借道标签标题，避免把标题更新时序
    // 混进"实例能不能起来"这个判据。
    const facts = await waitFor(async () => {
      const values = await app.evaluate(async ({ webContents }) => {
        const target = webContents.getAllWebContents().find((contents) => {
          try {
            return contents.getURL().endsWith('/double.html')
          } catch {
            return false
          }
        })
        if (!target) return null
        return target.executeJavaScript(`({
          a: (() => { try { return document.getElementById('a').PercentLoaded() } catch { return -2 } })(),
          b: (() => { try { return document.getElementById('b').PercentLoaded() } catch { return -2 } })()
        })`)
      })
      return values && values.a === 100 && values.b === 100 ? values : null
    }, { timeout: 90_000, message: '同一渲染进程里的第二个 PPAPI 实例没有初始化（单实例约束成立）' })
    assert.equal(facts.a, 100)
    assert.equal(facts.b, 100)

    // 顺带确认：两个实例共用**一个** Pepper 插件进程（操作系统进程），不是每实例一个。
    const pluginProcesses = await app.evaluate(({ app }) =>
      app.getAppMetrics().filter((metric) => metric.type === 'Pepper Plugin').length)
    assert.equal(pluginProcesses, 1, `Pepper 插件进程数应为 1，实际 ${pluginProcesses}`)
  } finally {
    await close()
    await server.close()
  }
})
