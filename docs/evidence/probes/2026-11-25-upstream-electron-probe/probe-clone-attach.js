// clone() 可用性验证：克隆出来的 WebContents 能不能显示、状态是否完整、能否再挂视图。
const { app, BrowserWindow, WebContentsView, webContents } = require('electron')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  const out = {}
  const win = new BrowserWindow({ show: false, width: 600, height: 400 })
  try { await win.loadURL('about:blank') } catch {}
  const view = new WebContentsView({ webPreferences: { sandbox: true } })
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 600, height: 400 })
  const wc = view.webContents
  await wc.loadURL('data:text/html,<title>one</title><body>one</body>')
  await sleep(300)
  await wc.loadURL('data:text/html,<title>two</title><body>two</body>')
  await sleep(300)
  out.source = { id: wc.id, pid: wc.getOSProcessId(), url: wc.getURL(), entries: wc.navigationHistory.getAllEntries().length }

  const clone = wc.clone()
  await sleep(800)
  out.clone = {
    isWebContents: !!clone && typeof clone.getURL === 'function',
    id: clone.id, pid: clone.getOSProcessId(), type: clone.getType?.(),
    url: clone.getURL(), entries: clone.navigationHistory.getAllEntries().length,
    sameProcess: clone.getOSProcessId() === wc.getOSProcessId(),
    inAllWebContents: webContents.getAllWebContents().some((c) => c.id === clone.id)
  }

  // A. 能否用 webPreferences.webContents 把克隆体塞进一个新视图
  try {
    const v2 = new WebContentsView({ webPreferences: { webContents: clone } })
    out.attachViaViewCtor = { accepted: true, sameContents: v2.webContents === clone, viewContentsId: v2.webContents.id }
  } catch (e) { out.attachViaViewCtor = { accepted: false, error: e.message } }

  // B. 能否用 BrowserWindow 的 webPreferences.webContents
  try {
    const w2 = new BrowserWindow({ show: false, webPreferences: { webContents: clone } })
    out.attachViaWindowCtor = { accepted: true, sameContents: w2.webContents === clone, winContentsId: w2.webContents.id }
    w2.destroy()
  } catch (e) { out.attachViaWindowCtor = { accepted: false, error: e.message } }

  // C. 克隆体自己能做什么
  out.cloneUsable = {
    canExecute: await clone.executeJavaScript('[innerWidth, innerHeight]').catch((e) => 'err:' + e.message),
    canGoBack: clone.navigationHistory.canGoBack(),
    canReload: typeof clone.reload === 'function'
  }

  // D. 资源占用对比
  const before = app.getAppMetrics().filter((m) => m.type === 'Tab' || m.type === 'Renderer').length
  clone.close()
  await sleep(600)
  out.rendererCount = { withClone: before, afterClose: app.getAppMetrics().filter((m) => m.type === 'Tab' || m.type === 'Renderer').length }

  console.log('RESULT ' + JSON.stringify(out, null, 0))
  app.exit(0)
}).catch((e) => { console.error('FAILED', e); app.exit(3) })
