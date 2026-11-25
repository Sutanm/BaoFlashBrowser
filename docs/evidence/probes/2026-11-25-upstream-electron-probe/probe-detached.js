// #53031 探针：视图不在 Widget 里时 setBounds 是否把尺寸传给页面。
// 四个场景对应上游 spec 的三条 + 我们叠加层的真实顺序（先 setBounds，后 addChildView）。
const { app, BrowserWindow, WebContentsView } = require('electron')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
app.disableHardwareAcceleration()

const size = (v) => v.webContents.executeJavaScript('[innerWidth, innerHeight]').catch((e) => 'err:' + e.message)

app.whenReady().then(async () => {
  const out = {}
  const keeper = new BrowserWindow({ show: false, width: 300, height: 200 })
  await keeper.loadURL('data:text/html,<body>keeper</body>')

  // A. 从未 attach：先 setBounds 再加载
  {
    const v = new WebContentsView({ webPreferences: { sandbox: true } })
    v.setBounds({ x: 0, y: 0, width: 400, height: 300 })
    await v.webContents.loadURL('data:text/html,<body>A</body>')
    await sleep(400)
    out.A_detached_setBounds_then_load = await size(v)
    v.webContents.close()
  }

  // B. attach 后加载，再 setBounds（预期两版都对）
  {
    const w = new BrowserWindow({ show: false, width: 800, height: 600 })
    await w.loadURL('data:text/html,<body>B</body>')
    const v = new WebContentsView({ webPreferences: { sandbox: true } })
    w.contentView.addChildView(v)
    v.setBounds({ x: 0, y: 0, width: 400, height: 300 })
    await v.webContents.loadURL('data:text/html,<body>B</body>')
    await sleep(400)
    const before = await size(v)
    v.setBounds({ x: 0, y: 0, width: 500, height: 400 })
    await sleep(400)
    out.B_attached_resize = { before, after: await size(v) }

    // C. 从窗口移除后再 setBounds
    w.contentView.removeChildView(v)
    v.setBounds({ x: 0, y: 0, width: 520, height: 420 })
    await sleep(500)
    out.C_detached_resize_after_remove = await size(v)
    v.webContents.close()
    w.destroy()
  }

  // D. 叠加层真实顺序：新建 → setBounds（此时未 attach）→ 稍后才 addChildView
  {
    const w = new BrowserWindow({ show: false, width: 800, height: 600 })
    await w.loadURL('data:text/html,<body>D</body>')
    const v = new WebContentsView({ webPreferences: { sandbox: true } })
    v.setBounds({ x: 0, y: 0, width: 360, height: 240 })   // shell-overlays.ts sync() 在 raise() 之前
    await v.webContents.loadURL('data:text/html,<body>D</body>')
    await sleep(400)
    const beforeAttach = await size(v)
    w.contentView.addChildView(v)                          // 相当于 raise()
    await sleep(500)
    out.D_overlay_sequence = { beforeAttach, afterAttach: await size(v) }
    v.webContents.close()
    w.destroy()
  }

  keeper.destroy()
  console.log('RESULT ' + JSON.stringify(out))
  app.exit(0)
}).catch((e) => { console.error('FAILED', e); app.exit(3) })
