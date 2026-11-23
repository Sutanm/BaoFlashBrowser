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

test('引擎网络 broker：只有 Ruffle 能跨域读，页面脚本的同源策略不受影响', { timeout: 180_000 }, async () => {
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
        // 页面脚本自己发起的跨源请求：必须按浏览器 CORS 规则被拦（审计 P1-1 的回归守卫）。
        fetch('${allowedServer.baseUrl}/data')
          .then((response) => response.text())
          .then((text) => { window.__allowed = 'READ:' + text })
          .catch((error) => { window.__allowed = 'blocked:' + String(error).slice(0, 40) })
        fetch('${deniedServer.baseUrl}/data')
          .then((response) => response.text())
          .then((text) => { window.__denied = 'READ:' + text })
          .catch((error) => { window.__denied = 'blocked:' + String(error).slice(0, 40) })
      </script>`
  })

  const { app, shell, close } = await launchApp()
  try {
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${pageServer.baseUrl}/page.html`)
    await address.press('Enter')
    await shell.getByRole('button', { name: 'broker 页面', exact: true }).waitFor({ timeout: 30_000 })

    await shell.getByRole('switch', { name: '切换到 Ruffle 引擎', exact: true }).click({ timeout: 30_000 })

    // 1) 根 SWF 跨源加载：Ruffle 自己的 fetch 经策略放行（策略文件 wildcard）。
    const player = await waitFor(async () => {
      const facts = await viewEval(app, shell, PLAYER)
      return facts.canvas ? facts : null
    }, { message: 'Ruffle 未加载跨源 SWF（broker 放行失败）。' })
    assert.equal(player.canvas, true)

    // 2) 页面脚本没有特权入口：临时全局已被删除，fetch 保持原生。
    const surface = await viewEval(app, shell, `(() => {
      const leftovers = Object.keys(window).filter((key) => key.startsWith('__bao_'))
      return {
        leftovers,
        hasNet: typeof window.__baoNet,
        nativeFetch: /native code/i.test(Function.prototype.toString.call(window.fetch))
      }
    })()`)
    assert.deepEqual(surface.leftovers, [], `页面世界残留了 broker 入口：${surface.leftovers}`)
    assert.equal(surface.hasNet, 'undefined')
    assert.equal(surface.nativeFetch, true, 'window.fetch 被替换了（审计 P1-1）')

    // 3) 页面脚本的跨源请求仍按 CORS 被拦，即使目标站策略是 wildcard。
    const denied = await waitFor(async () => {
      const value = await viewEval(app, shell, 'window.__allowed')
      return value && value !== 'pending' ? value : null
    }, { message: '页面脚本的跨源请求没有结论。' })
    assert.ok(denied.startsWith('blocked:'), `页面脚本读到了跨域响应：${denied}`)

    const denied2 = await waitFor(async () => {
      const value = await viewEval(app, shell, 'window.__denied')
      return value && value !== 'pending' ? value : null
    }, { message: '页面脚本的第二个跨源请求没有结论。' })
    assert.ok(denied2.startsWith('blocked:'), `页面脚本读到了跨域响应：${denied2}`)
  } finally {
    await close()
    await pageServer.close()
    await deniedServer.close()
    await allowedServer.close()
    await swfServer.close()
  }
})
