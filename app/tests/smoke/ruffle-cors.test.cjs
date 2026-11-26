const assert = require('node:assert/strict')
const { test } = require('node:test')
const { launchApp, setEngine, startFixtureServer, waitFor } = require('./helpers.cjs')

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

const PLAYER_FACTS = `(() => {
  const player = document.querySelector('ruffle-embed, ruffle-object, ruffle-player')
  return {
    embeds: document.querySelectorAll('ruffle-embed, ruffle-object, ruffle-player').length,
    canvas: Boolean(player?.shadowRoot?.querySelector('canvas'))
  }
})()`

test('Ruffle 跨源加载：SWF、数据请求与跨源 iframe 子帧', { timeout: 180_000 }, async () => {
  // 三个源，避免"同源冒充跨源"的假阳性：
  //   A 页面（pageServer）→ B 数据/iframe（dataServer）→ C SWF（swfServer）
  // A→C、B→C 都是跨源，且两个服务器都不发 Access-Control-Allow-Origin。
  const WILDCARD = '<?xml version="1.0"?><cross-domain-policy><allow-access-from domain="*" /></cross-domain-policy>'
  const swfServer = await startFixtureServer({ '/crossdomain.xml': WILDCARD })
  const dataServer = await startFixtureServer({
    '/crossdomain.xml': WILDCARD,
    '/data.json': 'ok',
    '/embed.html': `<!doctype html><meta charset="utf-8"><title>子帧</title>
      <embed id="flash" src="${swfServer.baseUrl}/probe.swf" type="application/x-shockwave-flash"
             width="400" height="300" allowscriptaccess="always">`
  })
  const pageServer = await startFixtureServer({
    '/cors.html': `<!doctype html><meta charset="utf-8"><title>跨源请求页面</title>
      <script>
        window.__cors = 'pending'
        fetch('${dataServer.baseUrl}/data.json')
          .then((response) => response.text())
          .then((text) => { window.__cors = text })
          .catch((error) => { window.__cors = 'error:' + String(error) })
      </script>`,
    '/cross.html': `<!doctype html><meta charset="utf-8"><title>跨源插件页面</title>
      <embed id="flash" src="${swfServer.baseUrl}/probe.swf" type="application/x-shockwave-flash"
             width="400" height="300" allowscriptaccess="always">
      <iframe id="frame" src="${dataServer.baseUrl}/embed.html" width="400" height="300"></iframe>`
  })
  const { app, shell, close } = await launchApp()
  try {
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${pageServer.baseUrl}/cors.html`)
    await address.press('Enter')
    await shell.getByRole('button', { name: '跨源请求页面', exact: true }).waitFor({ timeout: 30_000 })

    // 1) 页面 JS 自己的跨源 fetch：原生引擎下没有 broker 垫片，应按 CORS 被拦
    //    （这条守卫「页面同源策略未被放宽」；跨源读的放行路径由 engine-broker.test.cjs 覆盖）
    const pageFetch = await waitFor(async () => {
      const value = await viewEval(app, shell, 'window.__cors')
      return value && value !== 'pending' ? value : null
    }, { message: '页面 fetch 状态未更新。' })
    assert.ok(pageFetch.startsWith('error:'), `页面 JS 的跨源读未被 CORS 拦住：${pageFetch}`)

    // 2) 切到 Ruffle：主帧的 SWF 来自第三个源（A→C）
    await setEngine(shell, 'ruffle')
    await address.fill(`${pageServer.baseUrl}/cross.html`)
    await address.press('Enter')
    await shell.getByRole('button', { name: '跨源插件页面', exact: true }).waitFor({ timeout: 30_000 })

    const main = await waitFor(async () => {
      const facts = await viewEval(app, shell, PLAYER_FACTS)
      return facts.canvas ? facts : null
    }, { message: 'Ruffle 未加载主帧的跨源 SWF。' })
    assert.equal(main.canvas, true)

    // 3) 跨源 iframe（A→B）里的 SWF 又来自第三个源（B→C）：两条边都跨源
    const subframe = await waitFor(async () => {
      const facts = await frameEval(app, shell, 0, PLAYER_FACTS)
      return facts && facts.embeds > 0 && facts.canvas ? facts : null
    }, { message: '跨源 iframe 里的 SWF 未被 Ruffle 接管（子帧 preload 或 CORS 失效）。' })
    assert.ok(subframe.embeds >= 1)
  } finally {
    await close()
    await pageServer.close()
    await dataServer.close()
    await swfServer.close()
  }
})
