const assert = require('node:assert/strict')
const { test } = require('node:test')
const { launchApp, startFixtureServer, waitFor } = require('./helpers.cjs')

async function viewEval(app, shell, code) {
  const handle = await app.browserWindow(shell)
  return handle.evaluate((window, source) => {
    const view = window.contentView.children
      .find((child) => child.webContents && child.webContents !== window.webContents)
    return view.webContents.executeJavaScript(source)
  }, code)
}

test('Ruffle 通过页面 fetch 加载跨源 SWF（CORS 兼容层）', { timeout: 120_000 }, async () => {
  // 两个端口 = 两个源：页面在 A，SWF 在 B。Ruffle 用页面 fetch 取 SWF，
  // 没有兼容层时会被 CORS 拦掉（真实站点 4399 的 CDN 就是这样）。
  const swfServer = await startFixtureServer()
  const pageServer = await startFixtureServer({
    '/cross.html': `<!doctype html><meta charset="utf-8"><title>跨源插件页面</title>
      <embed id="flash" src="${swfServer.baseUrl}/probe.swf" type="application/x-shockwave-flash"
             width="400" height="300" allowscriptaccess="always">`
  })
  const { app, shell, close } = await launchApp()
  try {
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${pageServer.baseUrl}/cross.html`)
    await address.press('Enter')
    await shell.getByRole('button', { name: '跨源插件页面', exact: true }).waitFor({ timeout: 30_000 })

    await shell.getByRole('button', { name: '切换到Ruffle', exact: true }).click()

    const player = await waitFor(async () => {
      const facts = await viewEval(app, shell, `(() => {
        const element = document.querySelector('ruffle-embed, ruffle-object, ruffle-player')
        const shadow = element && element.shadowRoot ? element.shadowRoot : null
        return {
          canvas: Boolean(shadow && shadow.querySelector('canvas')),
          text: shadow ? shadow.textContent.slice(0, 200) : null
        }
      })()`)
      return facts.canvas ? facts : null
    }, { message: 'Ruffle 未加载跨源 SWF（CORS 兼容层失效）。' })
    assert.equal(player.canvas, true)
  } finally {
    await close()
    await pageServer.close()
    await swfServer.close()
  }
})
