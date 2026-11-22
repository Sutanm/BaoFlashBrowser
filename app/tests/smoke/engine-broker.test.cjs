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

const PLAYER = `(() => {
  const player = document.querySelector('ruffle-embed, ruffle-object, ruffle-player')
  return {
    embeds: document.querySelectorAll('ruffle-embed, ruffle-object, ruffle-player').length,
    canvas: Boolean(player?.shadowRoot?.querySelector('canvas'))
  }
})()`

test('引擎网络 broker：按 crossdomain.xml 放行跨源读，未放行的原样走 CORS', { timeout: 180_000 }, async () => {
  // C 提供 wildcard 策略 → 放行；D 不提供策略 → 拒绝。
  const WILDCARD = '<?xml version="1.0"?><cross-domain-policy><allow-access-from domain="*" /></cross-domain-policy>'
  const swfServer = await startFixtureServer({ '/crossdomain.xml': WILDCARD })
  const allowedServer = await startFixtureServer({
    '/crossdomain.xml': WILDCARD,
    '/data': 'c-data'
  })
  const deniedServer = await startFixtureServer({ '/data': 'd-data' })

  const pageServer = await startFixtureServer({
    '/page.html': `<!doctype html><meta charset="utf-8"><title>broker 页面</title>
      <embed id="flash" src="${swfServer.baseUrl}/probe.swf" type="application/x-shockwave-flash"
             width="400" height="300" allowscriptaccess="always">
      <script>
        window.__allowed = 'pending'
        window.__denied = 'pending'
        // 延迟到 broker 的 fetch 垫片安装之后再发（垫片由 preload 异步注入；
        // 解析期的早请求本来就不该经过它）。
        setTimeout(() => {
          fetch('${allowedServer.baseUrl}/data')
            .then((response) => response.text())
            .then((text) => { window.__allowed = text })
            .catch((error) => { window.__allowed = 'error:' + String(error).slice(0, 40) })
          fetch('${deniedServer.baseUrl}/data')
            .then((response) => response.text())
            .then((text) => { window.__denied = 'READ:' + text })
            .catch((error) => { window.__denied = 'blocked:' + String(error).slice(0, 40) })
        }, 2000)
      </script>`
  })

  const { app, shell, close } = await launchApp()
  try {
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${pageServer.baseUrl}/page.html`)
    await address.press('Enter')
    await shell.getByRole('button', { name: 'broker 页面', exact: true }).waitFor({ timeout: 30_000 })

    await shell.getByRole('switch', { name: '切换到 Ruffle 引擎', exact: true }).click()

    // 1) 根 SWF 跨源加载：SWF host 提供 wildcard 策略 → 放行（flask fixture 服务器没有
    //    crossdomain.xml，所以这里给 swfServer 也加一份）
    const player = await waitFor(async () => {
      const facts = await viewEval(app, shell, PLAYER)
      return facts.canvas ? facts : null
    }, { message: 'Ruffle 未加载跨源 SWF（broker 放行失败）。' })
    assert.equal(player.canvas, true)

    // 2) wildcard 策略的跨源数据：页面 JS 经 broker 读到
    const allowed = await waitFor(async () => {
      const value = await viewEval(app, shell, 'window.__allowed')
      return value && value !== 'pending' ? value : null
    }, { message: 'broker 未放行 wildcard 策略的跨源请求。' })
    assert.equal(allowed, 'c-data')

    // 3) 无策略的跨源数据：broker 拒绝 → 回退浏览器 fetch → CORS 拦住
    const denied = await waitFor(async () => {
      const value = await viewEval(app, shell, 'window.__denied')
      return value && value !== 'pending' ? value : null
    }, { message: '无策略的跨源请求未被拒绝。' })
    assert.ok(denied.startsWith('blocked:'), `无策略请求被读到了：${denied}`)
  } finally {
    await close()
    await pageServer.close()
    await deniedServer.close()
    await allowedServer.close()
    await swfServer.close()
  }
})
