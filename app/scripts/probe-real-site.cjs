/* 一次性探针：真实站点加载（不属于产品代码）。用法：node scripts/probe-real-site.cjs <url> [ruffle|ppapi] */
const { launchApp } = require('../tests/smoke/helpers.cjs')

const url = process.argv[2]
const engine = process.argv[3] ?? 'ruffle'

;(async () => {
  const { app, shell, close } = await launchApp()
  try {
    if (engine === 'ruffle') {
      await shell.evaluate(() => window.baoBrowser.run({ type: 'set-setting', key: 'engine.default', value: 'ruffle' }))
    }
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(url)
    await address.press('Enter')
    await new Promise((done) => setTimeout(done, 18_000))

    const facts = await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('index.html'))
      const view = win.contentView.children.find((c) => /^https?:/.test(c.webContents?.getURL() ?? ''))
      if (!view) return { page: false }
      return view.webContents.executeJavaScript(`(() => {
        const embeds = [...document.querySelectorAll('embed, object')]
        const swf = embeds.filter((el) => /flash|swf/i.test((el.getAttribute('type') ?? '') + (el.getAttribute('data') ?? '') + (el.getAttribute('src') ?? '')))
        return {
          page: true,
          title: document.title,
          url: location.href,
          textLength: document.body?.innerText?.length ?? 0,
          embedCount: embeds.length,
          swfCount: swf.length,
          ruffle: document.querySelectorAll('ruffle-embed, ruffle-object, ruffle-player').length,
          ruffleCanvas: Boolean(document.querySelector('ruffle-embed, ruffle-player')?.shadowRoot?.querySelector('canvas')),
          plugins: [...(navigator.plugins ?? [])].map((p) => p.name).filter((n) => /flash/i.test(n))
        }
      })()`)
    })
    const processes = await app.evaluate(({ app: electronApp }) =>
      electronApp.getAppMetrics().map((m) => m.type).filter((t) => t !== 'Tab' && t !== 'Browser' && t !== 'GPU'))
    console.log(JSON.stringify({ url, engine, facts, extraProcesses: processes }, null, 1))
  } finally {
    await close()
  }
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
