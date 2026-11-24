const { launchApp } = require('../tests/smoke/helpers.cjs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const wait = (ms) => new Promise((d) => setTimeout(d, ms))
;(async () => {
  const pages = [1, 2, 3, 4].map((i) => pathToFileURL(join(tmpdir(), 'bao-cmp-pages', `p${i}.html`)).href)
  const { app, shell, close } = await launchApp()
  const metrics = () => app.evaluate(({ app: e }) => e.getAppMetrics()
    .filter((m) => m.type === 'Tab')
    .map((m) => ({ pid: m.pid, mb: Math.round((m.memory?.workingSetSize ?? 0) / 1024) })))
  try {
    await wait(1500)
    console.log('起始（外壳标签）:', JSON.stringify(await metrics()))
    for (const url of pages) {
      await shell.evaluate(() => window.baoBrowser.run({ type: 'add' }))
      await shell.evaluate((address) => window.baoBrowser.run({ type: 'navigate', address }), url)
      await wait(900)
    }
    await wait(1500)
    const list = await metrics()
    console.log('4 个页面后:', JSON.stringify(list))
    const sum = list.reduce((s, m) => s + m.mb, 0)
    console.log(`渲染进程 ${list.length} 个，合计 ${sum} MB，平均 ${Math.round(sum / list.length)} MB`)
  } finally { await close() }
})()