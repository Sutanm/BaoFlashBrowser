const assert = require('node:assert/strict')
const { test } = require('node:test')
const { launchApp, page, startFixtureServer, waitFor } = require('./helpers.cjs')

/**
 * 后台标签休眠（丢弃）：后台超过 TTL 的标签销毁视图省内存，切回时按原地址重建。
 *
 * 用 `BAO_DISCARD_TTL_MS` / `BAO_DISCARD_SWEEP_MS` 把时间片缩短到毫秒级，避免测试等 10 分钟。
 */

const state = (shell) => shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' })).then((result) => result.state)

function withDiscardEnv() {
  // TTL 要长于页面首次加载，否则会在加载途中就被休眠，测不到「加载完成后休眠」这条主路径。
  process.env.BAO_DISCARD_TTL_MS = '3000'
  process.env.BAO_DISCARD_SWEEP_MS = '300'
}

function clearDiscardEnv() {
  delete process.env.BAO_DISCARD_TTL_MS
  delete process.env.BAO_DISCARD_SWEEP_MS
}

test('后台标签超时休眠，切回时按原地址重建', { timeout: 120_000 }, async () => {
  withDiscardEnv()
  const server = await startFixtureServer({
    '/a': page('A'),
    '/b': page('B')
  })
  const { app, shell, close } = await launchApp()
  try {
    // 打开两个页面标签（起始页保持活动，A/B 都在后台）
    for (const path of ['/a', '/b']) {
      await shell.evaluate(() => window.baoBrowser.run({ type: 'add' }))
      await shell.evaluate((url) => window.baoBrowser.run({ type: 'navigate', address: url }), `${server.baseUrl}${path}`)
      await waitFor(async () => (await state(shell)).tabs.some((tab) => tab.title === path.slice(1).toUpperCase() && !tab.loading),
        { message: `标签 ${path} 没有加载完` })
    }

    // 只有 A 在后台（B 是当前标签），所以等 A 被休眠即可。
    const discarded = await waitFor(async () => {
      const list = (await state(shell)).tabs.filter((tab) => tab.discarded)
      return list.length >= 1 ? list : null
    }, { timeout: 20_000, message: '后台标签没有被休眠' })
    assert.deepEqual(discarded.map((tab) => tab.title), ['A'])
    // 休眠标签仍保留地址与标题，界面不会变成空白页
    assert.ok(discarded.every((tab) => tab.address.startsWith(server.baseUrl)))
    assert.ok(discarded.every((tab) => tab.loading === false && tab.crashed === false))

    // 切回休眠标签：应被唤醒并重新加载到同一地址
    const victim = discarded.find((tab) => tab.title === 'A')
    await shell.evaluate((id) => window.baoBrowser.run({ type: 'select', id }), victim.id)
    const revived = await waitFor(async () => {
      const tab = (await state(shell)).tabs.find((item) => item.id === victim.id)
      // 唤醒是「先重建视图、再重新加载」：等到标题与地址都恢复才算完成。
      return tab && !tab.discarded && !tab.loading && tab.title === 'A' ? tab : null
    }, { timeout: 15_000, message: '休眠标签没有被唤醒' })
    assert.equal(revived.title, 'A')
    assert.equal(revived.address, `${server.baseUrl}/a`)
  } finally {
    await close()
    await server.close()
    clearDiscardEnv()
  }
})

test('设置 tab.discard=never 时后台标签不被休眠（挂机场景）', { timeout: 120_000 }, async () => {
  withDiscardEnv()
  const server = await startFixtureServer({ '/c': page('C') })
  const { app, shell, close } = await launchApp()
  try {
    const written = await shell.evaluate(() => window.baoBrowser.run({ type: 'set-setting', key: 'tab.discard', value: 'never' }))
    assert.equal(written.ok, true, '设置 tab.discard 应写入成功')

    await shell.evaluate(() => window.baoBrowser.run({ type: 'add' }))
    await shell.evaluate((url) => window.baoBrowser.run({ type: 'navigate', address: url }), `${server.baseUrl}/c`)
    await waitFor(async () => (await state(shell)).tabs.some((tab) => tab.title === 'C' && !tab.loading),
      { message: '标签 C 没有加载完' })

    // 等两倍 TTL，确认没有任何标签被休眠
    await new Promise((done) => setTimeout(done, 2500))
    const list = (await state(shell)).tabs
    assert.equal(list.filter((tab) => tab.discarded).length, 0, '关闭休眠后不应丢弃任何标签')
    assert.ok(list.some((tab) => tab.title === 'C'))
  } finally {
    await close()
    await server.close()
    clearDiscardEnv()
  }
})

test('标记「保持活跃」的标签不被休眠，取消标记后恢复休眠', { timeout: 120_000 }, async () => {
  withDiscardEnv()
  const server = await startFixtureServer({ '/d': page('D') })
  const { app, shell, close } = await launchApp()
  try {
    await shell.evaluate(() => window.baoBrowser.run({ type: 'add' }))
    await shell.evaluate((url) => window.baoBrowser.run({ type: 'navigate', address: url }), `${server.baseUrl}/d`)
    const tab = await waitFor(async () => {
      const found = (await state(shell)).tabs.find((item) => item.title === 'D' && !item.loading)
      return found ?? null
    }, { message: '标签 D 没有加载完' })

    const marked = await shell.evaluate((id) => window.baoBrowser.run({ type: 'keep-awake', id, value: true }), tab.id)
    assert.equal(marked.ok, true)
    // 让 D 退到后台：扫描器不会休眠当前标签，所以必须先把别的标签切成活动。
    await shell.evaluate(() => window.baoBrowser.run({ type: 'add' }))
    await new Promise((done) => setTimeout(done, 400))

    // 等三倍 TTL：标记期间不应该被休眠
    await new Promise((done) => setTimeout(done, 3000))
    const kept = (await state(shell)).tabs.find((item) => item.id === tab.id)
    assert.equal(kept.discarded, undefined, '标记保持活跃后不应被休眠')
    assert.equal(kept.keepAwake, true)

    // 取消标记后重新计入后台时间，TTL 到点后应休眠
    await shell.evaluate((id) => window.baoBrowser.run({ type: 'keep-awake', id, value: false }), tab.id)
    const discarded = await waitFor(async () => {
      const item = (await state(shell)).tabs.find((entry) => entry.id === tab.id)
      return item?.discarded ? item : null
    }, { timeout: 15_000, message: '取消标记后仍未休眠' })
    assert.equal(discarded.title, 'D')
  } finally {
    await close()
    await server.close()
    clearDiscardEnv()
  }
})