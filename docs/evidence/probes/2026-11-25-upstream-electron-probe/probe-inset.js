// inset 归属调查：几何组的 4 条补丁分别针对哪类窗口，以及全屏 inset 是否真的存在。
const { app, BrowserWindow, screen } = require('electron')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})   // 防止中途所有窗口销毁导致进程退出

async function safeLoad(w) {
  try { await w.loadURL('about:blank') } catch { /* 载入失败不影响几何测量 */ }
  await sleep(200)
}

function snap(w) {
  const b = w.getBounds(); const cb = w.getContentBounds()
  return {
    size: w.getSize(), contentSize: w.getContentSize(),
    insetW: b.width - cb.width, insetH: b.height - cb.height,
    offX: cb.x - b.x, offY: cb.y - b.y
  }
}

app.whenReady().then(async () => {
  const d = screen.getPrimaryDisplay()
  const out = { scaleFactor: d.scaleFactor, display: { bounds: [d.bounds.width, d.bounds.height], workArea: [d.workAreaSize.width, d.workAreaSize.height] } }

  for (const frame of [true, false]) {
    const w = new BrowserWindow({ show: false, frame, width: 400, height: 300 })
    await safeLoad(w)
    out[`frame:${frame}/plain`] = snap(w)
    w.setMinimumSize(400, 300); await sleep(150)
    out[`frame:${frame}/afterMinSize`] = snap(w)
    w.setBounds(w.getBounds()); await sleep(150)
    out[`frame:${frame}/afterReapply`] = snap(w)
    w.setResizable(false); await sleep(150)
    out[`frame:${frame}/afterDisableResize`] = snap(w)
    w.destroy()
  }

  // 最大化（#51252 / #51287 的领域）
  const wMax = new BrowserWindow({ show: true, frame: false, width: 400, height: 300 })
  await safeLoad(wMax)
  out['frameless/beforeMaximize'] = snap(wMax)
  wMax.maximize(); await sleep(600)
  out['frameless/maximized'] = { ...snap(wMax), workArea: [screen.getPrimaryDisplay().workAreaSize.width, screen.getPrimaryDisplay().workAreaSize.height] }
  wMax.unmaximize(); await sleep(300)

  // 全屏（#51287 的症状：全屏仍带 inset → 白边/缝）
  wMax.setFullScreen(true); await sleep(900)
  out['frameless/fullscreen'] = { ...snap(wMax), screen: [d.bounds.width, d.bounds.height] }
  wMax.setFullScreen(false); await sleep(400)
  wMax.destroy()

  console.log('RESULT ' + JSON.stringify(out))
  app.exit(0)
}).catch((e) => { console.error('FAILED', e); app.exit(3) })

