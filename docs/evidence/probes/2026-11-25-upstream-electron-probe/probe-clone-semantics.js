// 探针 3：clone 到底是「共享渲染进程」还是「碰巧同 pid」；共享时省多少内存、跨站后是否分家。
const { app, BaseWindow, WebContentsView, protocol } = require('electron')

app.disableHardwareAcceleration()
protocol.registerSchemesAsPrivileged([
  { scheme: 'probe', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

const out = {}

function snap(label) {
  const rows = app.getAppMetrics()
  const r = rows.filter((x) => x.type === 'Tab' || x.type === 'Renderer')
    .map((x) => ({ pid: x.pid, wsMB: Math.round(x.memory.workingSetSize / 1024) }))
  return { label, rendererCount: r.length, renderers: r,
    totalMB: Math.round(rows.reduce((n, x) => n + x.memory.workingSetSize, 0) / 1024) }
}

app.whenReady().then(async () => {
  protocol.handle('probe', (req) => {
    const u = new URL(req.url)
    // 每个页面都塞点 DOM，避免空文档被优化掉
    const body = Array.from({ length: 2000 }, (_, i) => `<p>${u.host} ${i}</p>`).join('')
    return new Response(`<!doctype html><title>${u.host}${u.pathname}</title><body>${body}</body>`,
      { headers: { 'content-type': 'text/html' } })
  })

  const win = new BaseWindow({ show: false, width: 900, height: 700 })
  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } })
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 900, height: 700 })
  const wc = view.webContents

  await wc.loadURL('probe://a.local/one')
  await wc.loadURL('probe://a.local/two')
  await new Promise((r) => setTimeout(r, 1200))
  out.baseline = snap('baseline')
  out.sourcePid = wc.getOSProcessId()
  out.sourceEntries = wc.navigationHistory.getAllEntries().length

  const cloned = wc.clone()
  await new Promise((r) => setTimeout(r, 1500))
  out.afterClone = snap('afterClone')
  out.clonePid = cloned.getOSProcessId()
  out.cloneEntries = cloned.navigationHistory.getAllEntries().length
  out.cloneUrl = cloned.getURL()
  out.samePid = out.clonePid === out.sourcePid
  out.cloneAlive = !cloned.isDestroyed()

  // 克隆体跨站导航：是否分家
  await cloned.loadURL('probe://z.local/away')
  await new Promise((r) => setTimeout(r, 1200))
  out.afterCloneCrossSite = snap('afterCloneCrossSite')
  out.clonePidAfterCrossSite = cloned.getOSProcessId()
  out.sourcePidStill = wc.getOSProcessId()

  // 关掉源：克隆体是否还活着（共享进程时一个 WebContents 销毁不应带走另一个，但要确认）
  wc.close()
  await new Promise((r) => setTimeout(r, 1200))
  out.afterSourceClosed = snap('afterSourceClosed')
  out.cloneAliveAfterSourceClosed = !cloned.isDestroyed()

  console.log('PROBE_JSON_START')
  console.log(JSON.stringify(out, null, 2))
  console.log('PROBE_JSON_END')
  app.exit(0)
}).catch((e) => { console.error('PROBE_FAILED', e); app.exit(1) })
