const { launchApp, startFixtureServer } = require('../tests/smoke/helpers.cjs')
const wait = (ms) => new Promise((d) => setTimeout(d, ms))
const totals = (app) => app.evaluate(({ app: e }) => {
  const m = e.getAppMetrics()
  return { processes: m.length, tabs: m.filter((x) => x.type === 'Tab').length,
    totalMB: Math.round(m.reduce((s, x) => s + (x.memory?.workingSetSize ?? 0), 0) / 1024) }
})
const state = (shell) => shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' })).then((r) => r.state)
;(async () => {
  process.env.BAO_DISCARD_TTL_MS = '8000'
  process.env.BAO_DISCARD_SWEEP_MS = '300'
  const routes = {}
  for (const name of ['A', 'B', 'C', 'D', 'E', 'F']) {
    routes[`/${name}`] = `<!doctype html><meta charset="utf-8"><title>${name}</title>` + `<p>${name}</p>`.repeat(1500)
  }
  const server = await startFixtureServer(routes)
  const { app, shell, close } = await launchApp()
  try {
    await wait(1200)
    console.log('起始:', JSON.stringify(await totals(app)))
    for (const name of ['A', 'B', 'C', 'D', 'E', 'F']) {
      await shell.evaluate(() => window.baoBrowser.run({ type: 'add' }))
      await shell.evaluate((url) => window.baoBrowser.run({ type: 'navigate', address: url }), `${server.baseUrl}/${name}`)
      await wait(900)
    }
    console.log('6 个标签:', JSON.stringify(await totals(app)))
    let discarded = []
    const deadline = Date.now() + 25000
    while (Date.now() < deadline) {
      discarded = (await state(shell)).tabs.filter((t) => t.discarded)
      if (discarded.length >= 5) break
      await wait(200)
    }
    console.log(`休眠 ${discarded.length} 个后:`, JSON.stringify(await totals(app)))
    const victim = discarded[0]
    const t0 = Date.now()
    await shell.evaluate((id) => window.baoBrowser.run({ type: 'select', id }), victim.id)
    let ms
    while (Date.now() - t0 < 15000) {
      const tab = (await state(shell)).tabs.find((t) => t.id === victim.id)
      if (tab && !tab.discarded && !tab.loading && tab.title === victim.title) { ms = Date.now() - t0; break }
      await wait(25)
    }
    console.log(`唤醒 ${victim.title}: ${ms} ms，`, JSON.stringify(await totals(app)))
  } finally { await close(); await server.close(); delete process.env.BAO_DISCARD_TTL_MS; delete process.env.BAO_DISCARD_SWEEP_MS }
})().catch((e) => { console.error(e); process.exit(1) })