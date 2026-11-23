const assert = require('node:assert/strict')
const { test } = require('node:test')
const { launchApp, startFixtureServer, waitFor } = require('./helpers.cjs')

async function viewEval(app, shell, code, userGesture = false) {
  const handle = await app.browserWindow(shell)
  return handle.evaluate((window, payload) => {
    const view = window.contentView.children
      .find((child) => child.webContents && child.webContents !== window.webContents)
    return view.webContents.executeJavaScript(payload.code, payload.userGesture)
  }, { code, userGesture })
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>权限探针</title>
  <button id="fs" style="margin:8px;padding:8px 16px">全屏</button>
  <div id="pad" style="margin:8px;width:200px;height:200px;background:#333"></div>
  <script>
    document.getElementById('fs').onclick = () => document.documentElement.requestFullscreen()
    document.getElementById('pad').onclick = () => document.getElementById('pad').requestPointerLock()
  </script>`

/**
 * 自动化模式（`npm run smoke:bg`）：窗口不显示且不获焦，pointerLock/fullscreen 的用户激活
 * 拿不到（Chromium 要求文档获得焦点），所以放行那半条用例显式跳过并说明原因；
 * 「其余权限一律拒绝」不依赖焦点，仍然在自动化模式里跑。
 */
const AUTOMATED = process.env.BAO_SMOKE_HIDDEN === '1' || process.env.BAO_SMOKE_BACKGROUND === '1'

test('权限白名单：fullscreen / pointerLock 放行', {
  timeout: 120_000,
  skip: AUTOMATED ? 'pointerLock/fullscreen 需要文档焦点，自动化模式（不抢前台）无法验证' : false
}, async () => {
  const server = await startFixtureServer({ '/perm': PAGE })
  const { app, shell, close } = await launchApp()
  try {
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${server.baseUrl}/perm`)
    await address.press('Enter')
    await shell.getByRole('button', { name: '权限探针', exact: true }).waitFor({ timeout: 30_000 })

    // 全屏：放行。fullscreen 需要用户激活，全量跑时窗口可能失焦导致请求被丢弃，
    // 所以重试几次点击（不是放宽断言）。
    const granted = async (code, message) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await viewEval(app, shell, code, true)
        const ok = await waitFor(async () => (await viewEval(app, shell, message.probe)) === true, {
          timeout: 8_000,
          message: message.text
        }).catch(() => null)
        if (ok) return
      }
      throw new Error(message.text)
    }
    await granted("document.getElementById('fs').click()", {
      probe: 'document.fullscreenElement !== null',
      text: 'fullscreen 被拒绝了（重试 3 次）。'
    })
    await viewEval(app, shell, 'document.exitFullscreen()', true)
    await waitFor(async () => (await viewEval(app, shell, 'document.fullscreenElement === null')) === true,
      { message: '退出全屏失败。' })

    // 指针锁：放行
    await viewEval(app, shell, "document.getElementById('pad').click()", true)
    await waitFor(async () => (await viewEval(app, shell, 'document.pointerLockElement !== null')) === true,
      { message: 'pointerLock 被拒绝了。' })
    await viewEval(app, shell, 'document.exitPointerLock()', true)
  } finally {
    await close()
    await server.close()
  }
})

test('权限白名单：其余权限一律拒绝', { timeout: 120_000 }, async () => {
  const server = await startFixtureServer({ '/perm': PAGE })
  const { app, shell, close } = await launchApp()
  try {
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${server.baseUrl}/perm`)
    await address.press('Enter')
    await shell.getByRole('button', { name: '权限探针', exact: true }).waitFor({ timeout: 30_000 })

    // 其余权限：拒绝（证明白名单是选择性的，不是全放行）
    const geolocation = await viewEval(app, shell, "navigator.permissions.query({ name: 'geolocation' }).then((s) => s.state)")
    assert.equal(geolocation, 'denied', `geolocation 未被拒绝：${geolocation}`)

    const notifications = await viewEval(app, shell, 'Notification.requestPermission()')
    assert.equal(notifications, 'denied', `notifications 未被拒绝：${notifications}`)

    // 说明：请求源/嵌入源的分支（`details.requestingUrl` / `details.embeddingOrigin`、
    // opaque origin 拒绝）已按审计 P2 在 `sessions.ts` 实现，但**冒烟无法可靠覆盖**：
    // sandbox 无 allow-same-origin 的 iframe 是 opaque origin，父页面读不到它的
    // contentWindow，而 pointerLock/fullscreen 又都需要该帧的 transient user activation，
    // 自动化只能构造出"因为缺激活而失败"的假阳性。此处不写这条断言，改由代码评审与
    // 报告 §5 记录。
  } finally {
    await close()
    await server.close()
  }
})
