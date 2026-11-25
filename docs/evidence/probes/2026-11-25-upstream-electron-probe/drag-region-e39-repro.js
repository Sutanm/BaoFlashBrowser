// 四态对照：窗口自身无拖动区，唯一拖动区来自子 WebContentsView。
// 目的：证明「隐藏」这个状态就是唯一丢失的判别条件（上游修复即 if (!visible) return HTNOWHERE）。
const { app, BrowserWindow, WebContentsView } = require('electron')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 600, height: 400, frame: false, show: true, x: 240, y: 180,
    webPreferences: { sandbox: true, contextIsolation: true }
  })
  await win.loadURL('data:text/html,<body style="margin:0;background:%23eef">shell</body>')
  const b = win.getBounds()
  console.log(`PROBE_HWND ${win.getNativeWindowHandle().readBigUInt64LE(0)} x=${b.x} y=${b.y}`)
  await sleep(1200)
  console.log('STATE baseline-no-view')
  await sleep(1200)

  const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } })
  win.contentView.addChildView(view)
  view.setBounds({ x: 0, y: 0, width: 600, height: 400 })
  await view.webContents.loadURL(
    'data:text/html,<body style="margin:0">' +
    '<div style="position:fixed;inset:0;-webkit-app-region:drag;background:%23c33"></div></body>'
  )
  view.setVisible(false)
  await sleep(800)
  console.log('STATE hidden')
  await sleep(1200)

  view.setVisible(true)
  await sleep(800)
  console.log('STATE visible')
  await sleep(1200)

  view.setVisible(false)
  await sleep(800)
  console.log('STATE hidden-again')
  await sleep(1200)

  win.contentView.removeChildView(view)
  view.webContents.close()
  await sleep(800)
  console.log('STATE view-destroyed')
  await sleep(2000)
  app.exit(0)
}).catch((e) => { console.error('PROBE_FAILED', e); app.exit(1) })
