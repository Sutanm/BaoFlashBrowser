/* 一次性探针：沙箱化 iframe（无 allow-same-origin）里 Ruffle 的 broker 请求是否被拒。
   该帧的文档 URL 是 http(s)，但安全 origin 是 opaque —— 审计指出的绕过点。 */
const { createServer } = require('node:http')
const { once } = require('node:events')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { launchApp } = require('../tests/smoke/helpers.cjs')

const WILDCARD = '<cross-domain-policy><allow-access-from domain="*" /></cross-domain-policy>'

async function serve(routes, label, log) {
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1')
    log.push(`${label} ${pathname}`)
    const route = routes[pathname]
    if (route) return route(request, response)
    response.writeHead(404)
    response.end('not found')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server
}

const text = (body, type = 'text/plain; charset=utf-8') => (request, response) => {
  response.writeHead(200, { 'Content-Type': type })
  response.end(body)
}

;(async () => {
  const log = []
  const swf = readFileSync(join(__dirname, '../tests/smoke/fixtures/probe.swf'))
  const swfServer = await serve({
    '/crossdomain.xml': text(WILDCARD, 'text/x-cross-domain-policy'),
    '/probe.swf': (request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/x-shockwave-flash' })
      response.end(swf)
    }
  }, 'SWF', log)
  const swfBase = `http://127.0.0.1:${swfServer.address().port}`

  // 被嵌入的帧页面：SWF 来自另一个源
  const frameServer = await serve({
    '/frame.html': text(`<!doctype html><meta charset="utf-8">
      <embed src="${swfBase}/probe.swf" type="application/x-shockwave-flash" width="300" height="200" allowscriptaccess="always">`,
      'text/html; charset=utf-8')
  }, 'FRAME', log)
  const frameBase = `http://127.0.0.1:${frameServer.address().port}`

  // 沙箱 iframe：allow-scripts 但**没有** allow-same-origin → opaque origin
  const pageServer = await serve({
    '/page.html': text(`<!doctype html><meta charset="utf-8"><title>沙箱帧探针</title>
      <iframe id="sandboxed" sandbox="allow-scripts" src="${frameBase}/frame.html" width="400" height="300"></iframe>`,
      'text/html; charset=utf-8')
  }, 'PAGE', log)
  const pageBase = `http://127.0.0.1:${pageServer.address().port}`

  const { app, shell, close } = await launchApp()
  try {
    await shell.evaluate(() => window.baoBrowser.run({ type: 'set-setting', key: 'engine.default', value: 'ruffle' }))
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${pageBase}/page.html`)
    await address.press('Enter')
    await new Promise((done) => setTimeout(done, 8000))

    const facts = await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html'))
      const view = win.contentView.children.find((c) => /^https?:/.test(c.webContents?.getURL() ?? ''))
      const main = view.webContents.mainFrame
      const child = main.framesInSubtree.find((frame) => /frame\.html/.test(frame.url))
      const inChild = child
        ? await child.executeJavaScript(`({
            origin: location.origin,
            embeds: document.querySelectorAll('ruffle-embed, ruffle-player').length,
            canvas: Boolean(document.querySelector('ruffle-embed, ruffle-player')?.shadowRoot?.querySelector('canvas'))
          })`)
        : null
      return { childUrl: child?.url ?? null, childOrigin: child?.origin ?? null, inChild }
    })
    console.log(JSON.stringify({ facts, requests: log }, null, 1))
  } finally {
    await close()
    await pageServer.close()
    await frameServer.close()
    await swfServer.close()
  }
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
