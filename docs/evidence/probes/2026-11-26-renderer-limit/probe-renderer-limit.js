// 探针：`--renderer-process-limit=N` 是否真的把多个 WebContents 合进一个渲染进程。
//
// 2026-11-26 审计 P2 的第二个零代码实验。B6 的收益估算依赖两件事：
//   ① 每标签是不是真的独占一个渲染进程（已由 probe-site-processes 证明：是）；
//   ② 有没有受支持的开关能合并它们、合并后是否还能正常渲染。
//
// 跑法（两次，对比进程数）：
//   .runtime\win-x64\electron.exe docs\evidence\probes\2026-11-26-renderer-limit\probe-renderer-limit.js
//   .runtime\win-x64\electron.exe ... --renderer-process-limit=2
const { app, BaseWindow, WebContentsView, protocol } = require('electron')

app.disableHardwareAcceleration()
protocol.registerSchemesAsPrivileged([
  { scheme: 'probe', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

const urls = [
  'probe://a.local/one',
  'probe://a.local/two',
  'probe://b.local/three',
  'probe://c.local/four'
]

app.whenReady().then(async () => {
  protocol.handle('probe', (request) => {
    const path = new URL(request.url).pathname
    return new Response(`<!doctype html><title>${path}</title><body>${path}</body>`, {
      headers: { 'content-type': 'text/html; charset=utf-8' }
    })
  })

  const window = new BaseWindow({ show: false, width: 900, height: 700 })
  const views = urls.map((url) => {
    const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } })
    window.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 0, width: 900, height: 700 })
    return { view, url }
  })

  for (const { view, url } of views) await view.webContents.loadURL(url)
  await new Promise((done) => setTimeout(done, 1200))

  const metrics = app.getAppMetrics()
  const renderers = metrics.filter((metric) => metric.type === 'Tab' || metric.type === 'Renderer')
  const result = {
    switch: process.argv.filter((arg) => arg.startsWith('--renderer-process-limit')).join(' ') || '(none)',
    rendererCount: renderers.length,
    pids: views.map(({ view, url }) => ({ url, pid: view.webContents.getOSProcessId() })),
    totalProcesses: metrics.length,
    // 合并后仍然要能读到内容：标题非空说明文档真的加载了。
    titles: views.map(({ view }) => view.webContents.getTitle())
  }
  console.log('PROBE ' + JSON.stringify(result, null, 2))
  app.exit(0)
}).catch((error) => {
  console.error('PROBE_FAILED', error)
  app.exit(1)
})
