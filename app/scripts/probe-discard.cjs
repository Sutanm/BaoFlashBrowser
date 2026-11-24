/* 一次性探针：验证「后台标签丢弃」的收益与代价。
   丢弃 = 销毁该标签的 WebContentsView（内存立刻释放），切回时重建 + 重新加载。
   本探针用「关闭标签 → 记录 URL → 稍后重开同一 URL」近似，测四件事：
   1) 每个后台标签销毁能省多少内存；2) 重建 + 首次可见要多久；
   3) 销毁会丢什么状态（历史/滚动）；4) 丢弃后的进程是否会立即回收。
*/
const { launchApp, startFixtureServer } = require('../tests/smoke/helpers.cjs')
const wait = (ms) => new Promise((done) => setTimeout(done, ms))

const totals = (app) => app.evaluate(({ app: e }) => {
  const metrics = e.getAppMetrics()
  return {
    processes: metrics.length,
    tabs: metrics.filter((m) => m.type === 'Tab').length,
    totalMB: Math.round(metrics.reduce((sum, m) => sum + (m.memory?.workingSetSize ?? 0), 0) / 1024)
  }
})
const state = (shell) => shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' })).then((r) => r.state)

;(async () => {
  const server = await startFixtureServer({
    '/a': '<!doctype html><meta charset="utf-8"><title>A</title>' + '<p>a</p>'.repeat(2000),
    '/b': '<!doctype html><meta charset="utf-8"><title>B</title>' + '<p>b</p>'.repeat(2000),
    '/c': '<!doctype html><meta charset="utf-8"><title>C</title>' + '<p>c</p>'.repeat(2000),
    '/d': '<!doctype html><meta charset="utf-8"><title>D</title>' + '<p>d</p>'.repeat(2000)
  })
  const { app, shell, close } = await launchApp()
  try {
    await wait(1500)
    console.log('起始:', JSON.stringify(await totals(app)))

    // 打开 4 个标签（每个都导航到不同页面）
    for (const path of ['/a', '/b', '/c', '/d']) {
      await shell.evaluate(() => window.baoBrowser.run({ type: 'add' }))
      await shell.evaluate((url) => window.baoBrowser.run({ type: 'navigate', address: url }), `${server.baseUrl}${path}`)
      await wait(1200)
    }
    console.log('4 个标签后:', JSON.stringify(await totals(app)))

    // 记下 B/C/D 的地址，然后关闭它们（= 丢弃）
    const before = await state(shell)
    const victims = before.tabs.filter((tab) => ['B', 'C', 'D'].includes(tab.title))
    console.log('待丢弃:', victims.map((tab) => `${tab.title}(${tab.id})`).join(', '))
    for (const tab of victims) {
      await shell.evaluate((id) => window.baoBrowser.run({ type: 'close', id }), tab.id)
      await wait(700)
    }
    console.log('丢弃 3 个后:', JSON.stringify(await totals(app)))

    // 重建其中一个，计时
    const t0 = Date.now()
    await shell.evaluate(() => window.baoBrowser.run({ type: 'add' }))
    await shell.evaluate((url) => window.baoBrowser.run({ type: 'navigate', address: url }), `${server.baseUrl}/b`)
    let ready
    while (Date.now() - t0 < 15000) {
      const s = await state(shell)
      const active = s.tabs.find((tab) => tab.id === s.activeId)
      if (active && active.title === 'B' && active.loading === false) { ready = Date.now() - t0; break }
      await wait(20)
    }
    console.log(`重建 1 个标签：${ready} ms，`, JSON.stringify(await totals(app)))
  } finally {
    await close()
    await server.close()
  }
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
