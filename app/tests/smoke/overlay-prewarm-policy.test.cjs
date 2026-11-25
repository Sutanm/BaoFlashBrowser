const assert = require('node:assert/strict')
const { test } = require('node:test')
const { launchApp, waitFor } = require('./helpers.cjs')

/**
 * `overlay.prewarm` 三档在**共享进程模式**下的合同（2026-11-25）。
 *
 * 为什么单独一条：共享模式落地后三档行为**完全一致**——悬停路径不看策略、直接
 * `window.open`，于是 `never` 也照样预热，`always` 反而没人建（主进程的 `prewarm()`
 * 在共享模式下是空操作），建出来的文档也从不回收。三档在界面上是三个选项，
 * 实测却是同一档，这种"设置项骗人"只能靠用例钉住。
 *
 * 合同：
 *   auto   悬停 180 ms 预热；隐藏后空闲 RETIRE_AFTER_MS 回收，下次再建
 *   always 启动后（空闲时）就建好并常驻，第一次点开就是热的，不回收
 *   never  悬停/启动都不建；点击（或 toast）才建
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

test('overlay.prewarm=auto：悬停预热 → 复用 → 空闲回收 → 重新预热', {
  timeout: 120_000,
  skip: hiddenMode && '预热在隐藏模式下被禁用，需前台运行：npm run smoke:foreground'
}, async () => {
  // 显式钉住 auto：外层可能用 `BAO_OVERLAY_PREWARM=always` 跑整轮（常驻档验收），
  // 不钉死的话本用例会被外层覆盖成 always，测的就不是 auto 了。
  const { app, shell, close } = await launchApp({ env: { BAO_RETIRE_MS: '1500', BAO_OVERLAY_PREWARM: 'auto' } })
  try {
    await gear(shell).waitFor({ timeout: 30_000 })
    assert.equal((await overlayState(app)).present, false, 'auto：启动后不该有浮层文档')

    await gear(shell).hover()
    const warmed = await waitFor(async () => {
      const state = await overlayState(app)
      return state.present ? state : null
    }, { message: 'auto：悬停 180 ms 后应当预热出文档' })
    assert.equal(warmed.visible, false, 'auto：预热出来的视图必须是隐藏的')
    assert.equal(warmed.attached, false, 'auto：预热阶段不该把视图挂到窗口上')

    await gear(shell).click()
    const opened = await waitFor(async () => {
      const state = await overlayState(app)
      return state.visible ? state : null
    }, { message: 'auto：点击后应当显示浮层' })
    assert.equal(opened.id, warmed.id, 'auto：点击应复用预热文档，而不是再开一个')

    // 点别处关闭 → 按 RETIRE_AFTER_MS 回收 → 再悬停应当重新预热。
    await shell.getByRole('textbox', { name: '地址栏' }).click()
    await waitFor(async () => !(await overlayState(app)).visible, { message: 'auto：点击别处应当隐藏浮层' })
    await waitFor(async () => !(await overlayState(app)).present, {
      message: 'auto：隐藏后空闲 1.5 s 应当回收文档（此前共享模式从不回收）'
    })

    await gear(shell).hover()
    const reopened = await waitFor(async () => {
      const state = await overlayState(app)
      return state.present ? state : null
    }, { message: 'auto：回收后再悬停应当重新预热' })
    assert.notEqual(reopened.id, warmed.id, 'auto：回收后应当是一个新文档')
    await gear(shell).click()
    await waitFor(async () => (await overlayState(app)).visible, { message: 'auto：回收后点击仍应能打开' })
  } finally {
    await close()
  }
})

test('overlay.prewarm=never：悬停不建文档，点击仍能冷开', {
  timeout: 120_000,
  skip: hiddenMode && '预热在隐藏模式下被禁用，需前台运行：npm run smoke:foreground'
}, async () => {
  const { app, shell, close } = await launchApp({ env: { BAO_OVERLAY_PREWARM: 'never' } })
  try {
    await gear(shell).waitFor({ timeout: 30_000 })
    await gear(shell).hover()
    // 悬停意图是 180 ms：等足 1.2 s 仍然没有文档才算「真的不预热」。
    await new Promise((done) => setTimeout(done, 1_200))
    assert.equal((await overlayState(app)).present, false, 'never：悬停不该建文档')

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
    }, { message: 'always：启动后空闲时应当常驻预热出文档' })
    assert.equal(warmed.visible, false, 'always：常驻预热不该显示视图')

    await gear(shell).click()
    const opened = await waitFor(async () => {
      const state = await overlayState(app)
      return state.visible ? state : null
    }, { message: 'always：点击后应当显示浮层' })
    assert.equal(opened.id, warmed.id, 'always：第一次点开就该复用常驻文档')

    // 常驻档不回收（「不预热」才回收）。
    await shell.getByRole('textbox', { name: '地址栏' }).click()
    await waitFor(async () => !(await overlayState(app)).visible, { message: 'always：点击别处应当隐藏' })
    await new Promise((done) => setTimeout(done, 1_500))
    assert.equal((await overlayState(app)).present, true, 'always：常驻档不该回收文档')
  } finally {
    await close()
  }
})
