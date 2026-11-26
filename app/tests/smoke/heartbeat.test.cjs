const assert = require('node:assert/strict')
const { mkdtemp, readFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { test } = require('node:test')
const { launchApp, page, startFixtureServer, waitFor } = require('./helpers.cjs')

/**
 * 观测线（2026-11-25 演示 §7.7-1 / §7.7-2）：A1「合并后的长任务」与 A2「GC/帧预算」
 * 在这之前是**零数据**。这里验证两件事能真的测出来：
 *
 * 1. 主进程 ↔ 外壳渲染线程的心跳往返（RTT 直接等于被阻塞的时长）；
 * 2. 浮层文档里 `longtask` 的归因——必须装在浮层自己的 realm 里，外壳侧 observer 拿不到
 *    （LoAF 的 `windowAttribution` 按帧树分档，浮层是另一个顶层窗口）。
 *
 * 都只写诊断文件，不改变任何产品行为；`BAO_HEARTBEAT_TRACE` / `BAO_OVERLAY_TRACE` 未设置时
 * 是空操作。
 */

const diagnostics = (app) => app.evaluate(() => {
  const read = globalThis.__baoEngineDiagnostics
  return typeof read === 'function' ? read() : null
})

async function heartbeatOf(app) {
  const windows = await diagnostics(app)
  assert.ok(Array.isArray(windows) && windows.length > 0, '主进程诊断钩子不可用')
  return windows[0].heartbeat
}

test('心跳：空闲时能稳定测到往返，且数值在合理范围', { timeout: 120_000 }, async () => {
  const server = await startFixtureServer({ '/a': page('A') })
  const traceDir = await mkdtemp(join(tmpdir(), 'bao-heartbeat-'))
  const traceFile = join(traceDir, 'heartbeat.log')
  const { app, shell, close } = await launchApp({ env: { BAO_HEARTBEAT_TRACE: traceFile } })
  try {
    await shell.evaluate((url) => window.baoBrowser.run({ type: 'navigate', address: url }), `${server.baseUrl}/a`)
    // 先跑够样本再清空：启动/导航那一帧的阻塞不该算进"空闲"统计。
    await waitFor(async () => ((await heartbeatOf(app))?.count ?? 0) >= 5 ? true : null,
      { message: '心跳没有开始' })
    await app.evaluate(() => globalThis.__baoHeartbeatReset?.())
    const stats = await waitFor(async () => {
      const current = await heartbeatOf(app)
      return current && current.count >= 10 ? current : null
    }, { timeout: 20_000, message: '心跳没有产生足够样本' })

    assert.ok(stats.p50 >= 0, 'p50 不应为负')
    assert.ok(stats.p99 < 200, `空闲时 p99 不应超过 200 ms：${JSON.stringify(stats)}`)
    assert.ok(stats.max <= 5_000, '异常大的往返说明测量本身有问题')
  } finally {
    await close()
    await server.close()
    await rm(traceDir, { recursive: true, force: true })
  }
})

test('心跳：外壳渲染线程被同步长任务占住时能测出卡顿', { timeout: 120_000 }, async () => {
  const server = await startFixtureServer({ '/a': page('A') })
  const traceDir = await mkdtemp(join(tmpdir(), 'bao-heartbeat-stall-'))
  const traceFile = join(traceDir, 'heartbeat.log')
  const { app, shell, close } = await launchApp({ env: { BAO_HEARTBEAT_TRACE: traceFile } })
  try {
    await shell.evaluate((url) => window.baoBrowser.run({ type: 'navigate', address: url }), `${server.baseUrl}/a`)
    await waitFor(async () => ((await heartbeatOf(app))?.count ?? 0) >= 3 ? true : null,
      { message: '心跳没有开始' })
    await app.evaluate(() => globalThis.__baoHeartbeatReset?.())

    // 在外壳渲染线程上跑 800 ms 同步循环：期间回执发不出去，至少有一次往返会被抬到阈值以上。
    await shell.evaluate(() => {
      const start = Date.now()
      while (Date.now() - start < 800) { /* 故意阻塞 */ }
    })

    /**
     * 判据只用「有没有被记为卡顿」，不断言最大 RTT 的**具体数值**：
     * 并行跑满时主进程的 `setInterval` 也会被拖晚，落在阻塞窗口里的那几次往返可能只有
     * 200–300 ms（阻塞结束前最后发出的那一跳）。要求 `max >= 350` 会变成测机器负载。
     */
    const stats = await waitFor(async () => {
      const current = await heartbeatOf(app)
      return current && current.stalls >= 1 ? current : null
    }, { timeout: 20_000, message: `没有测到卡顿：${JSON.stringify(await heartbeatOf(app))}` })
    assert.ok(stats.max > 0, '最长往返应为正数')

    // 诊断落盘：误杀/卡顿时的第一手证据。
    const trace = await readFile(traceFile, 'utf8')
    assert.match(trace, /stall rtt=\d+ms/, `没有写卡顿诊断：${trace.slice(-400)}`)
  } finally {
    await close()
    await server.close()
    await rm(traceDir, { recursive: true, force: true })
  }
})

test('浮层长任务：归因落在浮层自己的 realm 里', { timeout: 150_000 }, async () => {
  const server = await startFixtureServer({ '/a': page('A') })
  const traceDir = await mkdtemp(join(tmpdir(), 'bao-overlay-lt-'))
  const traceFile = join(traceDir, 'overlay.log')
  const { app, shell, close } = await launchApp({ env: { BAO_OVERLAY_TRACE: traceFile } })
  try {
    await shell.evaluate((url) => window.baoBrowser.run({ type: 'navigate', address: url }), `${server.baseUrl}/a`)
    // 打开飞窗：共享进程模式下浮层文档由外壳 window.open 产生（点齿轮走的就是这条路径）。
    const gear = shell.getByRole('button', { name: '快捷设置', exact: true })
    await gear.click()

    const overlayId = await waitFor(() => app.evaluate(({ webContents }) => {
      const found = webContents.getAllWebContents().find((item) => {
        try {
          return item.getURL().includes('baoOverlay=overlay')
        } catch {
          return false
        }
      })
      return found ? found.id : null
    }), { timeout: 20_000, message: '没有找到浮层 WebContents' })

    // 在浮层文档里跑 300 ms 同步循环：`longtask` 应该带着归属被上报。
    await app.evaluate(async ({ webContents }, id) => {
      const contents = webContents.fromId(id)
      if (!contents || contents.isDestroyed()) throw new Error('浮层已销毁')
      await contents.executeJavaScript(
        '(() => { const start = Date.now(); while (Date.now() - start < 300) { /* 故意阻塞 */ } })()',
        true
      )
    }, overlayId)

    const trace = await waitFor(async () => {
      const text = await readFile(traceFile, 'utf8').catch(() => '')
      return /overlay longtask \d+ms/.test(text) ? text : null
    }, { timeout: 15_000, message: '浮层长任务没有被上报' })

    const durations = [...trace.matchAll(/overlay longtask (\d+)ms/g)].map((match) => Number(match[1]))
    assert.ok(durations.some((value) => value >= 250),
      `上报的时长应接近 300 ms：${JSON.stringify(durations)}`)
  } finally {
    await close()
    await server.close()
    await rm(traceDir, { recursive: true, force: true })
  }
})
