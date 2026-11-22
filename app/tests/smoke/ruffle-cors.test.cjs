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

async function frameEval(app, shell, index, code) {
  const handle = await app.browserWindow(shell)
  return handle.evaluate((window, payload) => {
    const view = window.contentView.children
      .find((child) => child.webContents && child.webContents !== window.webContents)
    const frame = view.webContents.mainFrame.frames[payload.index]
    return frame ? frame.executeJavaScript(payload.code, false) : null
  }, { index, code })
}

const EMBED_PAGE = `<!doctype html><meta charset="utf-8"><title>子帧</title>
  <embed id="flash" src="probe.swf" type="application/x-shockwave-flash" width="400" height="300" allowscriptaccess="always">`

test('Ruffle 跨源加载：SWF、数据请求与 iframe 子帧', { timeout: 180_000 }, async () => {
  // 两个端口 = 两个源：页面在 A，SWF / 数据 / 子帧都在 B。
  // 没有 CORS 兼容层时 fetch 会被拦；没有子帧 preload 时 iframe 里的 Ruffle 注入会被
  // 同源策略挡住（真实站点 2026-11-22 淘米对照的 `Couldn't load Ruffle into IFRAME[]`）。
  const swfServer = await startFixtureServer({
    '/data.json': 'ok',
    '/embed.html': EMBED_PAGE
  })
  const pageServer = await startFixtureServer({
    '/cross.html': `<!doctype html><meta charset="utf-8"><title>跨源插件页面</title>
      <script>
        window.__cors = 'pending'
        fetch('${swfServer.baseUrl}/data.json')
          .then((response) => response.text())
          .then((text) => { window.__cors = text })
          .catch((error) => { window.__cors = 'error:' + String(error) })
      </script>
      <embed id="flash" src="${swfServer.baseUrl}/probe.swf" type="application/x-shockwave-flash"
             width="400" height="300" allowscriptaccess="always">
      <iframe id="frame" src="${swfServer.baseUrl}/embed.html" width="400" height="300"></iframe>`
  })
  const { app, shell, close } = await launchApp()
  try {
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${pageServer.baseUrl}/cross.html`)
    await address.press('Enter')
    await shell.getByRole('button', { name: '跨源插件页面', exact: true }).waitFor({ timeout: 30_000 })

    // 1) 跨源数据请求：CORS 兼容层（与引擎无关，PPAPI 引擎下先验）
    const cors = await waitFor(async () => {
      const value = await viewEval(app, shell, 'window.__cors')
      return value && value !== 'pending' ? value : null
    }, { message: '跨源数据请求被 CORS 拦住。' })
    assert.equal(cors, 'ok')

    // 2) 切到 Ruffle：主帧与跨源 iframe 都要被 polyfill
    await shell.getByRole('switch', { name: '切换到 Ruffle 引擎', exact: true }).click()

    const main = await waitFor(async () => {
      const facts = await viewEval(app, shell, `(() => {
        const player = document.querySelector('ruffle-embed, ruffle-object, ruffle-player')
        return { canvas: Boolean(player?.shadowRoot?.querySelector('canvas')) }
      })()`)
      return facts.canvas ? facts : null
    }, { message: 'Ruffle 未加载主帧 SWF（CORS 兼容层失效）。' })
    assert.equal(main.canvas, true)

    const subframe = await waitFor(async () => {
      const facts = await frameEval(app, shell, 0, `(() => {
        const player = document.querySelector('ruffle-embed, ruffle-object, ruffle-player')
        return {
          embeds: document.querySelectorAll('ruffle-embed, ruffle-object, ruffle-player').length,
          canvas: Boolean(player?.shadowRoot?.querySelector('canvas'))
        }
      })()`)
      return facts && facts.embeds > 0 && facts.canvas ? facts : null
    }, { message: '跨源 iframe 里的 SWF 未被 Ruffle 接管（子帧 preload 未生效）。' })
    assert.ok(subframe.embeds >= 1)
  } finally {
    await close()
    await pageServer.close()
    await swfServer.close()
  }
})
