// 无边框窗口的边缘缩放带：沿四边/四角取样 WM_NCHITTEST，看 E39 在 150% DPI 下的行为。
// 正确表现：角 → HTTOPLEFT(13)/HTTOPRIGHT(14)/HTBOTTOMLEFT(16)/HTBOTTOMRIGHT(17)
//          边 → HTLEFT(10)/HTTOP(12)/HTRIGHT(11)/HTBOTTOM(15)
//          内部 → HTCLIENT(1)
const { app, BrowserWindow } = require('electron')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})

app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: true, frame: false, resizable: true, width: 400, height: 300, x: 300, y: 200 })
  try { await w.loadURL('about:blank') } catch {}
  await sleep(800)
  const b = w.getBounds()
  const hwnd = w.getNativeWindowHandle().readBigUInt64LE(0).toString()
  console.log(`PROBE_HWND ${hwnd} x=${b.x} y=${b.y} w=${b.width} h=${b.height}`)
  await sleep(25000)
  app.exit(0)
}).catch((e) => { console.error('FAILED', e); app.exit(3) })
