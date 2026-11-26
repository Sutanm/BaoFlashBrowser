const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createServer } = require('node:http')
const { launchApp, waitFor } = require('./helpers.cjs')

/**
 * 站点图标（favicon）：标签栏要画出站点自己的图标，没有才退回通用页形。
 *
 * 链路是「渲染进程上报 → 主进程按 origin 去重抓取 → 内联成 data URL → 投影给外壳」：
 * - 抓取必须走**页面会话**（cookie/代理与页面一致），所以用例只要证明图标真的到了标签上；
 * - 没有图标的页面（大量内网页、极简页）不能画占位方块，也不能每次导航都重发请求。
 */

/** 1×1 的红点 PNG：够小、无外部依赖，`<img>` 能直接解码。 */
const ICON_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

const html = (title, icon) => `<!doctype html><meta charset="utf-8"><title>${title}</title>`
  + (icon ? `<link rel="icon" type="image/png" href="${icon}">` : '')
  + `<h1>${title}</h1>`

/** 标签栏里那颗图标的现状（`src === null` = 没有 `<img>`，即退回通用页形）。 */
const tabIcon = (shell) => shell.evaluate(() => {
  const tab = document.querySelector('.tab.selected')
  const image = tab?.querySelector('img.favicon')
  return {
    src: image?.getAttribute('src') ?? null,
    // 真的解码出来了没有：`src` 有值但被 CSP 拦掉时，这里仍然是 0（2026-11-26 踩过）。
    decoded: image ? image.naturalWidth : 0,
    glyph: Boolean(tab?.querySelector('.glyph.page')),
    width: image ? Math.round(image.getBoundingClientRect().width) : 0,
    height: image ? Math.round(image.getBoundingClientRect().height) : 0
  }
})

/** 收藏夹横条上各项的图标现状。 */
const barIcons = (shell) => shell.evaluate(() => [...document.querySelectorAll('.bookmark-bar .bar-item')]
  .map((item) => {
    const image = item.querySelector('img.favicon')
    return {
      label: item.querySelector('.bar-label')?.textContent?.trim() ?? '',
      src: image?.getAttribute('src') ?? null,
      decoded: image ? image.naturalWidth : 0,
      glyph: Boolean(item.querySelector('.shell-icon'))
    }
  }))

/** 起一个只服务给定路由的服务器（图标要二进制，`startFixtureServer` 只发 HTML）。 */
async function startServer(routes) {
  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0]
    const route = routes[path]
    if (!route) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('not found')
      return
    }
    response.writeHead(200, { 'Content-Type': route.type, 'Content-Length': route.body.length })
    response.end(route.body)
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done))
  }
}

const png = { type: 'image/png', body: ICON_PNG }
const pageWithIcon = (title, icon) => ({
  type: 'text/html; charset=utf-8',
  body: Buffer.from(`<!doctype html><meta charset="utf-8"><title>${title}</title>`
    + (icon ? `<link rel="icon" type="image/png" href="${icon}">` : '')
    + `<h1>${title}</h1>`)
})

test('站点图标：有 favicon 的页面在标签上画出图标，没有的退回通用页形', { timeout: 150_000 }, async () => {
  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0]
    if (path === '/icon.png') {
      response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': ICON_PNG.length })
      response.end(ICON_PNG)
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    if (path === '/with-icon') {
      response.end(html('有图标的页面', '/icon.png'))
      return
    }
    response.end(html('没有图标的页面'))
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${server.address().port}`
  const { app, shell, close } = await launchApp()
  try {
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${origin}/with-icon`)
    await address.press('Enter')
    await shell.getByRole('button', { name: '有图标的页面', exact: true }).waitFor({ timeout: 30_000 })

    const icon = await waitFor(async () => {
      const facts = await tabIcon(shell)
      return facts.src ? facts : null
    }, { message: '标签上没有画出站点图标' })
    assert.match(icon.src, /^data:image\/png;base64,/, `图标应内联成 data URL：${icon.src.slice(0, 40)}`)
    // 关键一条：`src` 有值不等于画出来了——外壳的 CSP 若不放行 `data:`，浏览器只会画一张破图。
    assert.equal(icon.decoded, 1, '图标没有被解码（多半是 CSP 拦掉了 data:，见 index.html）')
    assert.equal(icon.glyph, false, '有图标时不该再画通用页形')
    // Chromium 的标签图标是 16×16。
    assert.deepEqual([icon.width, icon.height], [16, 16])

    // 没有图标的页面：退回通用页形，不画占位方块（也不能留着上一个站点的图标）。
    await address.fill(`${origin}/no-icon`)
    await address.press('Enter')
    await shell.getByRole('button', { name: '没有图标的页面', exact: true }).waitFor({ timeout: 30_000 })
    // 图标是异步来的：等一个加载周期，确认它**没有**被错画成上一个站点的图标。
    const plain = await waitFor(async () => {
      const facts = await tabIcon(shell)
      return facts.src === null ? facts : null
    }, { message: '没有图标的页面仍然显示着上一个站点的图标' })
    assert.equal(plain.glyph, true, '没有图标时应用通用页形')

    // 同一个站点再回来：图标是缓存的（这里只断言不会因为缓存而丢），并且尺寸仍然对。
    await address.fill(`${origin}/with-icon?again=1`)
    await address.press('Enter')
    const again = await waitFor(async () => {
      const facts = await tabIcon(shell)
      return facts.src ? facts : null
    }, { message: '回到有图标的站点后图标没有恢复' })
    assert.deepEqual([again.width, again.height], [16, 16])
  } finally {
    await close()
    await new Promise((done) => server.close(done))
  }
})

