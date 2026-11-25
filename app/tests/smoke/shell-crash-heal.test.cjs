const assert = require('node:assert/strict')
const { test } = require('node:test')
const { execFileSync } = require('node:child_process')
const { readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { launchApp, startFixtureServer, waitFor } = require('./helpers.cjs')

/**
 * 外壳渲染进程自愈（`render-process-gone` → 重载外壳文档）。
 *
 * 为什么存在：共享飞窗（`BAO_OVERLAY_SHARED=1`）把工具栏和浮层放进同一个渲染进程，
 * 常驻内存 +114 MB → +6 MB，代价是故障域合并——浮层里崩一次会连工具栏一起带走
 * （实测崩浮层后外壳 `isCrashed: true`）。页面视图各自独立进程，不受牵连，
 * 所以恢复只需要重载外壳文档，标签状态由主进程 `snapshot` 重建。
 *
 * 为什么这样断言：渲染进程崩溃后 Playwright 的 Page 句柄永久失效（`Target crashed`，
 * 也不会再发 `window` 事件），页面侧根本问不到恢复结果。所以由主进程把证据写进文件
 * （`BAO_SELFHEAL_TRACE` 诊断钩子），这里只读文件；崩溃之后**不再调用任何 Page 方法**，
 * 否则驱动自己会挂住（实测卡死过一次）。
 */
test('外壳渲染进程崩溃后自愈：工具栏回来、标签还在、进程不残留', { timeout: 180_000 }, async () => {
  const traceFile = join(tmpdir(), `bao-selfheal-${process.pid}-${Date.now()}.log`)
  rmSync(traceFile, { force: true })
  process.env.BAO_SELFHEAL_TRACE = traceFile
  const server = await startFixtureServer({ '/game': page('游戏页面') })
  const { app, shell, close } = await launchApp()
  const pid = app.process().pid
  const lines = () => {
    try {
      return readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean)
    } catch {
      return []
    }
  }
  try {
    const address = shell.getByRole('textbox', { name: '地址栏' })
    await address.fill(`${server.baseUrl}/game`)
    await address.press('Enter')
    await shell.getByRole('button', { name: '游戏页面', exact: true }).waitFor({ timeout: 30_000 })

    // 崩掉外壳渲染进程（共享模式下浮层跟着一起死，这正是要覆盖的最坏情况）。
    await app.evaluate(({ webContents }) => {
      const shellWc = webContents.getAllWebContents().find((c) => (c.getURL() ?? '').endsWith('/out/renderer/index.html'))
      shellWc.forcefullyCrashRenderer()
    })

    // ↓↓ 从这里开始只碰主进程，不再用 Page。
    const recovered = await waitFor(async () => {
      const found = lines().find((line) => line.includes('recovered') || line.includes('recover-failed'))
      return found ?? null
    }, { timeout: 60_000, message: '自愈没有在 60 s 内报告结果' })

    assert.match(recovered, /recovered/, `自愈失败：${recovered}`)
    const payload = JSON.parse(recovered.slice(recovered.indexOf('{')))
    assert.equal(payload.gear, true, '重载后工具栏没有回来')
    assert.equal(payload.tabs, 1, '重载后标签行没有重建')

    const after = await app.evaluate(({ webContents }) => {
      const shellWc = webContents.getAllWebContents().find((c) => (c.getURL() ?? '').endsWith('/out/renderer/index.html'))
      const tab = webContents.getAllWebContents().find((c) => (c.getURL() ?? '').includes('/game'))
      return {
        crashed: shellWc?.isCrashed() ?? null,
        url: shellWc?.getURL() ?? null,
        page: tab?.getURL() ?? null,
        pageCrashed: tab?.isCrashed() ?? null
      }
    })
    assert.equal(after.crashed, false, '外壳仍处于崩溃状态')
    assert.match(String(after.url), /out\/renderer\/index\.html$/, '外壳没有回到自己的文档')
    assert.match(String(after.page), /\/game/, '页面视图不应该被外壳崩溃牵连')
    assert.equal(after.pageCrashed, false, '页面渲染进程不应该跟着崩')
  } finally {
    delete process.env.BAO_SELFHEAL_TRACE
    // 崩溃过的 app 用 Playwright 关闭可能挂住：限时等，超时就强杀进程树。
    await Promise.race([close(), new Promise((resolve) => setTimeout(resolve, 8_000))])
    try {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' })
    } catch { /* 已经退出 */ }
    rmSync(traceFile, { force: true })
    await Promise.resolve(server.close()).catch(() => {})
  }
})

function page(title) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1>`
}
