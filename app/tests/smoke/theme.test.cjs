const assert = require('node:assert/strict')
const { test } = require('node:test')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { launchApp, launchAppAt, page, startFixtureServer, waitFor } = require('./helpers.cjs')

async function viewFact(app, shell, code) {
  const handle = await app.browserWindow(shell)
  return handle.evaluate(async (window, source) => {
    const view = window.contentView.children.find((child) =>
      child.webContents && new URL(child.webContents.getURL() || 'about:blank').searchParams.get('baoOverlay') === 'overlay')
    if (!view) return null
    return view.webContents.executeJavaScript(source)
  }, code)
}

const SURFACE = `getComputedStyle(document.documentElement).getPropertyValue('--surface-toolbar').trim()`

test('暗色模式：跟随原生主题切换外壳与叠加层', { timeout: 120_000 }, async () => {
  const server = await startFixtureServer({ '/': page('主题测试页') })
  const { app, shell, close } = await launchApp()
  try {
    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light' })
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(server.baseUrl)
    await address.press('Enter')
    await shell.getByRole('button', { name: '主题测试页', exact: true }).waitFor()

    const light = await shell.evaluate(`(() => ({
      theme: document.documentElement.dataset.theme,
      surface: ${SURFACE}
    }))()`)
    assert.equal(light.theme, 'light')

    // 切暗色：外壳与叠加层都必须跟着变，且用的是不同的表面色。
    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark' })
    const dark = await waitFor(async () => {
      const value = await shell.evaluate(`(() => ({
        theme: document.documentElement.dataset.theme,
        surface: ${SURFACE}
      }))()`)
      return value.theme === 'dark' ? value : null
    }, { message: '外壳没有跟随原生主题切到暗色' })

    assert.notEqual(dark.surface.toLowerCase(), light.surface.toLowerCase(), '暗色下表面色没有变化')

    // 引擎面板是同一个窗口里的 WebContentsView 叠加层，也必须走暗色。
    // 并行跑时机器忙，先等面板挂上（视图是点击后才 attach 的），再等主题生效。
    await shell.getByRole('button', { name: '引擎设置', exact: true }).click()
    await waitFor(async () => {
      const value = await viewFact(app, shell, `Boolean(document.querySelector('.engine-panel'))`)
      return value ? true : null
    }, { timeout: 60_000, message: '引擎面板没有挂上叠加层视图' })
    const overlay = await waitFor(async () => {
      const value = await viewFact(app, shell, `({ theme: document.documentElement.dataset.theme ?? null })`)
      return value?.theme === 'dark' ? value : null
    }, { timeout: 60_000, message: '叠加层没有跟随暗色' })
    assert.equal(overlay.theme, 'dark')

    // 切回亮色同样要生效。
    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light' })
    const back = await waitFor(async () => {
      const value = await shell.evaluate(`document.documentElement.dataset.theme`)
      return value === 'light' ? value : null
    }, { message: '切回亮色失败' })
    assert.equal(back, 'light')
    const overlayBack = await waitFor(async () => {
      const value = await viewFact(app, shell, `document.documentElement.dataset.theme ?? null`)
      return value === 'light' ? value : null
    }, { message: '叠加层没有跟随切回亮色' })
    assert.equal(overlayBack, 'light')
  } finally {
    await close()
    await server.close()
  }
})

/**
 * 主题开关走**设置**（M2）：设置写库 → `nativeTheme.themeSource` → 外壳/标题栏重绘。
 *
 * 这条用例覆盖的是「一条设置命令能同时改变用户看到的三处」：外壳 CSS token、系统窗口按钮
 * 配色（`setTitleBarOverlay` 没有 getter，这里记录真实调用参数）、以及投影里的解析主题。
 * 断言用「两次调用的取值不同」而不是「等于某个常量」，避免把 token 写死成恒真条件。
 */
test('设置里的主题模式：写库后外壳与标题栏按钮一起变，重启后保留', { timeout: 120_000 }, async () => {
  const profilePath = await mkdtemp(join(tmpdir(), 'bao-next-theme-'))
  let app
  let shell
  let close
  try {
    const session = await launchAppAt(profilePath)
    app = session.app
    shell = session.shell
    close = session.close

    await app.evaluate(({ BrowserWindow }) => {
      const prototype = BrowserWindow.prototype
      const original = prototype.setTitleBarOverlay
      globalThis.__baoTitlebar = []
      prototype.setTitleBarOverlay = function record(options) {
        globalThis.__baoTitlebar.push(options)
        return original.call(this, options)
      }
    })

    const setTheme = async (value) => {
      const result = await shell.evaluate((mode) =>
        window.baoBrowser.run({ type: 'set-setting', key: 'theme.mode', value: mode }), value)
      assert.equal(result.ok, true, `写入主题失败：${result.code}`)
      return result.state
    }

    await setTheme('light')
    await waitFor(async () => (await shell.evaluate(`document.documentElement.dataset.theme`)) === 'light'
      ? true : null, { message: '切换到浅色后外壳没有重绘' })
    const lightCall = await app.evaluate(() => globalThis.__baoTitlebar.at(-1))
    assert.ok(lightCall?.color, '浅色下应调用 setTitleBarOverlay 并带配色')

    const state = await setTheme('dark')
    assert.equal(state.settings.themeMode, 'dark', '投影应带回用户选择的模式')
    await waitFor(async () => (await shell.evaluate(`document.documentElement.dataset.theme`)) === 'dark'
      ? true : null, { message: '设置成深色后外壳没有重绘' })

    const darkCall = await app.evaluate(() => globalThis.__baoTitlebar.at(-1))
    assert.notEqual(darkCall.color.toLowerCase(), lightCall.color.toLowerCase(),
      '系统窗口按钮的底色没有跟着主题变')
    assert.notEqual(darkCall.symbolColor.toLowerCase(), lightCall.symbolColor.toLowerCase(),
      '系统窗口按钮的符号色没有跟着主题变')

    const themeSource = await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)
    assert.equal(themeSource, 'dark', '设置项应 1:1 映射到 nativeTheme.themeSource')
  } finally {
    if (close) await close()
  }

  // 同一份 profile 重启：模式必须还在（验证的是落库，不是内存态）。
  const relaunched = await launchAppAt(profilePath)
  try {
    const state = await relaunched.shell.evaluate(() =>
      window.baoBrowser.run({ type: 'snapshot' }).then((result) => result.state))
    assert.equal(state.settings.themeMode, 'dark', '重启后主题模式没有保留')
    assert.equal(state.theme, 'dark')
  } finally {
    await relaunched.close()
    await rm(profilePath, { recursive: true, force: true, maxRetries: 3 })
  }
})
