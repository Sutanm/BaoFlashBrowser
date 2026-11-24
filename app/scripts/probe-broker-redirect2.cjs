/* 一次性探针：broker 取 crossdomain.xml 时对重定向的处理。
   三种情形：直接 200 / 同源 302 / 跨源 302。看 Ruffle 还能不能加载跨源 SWF。
   用法：node scripts/probe-broker-redirect2.cjs */
const { createServer } = require('node:http')
const { once } = require('node:events')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { launchApp } = require('../tests/smoke/helpers.cjs')

const WILDCARD = '<?xml version="1.0"?><cross-domain-policy><allow-access-from domain="*" /></cross-domain-policy>'
const caseName = process.argv[2] ?? 'direct'
const requests = []

function text(body, type = 'text/plain; charset=utf-8') {
  return (request, response) => {
    response.writeHead(200, { 'Content-Type': type })
    response.end(body)
  }
}

function redirect(location) {
  return (request, response) => {
    response.writeHead(302, { Location: location })
    response.end()
  }
}

async function serve(routes, label) {
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1')
    requests.push(`${label} ${pathname}`)
    const route = routes[pathname]
    if (route) return route(request, response)
    response.writeHead(404, { 'Content-Type': 'text/plain' })
    response.end('not found')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server
}

;(async () => {
  const swf = readFileSync(join(__dirname, '../tests/smoke/fixtures/probe.swf'))
  // C：跨源 302 的目标（另一个 origin）
  const cServer = await serve({ '/policy.xml': text(WILDCARD, 'text/x-cross-domain-policy') }, 'C')
  const cBase = `http://127.0.0.1:${cServer.address().port}`

  const swfRoutes = { '/probe.swf': (request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/x-shockwave-flash' })
    response.end(swf)
  } }
  if (caseName === 'direct') swfRoutes['/crossdomain.xml'] = text(WILDCARD, 'text/x-cross-domain-policy')
  else if (caseName === 'same-origin') {
    swfRoutes['/crossdomain.xml'] = redirect('/policy.xml')
    swfRoutes['/policy.xml'] = text(WILDCARD, 'text/x-cross-domain-policy')
  } else {
    // 跨源：B 的策略 302 到 C（审计指出的情形）
    swfRoutes['/crossdomain.xml'] = redirect(`${cBase}/policy.xml`)
  }
  const bServer = await serve(swfRoutes, 'B')
  const bBase = `http://127.0.0.1:${bServer.address().port}`

  const aServer = await serve({
    '/page.html': text(`<!doctype html><meta charset="utf-8"><title>broker 重定向探针</title>
      <embed id="flash" src="${bBase}/probe.swf" type="application/x-shockwave-flash"
             width="400" height="300" allowscriptaccess="always">`, 'text/html; charset=utf-8')
  }, 'A')
  const aBase = `http://127.0.0.1:${aServer.address().port}`

  const { app, shell, close } = await launchApp()
  try {
    await shell.getByRole('switch', { name: '切换到 Ruffle 引擎', exact: true }).click({ timeout: 30_000 })
    await shell.getByRole('switch', { name: '切换到原生 Flash 引擎', exact: true }).waitFor()
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${aBase}/page.html`)
    await address.press('Enter')
    await shell.getByRole('button', { name: 'broker 重定向探针', exact: true }).waitFor({ timeout: 30_000 })
    await new Promise((done) => setTimeout(done, 4000))

    const facts = await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html'))
      const view = win.contentView.children.find((c) => /^https?:/.test(c.webContents?.getURL() ?? ''))
      return view.webContents.executeJavaScript(`(() => {
        const player = document.querySelector('ruffle-embed, ruffle-object, ruffle-player')
        return {
          embeds: document.querySelectorAll('ruffle-embed, ruffle-object, ruffle-player').length,
          canvas: Boolean(player?.shadowRoot?.querySelector('canvas')),
          error: document.querySelector('ruffle-embed')?.shadowRoot?.textContent?.slice(0, 60) ?? null
        }
      })()`)
    })
    console.log(JSON.stringify({ case: caseName, facts, requests }))
  } finally {
    await close()
    await aServer.close()
    await bServer.close()
    await cServer.close()
  }
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
