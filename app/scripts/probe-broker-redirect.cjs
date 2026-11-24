/* 一次性探针：本地 SWF 跨源加载时，broker 对「crossdomain.xml 302 重定向」的处理。
   不属于产品代码；结论写进 docs/reports。用法：
   node scripts/probe-broker-redirect.cjs [--redirect]
*/
const { createServer } = require('node:http')
const { once } = require('node:events')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { launchApp } = require('../tests/smoke/helpers.cjs')

const WILDCARD = '<cross-domain-policy><allow-access-from domain="*" /></cross-domain-policy>'
const REDIRECT = process.argv.includes('--redirect')
const ENGINE = process.argv.includes('--ppapi') ? 'ppapi' : 'ruffle'
const log = []

function serve(routes, label) {
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1')
    log.push(`${label} ${request.method} ${pathname}`)
    const route = routes[pathname]
    if (route) {
      route(request, response)
      return
    }
    response.writeHead(404, { 'Content-Type': 'text/plain' })
    response.end('not found')
  })
  server.listen(0, '127.0.0.1')
  return once(server, 'listening').then(() => server)
}

const text = (body, type = 'text/plain; charset=utf-8') => (request, response) => {
  response.writeHead(200, { 'Content-Type': type })
  response.end(body)
}

;(async () => {
  // B：SWF 所在源；C：数据源（crossdomain.xml 可能 302）
  const cRoutes = {
    '/data.txt': text('cross-origin-data'),
    '/real-crossdomain.xml': text(WILDCARD, 'text/x-cross-domain-policy')
  }
  if (REDIRECT) {
    cRoutes['/crossdomain.xml'] = (request, response) => {
      response.writeHead(302, { Location: '/real-crossdomain.xml' })
      response.end()
    }
  } else {
    cRoutes['/crossdomain.xml'] = text(WILDCARD, 'text/x-cross-domain-policy')
  }
  const cServer = await serve(cRoutes, 'C')
  const cBase = `http://127.0.0.1:${cServer.address().port}`

  const swf = readFileSync(join(__dirname, '../tests/smoke/fixtures/netload.swf'))
  const bServer = await serve({
    // SWF 自身是跨源加载的：broker 会先查它所在源的 crossdomain.xml。
    '/crossdomain.xml': text(WILDCARD, 'text/x-cross-domain-policy'),
    '/netload.swf': (request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/x-shockwave-flash' })
      response.end(swf)
    }
  }, 'B')
  const bBase = `http://127.0.0.1:${bServer.address().port}`

  const page = `<!doctype html><meta charset="utf-8"><title>broker 重定向探针</title>
<script>window.__netload = 'pending'; window.__netloadLog = []; window.__netloadReport = (t) => { window.__netload = t; window.__netloadLog.push(t); };</script>
<embed id="flash" src="${bBase}/netload.swf?url=${encodeURIComponent(`${cBase}/data.txt`)}"
  type="application/x-shockwave-flash" width="400" height="300" allowscriptaccess="always">`
  const aServer = await serve({ '/page.html': text(page, 'text/html; charset=utf-8') }, 'A')
  const aBase = `http://127.0.0.1:${aServer.address().port}`

  const { app, shell, close } = await launchApp()
  try {
    await shell.evaluate((engine) => window.baoBrowser.run({ type: 'set-setting', key: 'engine.default', value: engine }), ENGINE)
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${aBase}/page.html`)
    await address.press('Enter')
    await new Promise((done) => setTimeout(done, 6000))

    const facts = await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html'))
      const view = win.contentView.children.find((c) => /^https?:/.test(c.webContents?.getURL() ?? ''))
      if (!view) return { page: false }
      return view.webContents.executeJavaScript(`({
        page: true,
        netload: window.__netload ?? null,
        log: window.__netloadLog ?? [],
        embed: Boolean(document.querySelector('embed'))
      })`)
    })
    console.log(JSON.stringify({ redirect: REDIRECT, facts, requests: log }, null, 1))
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
