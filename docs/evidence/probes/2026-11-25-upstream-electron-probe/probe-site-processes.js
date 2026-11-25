// 探针 2：排除 data: URL 的进程归属干扰，用显式「站点」回答两个问题：
// ① 每个 WebContentsView 是否真的独占一个渲染进程（同站 vs 跨站）
// ② webContents.clone() 是否复用源视图的渲染进程
const { app, BaseWindow, WebContentsView, protocol } = require('electron')

app.disableHardwareAcceleration()
protocol.registerSchemesAsPrivileged([
  { scheme: 'probe', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

const out = { versions: {}, sites: {}, metrics: {}, clone: {}, errors: [] }

function metrics() {
  const rows = app.getAppMetrics()
  const r = rows.filter((x) => x.type === 'Tab' || x.type === 'Renderer')
    .map((x) => ({ pid: x.pid, wsMB: x.memory ? Math.round(x.memory.workingSetSize / 1024) : null }))
  return { rendererCount: r.length, renderers: r, totalMB: Math.round(rows.reduce((n, x) => n + (x.memory ? x.memory.workingSetSize : 0), 0) / 1024) }
}

const page = (name) => `<!doctype html><title>${name}</title><body>${name}</body>`

app.whenReady().then(async () => {
  out.versions = { electron: process.versions.electron, chrome: process.versions.chrome }

  protocol.handle('probe', (request) => {
    const url = new URL(request.url)
    return new Response(page(url.host + url.pathname), { headers: { 'content-type': 'text/html' } })
  })

  const win = new BaseWindow({ show: false, width: 900, height: 700 })
  const views = {}
  function add(tag, url) {
    const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } })
    win.contentView.addChildView(view)
    view.setBounds({ x: 0, y: 0, width: 900, height: 700 })
    views[tag] = { view, url }
    return view
  }

  const targets = [
    ['a1', 'probe://a.local/one'],
    ['a2', 'probe://a.local/two'],   // 同站
    ['b1', 'probe://b.local/one'],   // 跨站
    ['c1', 'probe://c.local/one']    // 跨站
  ]
  for (const [tag, url] of targets) add(tag, url)

  out.spareBeforeLoad = metrics()

  await Promise.all(Object.values(views).map((v) => v.view.webContents.loadURL(v.url)))
  await new Promise((r) => setTimeout(r, 1500))

  out.sites = Object.fromEntries(Object.entries(views).map(([tag, v]) => [tag, {
    url: v.url,
    pid: v.view.webContents.getOSProcessId()
  }]))
  out.metrics.afterLoad = metrics()

  // clone 语义：同站视图 a1 → clone，看 pid 与历史
  try {
    const wc = views.a1.view.webContents
    await wc.loadURL('probe://a.local/third')
    await new Promise((r) => setTimeout(r, 500))
    const sourcePid = wc.getOSProcessId()
    const entries = wc.navigationHistory.getAllEntries().length
    const cloned = wc.clone()
    await new Promise((r) => setTimeout(r, 1000))
    out.clone = {
      sourcePid,
      sourceEntries: entries,
      sourceUrl: wc.getURL(),
      targetPid: cloned.getOSProcessId(),
      targetEntries: cloned.navigationHistory.getAllEntries().length,
      targetUrl: cloned.getURL(),
      sharedProcess: sourcePid === cloned.getOSProcessId()
    }
    cloned.close()
    await new Promise((r) => setTimeout(r, 600))
  } catch (e) {
    out.errors.push('clone: ' + e.message)
  }

  out.metrics.afterCloneClosed = metrics()

  // 关掉 a2（同站第二个视图）后，a1 的 pid 是否还活着（说明是否共用进程）
  views.a2.view.webContents.close()
  await new Promise((r) => setTimeout(r, 800))
  out.metrics.afterCloseSameSiteSibling = metrics()
  out.sites.a1AliveAfterSiblingClosed = {
    destroyed: views.a1.view.webContents.isDestroyed(),
    pid: views.a1.view.webContents.isDestroyed() ? null : views.a1.view.webContents.getOSProcessId()
  }

  console.log('PROBE_JSON_START')
  console.log(JSON.stringify(out, null, 2))
  console.log('PROBE_JSON_END')
  app.exit(0)
}).catch((e) => { console.error('PROBE_FAILED', e); app.exit(1) })