test('站点图标：加载中显示转圈（throbber），加载完换回图标', { timeout: 150_000 }, async () => {
  // 慢服务器：把"加载中"那一段拉长到能稳定采到样（图标本身立刻回，只有文档延迟）。
  const server = createServer((request, response) => {
    if ((request.url ?? '').startsWith('/icon.png')) {
      response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': ICON_PNG.length })
      response.end(ICON_PNG)
      return
    }
    setTimeout(() => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><meta charset="utf-8"><title>慢站点</title>`
        + '<link rel="icon" type="image/png" href="/icon.png"><h1>慢站点</h1>')
    }, 900)
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${server.address().port}`
  const { app, shell, close } = await launchApp()
  try {
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${origin}/slow`)
    await address.press('Enter')

    // 加载中：标签上是转圈，不是图标也不是通用页形（Chromium 的 `TabIcon`：三者互斥）。
    const loading = await waitFor(async () => {
      const facts = await shell.evaluate(() => {
        const tab = document.querySelector('.tab.selected')
        const arc = tab?.querySelector('.throbber .throbber-arc')
        return arc
          ? {
            arc: true,
            dash: getComputedStyle(arc).strokeDasharray,
            animation: getComputedStyle(arc).animationName,
            icon: Boolean(tab.querySelector('img.favicon'))
          }
          : null
      })
      return facts ?? null
    }, { message: '加载中没有画出转圈（throbber）' })
    assert.equal(loading.icon, false, '加载中不该同时画站点图标')
    assert.match(loading.animation, /throbber-rotate/, '转圈要真的在跑（旋转 + 伸缩两条动画）')

    // 加载完：转圈消失、图标出现。
    await shell.getByRole('button', { name: '慢站点', exact: true }).waitFor({ timeout: 30_000 })
    const loaded = await waitFor(async () => {
      const facts = await tabIcon(shell)
      return facts.decoded === 1 ? facts : null
    }, { message: '加载完成后没有换回站点图标' })
    assert.equal(loaded.glyph, false)
    assert.equal(await shell.evaluate(() => Boolean(document.querySelector('.tab.selected .throbber'))), false,
      '加载完成后不该留着转圈')
  } finally {
    await close()
    await new Promise((done) => server.close(done))
  }
})

test('站点图标：收藏夹横条按书签地址补图标（含从没打开过的站点）', { timeout: 150_000 }, async () => {
  // 站点 A：页面自己声明了图标（走 `page-favicon-updated`）。
  const siteA = await startServer({
    '/page': pageWithIcon('有图标的站点', '/icon.png'),
    '/icon.png': png
  })
  // 站点 B：页面**没有**图标声明，只在根上有 `/favicon.ico`——书签的兜底路径要能拿到它。
  const siteB = await startServer({
    '/never': pageWithIcon('从没打开过的站点'),
    '/favicon.ico': png
  })
  const { app, shell, close } = await launchApp()
  try {
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${siteA.origin}/page`)
    await address.press('Enter')
    await shell.getByRole('button', { name: '有图标的站点', exact: true }).waitFor({ timeout: 30_000 })
    await shell.locator('.address-bar .bookmark-star').click()
    const starred = await waitFor(async () => {
      const state = await shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' }).then((result) => result.state))
      return state.bookmarks.find((node) => node.kind === 'url') ?? null
    }, { message: '收藏没有落库' })

    // 回新标签页（默认档下横条只在 NTP 上），横条里的那条必须有图标。
    await shell.evaluate(() => {
      document.querySelector('.address-bar input')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    await shell.evaluate(() => window.baoBrowser.run({ type: 'add' }))
    const barItem = await waitFor(async () => {
      const items = await barIcons(shell)
      return items.length > 0 ? items[0] : null
    }, { message: '收藏夹横条上没有这条收藏' })
    assert.match(barItem.src ?? '', /^data:image\/png;base64,/, '横条条目应画出站点图标')
    assert.equal(barItem.decoded, 1, '横条图标没有被解码（CSP 或数据不对）')
    assert.equal(barItem.glyph, false, '有图标时不该再画通用页形')

    // 把这条收藏改到一个**从没打开过**的站点：图标只能由主进程按 `/favicon.ico` 去抓。
    const moved = await shell.evaluate((target) => window.baoBrowser.run({
      type: 'update-bookmark', id: target.id, url: `${target.origin}/never`
    }), { id: starred.id, origin: siteB.origin })
    assert.equal(moved.ok, true, `改地址失败：${JSON.stringify(moved)}`)
    const fallback = await waitFor(async () => {
      const items = await barIcons(shell)
      const item = items[0]
      return item?.decoded === 1 ? item : null
    }, { message: '从没打开过的站点没有按 /favicon.ico 补上图标' })
    assert.match(fallback.src ?? '', /^data:image\/png;base64,/)
  } finally {
    await close()
    await siteA.close()
    await siteB.close()
  }
})
