// 批次 1a 的改前/改后探针。每个场景一个进程，由 run-probes.ps1 驱动并记录退出码。
// 用法：electron <dir> <scenario>
const { app, BrowserWindow, WebContentsView } = require('electron')

const scenario = process.argv[process.argv.length - 1]
const log = (...a) => console.log('[probe]', ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.disableHardwareAcceleration()
try { require('node:v8').setFlagsFromString('--stress-incremental-marking') } catch (e) { console.log('[probe] v8 flag failed: ' + e.message) }

// #51900 / #53924：在 render-process-gone 里同步导航/重载
async function crashReload(mode) {
  const win = new BrowserWindow({ show: false, width: 400, height: 300 })
  await win.loadURL('data:text/html,<title>a</title><body>a</body>')
  const wc = win.webContents
  let done = false
  wc.once('render-process-gone', () => {
    log('render-process-gone received; navigating synchronously (' + mode + ')')
    try {
      if (mode === 'reload') wc.reload()
      else void wc.loadURL('data:text/html,<title>b</title><body>b</body>').catch(() => {})
    } catch (e) {
      log('sync navigate threw: ' + e.message)
    }
  })
  wc.on('did-finish-load', () => { if (done) log('did-finish-load after recovery') })
  await sleep(300)
  log('crashing renderer')
  wc.forcefullyCrashRenderer()
  await sleep(4000)
  log('survived=True url=' + (wc.isDestroyed() ? '<destroyed>' : wc.getURL()))
  done = true
  console.log('RESULT survived')
  app.exit(0)
}

// #51562 / #51252：无边框窗口在约束/可调态变化后是否缩水
async function resizableBounds() {
  // keeper：循环里会销毁窗口，没有它 window-all-closed 会把进程提前带走
  const keeper = new BrowserWindow({ show: false, width: 200, height: 150 })
  await keeper.loadURL('data:text/html,<body>keeper</body>')
  const out = {}
  for (const frame of [true, false]) {
    const w = new BrowserWindow({ show: false, width: 400, height: 300, frame })
    await sleep(150)
    out[`frame:${frame}`] = { initial: w.getSize() }
    w.setResizable(false)
    out[`frame:${frame}`].afterDisable = w.getSize()
    const bounds = w.getBounds()
    w.setBounds(bounds)
    await sleep(150)
    out[`frame:${frame}`].afterReapply = w.getSize()
    w.setResizable(true)
    await sleep(150)
    out[`frame:${frame}`].afterEnable = w.getSize()
    w.destroy()
  }
  console.log('RESULT ' + JSON.stringify(out))
  keeper.destroy()
  app.exit(0)
}

// #50688：退出时 Wrappable 在 DisallowJavascriptExecutionScope 里被析构
function wrappableGc() {
  try {
    require('node:v8').setFlagsFromString('--stress-incremental-marking')
  } catch (e) {
    log('setFlagsFromString failed: ' + e.message)
  }
  app.whenReady().then(() => {
    for (let i = 0; i < 20; i++) {
      try { new WebContentsView() } catch (e) { log('ctor threw: ' + e.message) }
    }
    if (typeof global.gc === 'function') global.gc()
    log('leaked 20 WebContentsView; quitting')
    app.quit()
  })
}

app.whenReady().then(() => {
  log('scenario=' + scenario)
  if (scenario === 'crash-reload') return void crashReload('reload')
  if (scenario === 'crash-navigate') return void crashReload('navigate')
  if (scenario === 'resizable-bounds') return void resizableBounds()
  if (scenario === 'wrappable-gc') return wrappableGc()
  console.log('RESULT unknown-scenario')
  app.exit(2)
}).catch((e) => { console.error('PROBE_FAILED', e); app.exit(3) })

