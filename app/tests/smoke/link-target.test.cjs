const assert = require('node:assert/strict')
const { test } = require('node:test')
const { launchApp, startFixtureServer, waitFor } = require('./helpers.cjs')

/**
 * 新窗口请求的形态（2026-11-24 修订，见 `docs/reports/2026-11-24-popup-vs-newtab.md`）：
 *
 * - `<a target="_blank">` 点击、不带 features 的 `window.open(url)` → **新标签**（同一窗口）；
 * - 带 features 的 `window.open(url, name, 'width=…')` → **弹窗窗口**。
 *
 * 这条用例盯的就是用户点网页链接时"又弹出一个窗口"的回归。
 */

const snapshot = (shell) => shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' }))
  .then((result) => result.state)

/**
 * 在**指定 URL** 的页面里点一次元素。
 *
 * 为什么要按 URL 找视图：点击之后新标签会成为活动标签，`contentView` 里第一个非外壳视图
 * 已经不是起点页了。按 URL 定位与被测行为无关，也不会因为"谁在前台"而漂移。
 *
 * 双重保护：`executeJavaScript` 在主进程忙碌时会偶发 "Script failed to execute"（已知抖动），
 * 所以用 `waitFor` 重试；但**重试不能变成点两次**，因此先在元素上打标记，已点过的重试直接返回。
 */
async function clickOnce(app, urlSuffix, id) {
  const outcome = await waitFor(async () => {
    const value = await app.evaluate(async ({ webContents }, payload) => {
      const target = webContents.getAllWebContents()
        .find((contents) => (contents.getURL() ?? '').endsWith(payload.urlSuffix))
      if (!target) return 'no-view'
      return target.executeJavaScript(`(() => {
        const node = document.getElementById(${JSON.stringify(payload.id)})
        if (!node) return 'no-node'
        if (node.dataset.clicked === '1') return 'already'
        node.dataset.clicked = '1'
        node.click()
        return 'clicked'
      })()`, true)
    }, { urlSuffix, id }).catch(() => null)
    return value === 'clicked' || value === 'already' ? value : null
  }, { message: `点击 #${id} 失败` })
  return outcome
}

const windowCount = (app) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)

const pageWithLinks = (title) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
  <h1>${title}</h1>
  <a id="blank" href="/blank-target" target="_blank">新标签打开</a>
  <button id="plain" type="button">window.open 无 features</button>
  <button id="popup" type="button">window.open 有 features</button>
  <script>
    document.getElementById('plain').onclick = () => window.open('/plain-target', '_blank')
    document.getElementById('popup').onclick = () => window.open('/popup-target', '_blank', 'width=320,height=240')
  </script>`

test('点击 target=_blank 链接与无 features 的 window.open 都开新标签，只有带 features 才开弹窗', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({
    '/start': pageWithLinks('起点'),
    '/blank-target': '<!doctype html><meta charset="utf-8"><title>目标A</title><h1>a</h1>',
    '/plain-target': '<!doctype html><meta charset="utf-8"><title>目标B</title><h1>b</h1>',
    '/popup-target': '<!doctype html><meta charset="utf-8"><title>目标C</title><h1>c</h1>'
  })
  const { app, shell, close } = await launchApp()
  try {
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${server.baseUrl}/start`)
    await address.press('Enter')
    await waitFor(async () => {
      const state = await snapshot(shell)
      return state.tabs.some((tab) => tab.title === '起点' && !tab.loading) ? state : null
    }, { message: '起点页没有加载完' })

    const baseWindows = await windowCount(app)
    assert.equal((await snapshot(shell)).tabs.length, 1)

    // ① target=_blank 链接：新标签，窗口数不变。
    await clickOnce(app, '/start', 'blank')
    const afterLink = await waitFor(async () => {
      const state = await snapshot(shell)
      return state.tabs.some((tab) => tab.title === '目标A' && !tab.loading) ? state : null
    }, { message: '点击 target=_blank 没有开新标签' })
    assert.equal(afterLink.tabs.length, 2, '应多出一个标签')
    assert.equal(await windowCount(app), baseWindows, 'target=_blank 不应创建新窗口')
    assert.equal(afterLink.tabs.find((tab) => tab.id === afterLink.activeId).title, '目标A', '新标签应被选中')

    // ② 不带 features 的 window.open：同样是新标签。
    await clickOnce(app, '/start', 'plain')
    const afterPlain = await waitFor(async () => {
      const state = await snapshot(shell)
      return state.tabs.some((tab) => tab.title === '目标B' && !tab.loading) ? state : null
    }, { message: 'window.open 无 features 没有开新标签' })
    assert.equal(afterPlain.tabs.length, 3)
    assert.equal(await windowCount(app), baseWindows, '无 features 的 window.open 不应创建新窗口')

    // ③ 带 features 的 window.open：仍然是弹窗窗口（Flash 大厅→游戏那条通道）。
    const [popup] = await Promise.all([
      app.waitForEvent('window', { predicate: (page) => page.url().endsWith('/popup-target'), timeout: 30_000 }),
      clickOnce(app, '/start', 'popup')
    ])
    assert.equal(await windowCount(app), baseWindows + 1, '带 features 的 window.open 应开弹窗窗口')
    assert.equal((await snapshot(shell)).tabs.length, 3, '弹窗不应变成外壳里的标签')
    // 弹窗保留 window.opener（老站交接依赖它）。
    assert.equal(await popup.evaluate(() => Boolean(window.opener)), true, '弹窗丢失了 window.opener')
  } finally {
    await close()
    await server.close()
  }
})
