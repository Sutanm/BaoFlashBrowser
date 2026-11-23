const assert = require('node:assert/strict')
const { test } = require('node:test')
const { launchApp, startFixtureServer, waitFor } = require('./helpers.cjs')

async function viewFact(app, shell, code) {
  const handle = await app.browserWindow(shell)
  return handle.evaluate(async (window, source) => {
    const view = window.contentView.children.find((child) =>
      child.webContents && new URL(child.webContents.getURL() || 'about:blank').searchParams.get('baoOverlay') === 'panel')
    if (!view) return null
    return view.webContents.executeJavaScript(source)
  }, code)
}

const SURFACE = `getComputedStyle(document.documentElement).getPropertyValue('--surface-toolbar').trim()`

test('暗色模式：跟随原生主题切换外壳与叠加层', { timeout: 120_000 }, async () => {
  const server = await startFixtureServer()
  const { app, shell, close } = await launchApp()
  try {
    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light' })
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${server.baseUrl}/flash.html`)
    await address.press('Enter')
    await new Promise((done) => setTimeout(done, 1500))

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
    await shell.getByRole('button', { name: '引擎设置', exact: true }).click()
    const overlay = await waitFor(async () => {
      const value = await viewFact(app, shell, `({ theme: document.documentElement.dataset.theme ?? null })`)
      return value?.theme === 'dark' ? value : null
    }, { message: '叠加层没有跟随暗色' })
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
