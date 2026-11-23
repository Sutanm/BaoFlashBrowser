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

test('权限白名单：只放行 fullscreen / pointerLock，其余拒绝', { timeout: 120_000 }, async () => {
  const server = await startFixtureServer({ '/perm': PAGE })
  const { app, shell, close } = await launchApp()
  try {
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${server.baseUrl}/perm`)
    await address.press('Enter')
    await shell.getByRole('button', { name: '权限探针', exact: true }).waitFor({ timeout: 30_000 })

    // 全屏：放行
    await viewEval(app, shell, "document.getElementById('fs').click()", true)
    await waitFor(async () => (await viewEval(app, shell, 'document.fullscreenElement !== null')) === true,
      { message: 'fullscreen 被拒绝了。' })
    await viewEval(app, shell, 'document.exitFullscreen()', true)
    await waitFor(async () => (await viewEval(app, shell, 'document.fullscreenElement === null')) === true,
      { message: '退出全屏失败。' })

    // 指针锁：放行
    await viewEval(app, shell, "document.getElementById('pad').click()", true)
    await waitFor(async () => (await viewEval(app, shell, 'document.pointerLockElement !== null')) === true,
      { message: 'pointerLock 被拒绝了。' })
    await viewEval(app, shell, 'document.exitPointerLock()', true)

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
