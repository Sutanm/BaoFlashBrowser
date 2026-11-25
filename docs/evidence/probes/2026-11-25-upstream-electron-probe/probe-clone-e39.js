const { app, BrowserWindow, WebContentsView } = require('electron')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
const log = (...a) => console.log('[clone]', ...a)
setTimeout(() => { log('WATCHDOG'); app.exit(9) }, 40000)
const js = (wc, code) => Promise.race([
  wc.executeJavaScript(code).then((v) => JSON.stringify(v)).catch((e) => 'err:' + e.message),
  sleep(4000).then(() => 'timeout')
])
const renderers = () => app.getAppMetrics().filter((m) => m.type === 'Tab' || m.type === 'Renderer').map((m) => m.pid)

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 600, height: 400 })
  try { await win.loadURL('about:blank') } catch {}
  const view = new WebContentsView({ webPreferences: { sandbox: true } })
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 600, height: 400 })
  const wc = view.webContents
  await wc.loadURL('data:text/html,<title>one</title><body>one</body>'); await sleep(200)
  await wc.loadURL('data:text/html,<title>two</title><body>two</body>'); await sleep(300)
  log('source id=' + wc.id + ' pid=' + wc.getOSProcessId() + ' entries=' + wc.navigationHistory.getAllEntries().length + ' renderers=' + renderers())

  const clone = wc.clone()
  const v2 = new WebContentsView({ webContents: clone })
  win.contentView.addChildView(v2)
  v2.setBounds({ x: 0, y: 0, width: 300, height: 200 })
  await sleep(500)
  log('adopted id=' + v2.webContents.id + ' pid=' + clone.getOSProcessId() + ' renderers=' + renderers())

  log('js before reload -> ' + await js(clone, '[innerWidth, innerHeight]'))

  log('--- reload() ---')
  clone.reload()
  await sleep(2500)
  log('after reload url=' + clone.getURL() + ' pid=' + clone.getOSProcessId() + ' entries=' + clone.navigationHistory.getAllEntries().length)
  log('js after reload -> ' + await js(clone, '[document.title, innerWidth, innerHeight]'))
  log('canGoBack=' + clone.navigationHistory.canGoBack())
  log('renderers=' + renderers())

  log('--- 新视图对照 ---')
  const v3 = new WebContentsView({ webPreferences: { sandbox: true } })
  win.contentView.addChildView(v3)
  await v3.webContents.loadURL('data:text/html,<title>fresh</title><body>fresh</body>')
  await sleep(800)
  log('fresh id=' + v3.webContents.id + ' pid=' + v3.webContents.getOSProcessId() + ' renderers=' + renderers())
  log('DONE')
  app.exit(0)
}).catch((e) => { console.error('FAILED', e); app.exit(3) })
