const assert = require('node:assert/strict')
const { test } = require('node:test')
const { launchApp, waitFor } = require('./helpers.cjs')

/**
 * `overlay.prewarm` 开关在**共享进程模式**下的合同（2026-11-26 由三档收敛为开关）。
 *
 * 为什么单独一条：共享模式落地后三档曾行为**完全一致**——悬停路径不看策略、直接
 * `window.open`，于是 `never` 也照样预热，`always` 反而没人建（主进程的 `prewarm()`
 * 在共享模式下是空操作），建出来的文档也从不回收。三档在界面上是三个选项，
 * 实测却是同一档，这种"设置项骗人"只能靠用例钉住。
 *
 * 中间档 `auto`（悬停 180 ms 预热 + 空闲回收）已删除：常驻只要 5–9 MB、不新增渲染进程，
 * 中间档换不来相应收益，却要养悬停意图/闸门/回收定时器/切档特判。现在只剩两条：
 *
 *   always（默认） 启动后（show 之前）就建好并常驻，第一次点开就是热的，不回收
 *   never          启动/悬停都不建；点击（或 toast）才建，且切到 never 会立刻释放已有文档
 *
 * 预热在自动化窗口模式（隐藏/后台）下被主进程主动禁用，所以只能用前台跑：
 *   npm run smoke:foreground -- --serial
 */
const hiddenMode =
  process.env.BAO_SMOKE_HIDDEN === '1' || process.env.BAO_SMOKE_BACKGROUND === '1'

/** 共享浮层的真实状态：文档是否存在 / 是否挂到窗口上 / 是否可见。 */
async function overlayState(app) {
  return app.evaluate(({ BrowserWindow, webContents }) => {
    const win = BrowserWindow.getAllWindows()[0]
    let guest
    for (const contents of webContents.getAllWebContents()) {
      try {
        if (contents.getURL().includes('baoOverlay=overlay')) guest = contents
      } catch { /* destroyed */ }
    }
    const view = guest ? win.contentView.children.find((child) => child.webContents?.id === guest.id) : undefined
    return {
      present: Boolean(guest),
      id: guest ? guest.id : null,
      attached: Boolean(view),
      visible: view ? view.getVisible() : false
    }
  })
}

function gear(shell) {
  return shell.getByRole('button', { name: '快捷设置', exact: true })
}

/** 在设置页里点「飞窗预热」开关（设置页是独立 WebContentsView，用 JS 点与真人路径一致）。 */
async function togglePrewarmSwitch(app) {
  return app.evaluate(async ({ webContents }) => {
    const target = webContents.getAllWebContents().find((contents) => (contents.getURL() ?? '').startsWith('bao://settings'))
    if (!target) return 'no-settings-page'
    await target.executeJavaScript(`document.querySelector('[role="switch"][aria-label="飞窗预热"]')?.click()`)
    return 'clicked'
  })
}

test('overlay.prewarm=never：不做任何提前创建，点击仍能冷开', {
  timeout: 120_000,
  skip: hiddenMode && '预热在隐藏模式下被禁用，需前台运行：npm run smoke:foreground'
}, async () => {
  const { app, shell, close } = await launchApp({ env: { BAO_OVERLAY_PREWARM: 'never' } })
  try {
    await gear(shell).waitFor({ timeout: 30_000 })
    // 不碰任何入口，等足 1.2 s：仍然没有文档才算「真的不预热」。
    await new Promise((done) => setTimeout(done, 1_200))
    assert.equal((await overlayState(app)).present, false, 'never：不该有任何预热文档')

    await gear(shell).click()
    await waitFor(async () => (await overlayState(app)).visible, {
      message: 'never：点击仍应能打开（「不预热」不等于「不能用」）'
    })
  } finally {
    await close()
  }
})

test('overlay.prewarm=always：启动后常驻预热，第一次点开复用同一文档', {
  timeout: 120_000,
  skip: hiddenMode && '预热在隐藏模式下被禁用，需前台运行：npm run smoke:foreground'
}, async () => {
  const { app, shell, close } = await launchApp({ env: { BAO_OVERLAY_PREWARM: 'always' } })
  try {
    await gear(shell).waitFor({ timeout: 30_000 })
    // 不碰任何入口：文档应当由主进程的「现在就预热」自己建出来。
    const warmed = await waitFor(async () => {
      const state = await overlayState(app)
      return state.present ? state : null
    }, { message: 'always：启动后应当常驻预热出文档' })
    assert.equal(warmed.visible, false, 'always：常驻预热不该显示视图')

    await gear(shell).click()
    const opened = await waitFor(async () => {
      const state = await overlayState(app)
      return state.visible ? state : null
    }, { message: 'always：点击后应当显示浮层' })
    assert.equal(opened.id, warmed.id, 'always：第一次点开就该复用常驻文档')

    // 常驻档不回收。
    await shell.getByRole('textbox', { name: '地址栏' }).click()
    await waitFor(async () => !(await overlayState(app)).visible, { message: 'always：点击别处应当隐藏' })
    await new Promise((done) => setTimeout(done, 1_500))
    assert.equal((await overlayState(app)).present, true, 'always：常驻档不该回收文档')
  } finally {
    await close()
  }
})

test('overlay.prewarm 开关：关掉立刻释放已建好的文档，再打开立刻预热', {
  timeout: 120_000,
  skip: hiddenMode && '预热在隐藏模式下被禁用，需前台运行：npm run smoke:foreground'
}, async () => {
  const { app, shell, close } = await launchApp({ env: { BAO_OVERLAY_PREWARM: 'always' } })
  try {
    await gear(shell).waitFor({ timeout: 30_000 })
    const warmed = await waitFor(async () => {
      const state = await overlayState(app)
      return state.present ? state : null
    }, { message: '开关：启动后应当先预热出文档' })

    // 打开设置页（Ctrl+,）→ 关掉开关。
    await app.evaluate(async ({ webContents }) => {
      const target = webContents.getAllWebContents().find((contents) => contents.getURL().endsWith('index.html'))
      for (const type of ['keyDown', 'char', 'keyUp']) {
        target.sendInputEvent({ type, keyCode: ',', modifiers: ['control'] })
      }
      await new Promise((done) => setTimeout(done, 50))
    })
    await waitFor(async () => app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().some((contents) => (contents.getURL() ?? '').startsWith('bao://settings'))
    ), { message: '开关：Ctrl+, 没有打开设置页' })
    assert.equal(await togglePrewarmSwitch(app), 'clicked')

    await waitFor(async () => !(await overlayState(app)).present, {
      message: '开关：关掉预热应当立刻释放已建好的文档（不用等关窗/回收计时）'
    })

    // 再打开：应当立刻重新预热，且是一次新的开窗（旧 WindowProxy 已 closed）。
    assert.equal(await togglePrewarmSwitch(app), 'clicked')
    const rewarmed = await waitFor(async () => {
      const state = await overlayState(app)
      return state.present ? state : null
    }, { message: '开关：重新打开后应当立刻预热出文档' })
    assert.notEqual(rewarmed.id, warmed.id, '开关：重新打开应当是一份新文档')
    assert.equal(rewarmed.visible, false, '开关：重新预热不该显示视图')
  } finally {
    await close()
  }
})
