const assert = require('node:assert/strict')
const { test } = require('node:test')
const { isShellPage, launchApp, page, pageViewIds, startFixtureServer, waitFor } = require('./helpers.cjs')

async function snapshot(shell) {
  const result = await shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' }))
  assert.equal(result.ok, true)
  return result.state
}

async function navigate(shell, url, title) {
  const address = shell.getByRole('textbox', { name: '地址栏' })
  await address.waitFor()
  await address.fill(url)
  await address.press('Enter')
  await shell.getByRole('button', { name: title, exact: true }).waitFor({ timeout: 30_000 })
}

test('窗口销毁与重建后旧事件和旧标签身份保持隔离', { timeout: 240_000 }, async () => {
  const server = await startFixtureServer({
    '/one': page('第一个页面'),
    '/two': page('第二个页面'),
    '/three': page('第三个页面')
  })
  const { app, shell, close } = await launchApp()
  try {
    const shellsOf = async () => (await app.windows()).filter(isShellPage)

    await navigate(shell, `${server.baseUrl}/one`, '第一个页面')

    // 第二个窗口：验证每个窗口独立拥有标签、选中关系和 IPC 目标。
    await app.evaluate(({ app }) => app.emit('bao-next:open-window'))
    const twoShells = await waitFor(async () => {
      const list = await shellsOf()
      return list.length >= 2 ? list : null
    }, { message: '第二个窗口未创建。' })
    const first = shell
    const second = twoShells.find((page) => page !== first)
    assert.ok(second, '未找到第二个窗口的页面。')
    await navigate(second, `${server.baseUrl}/two`, '第二个页面')

    const firstWindow = await app.browserWindow(first)
    const secondWindow = await app.browserWindow(second)
    const firstViewIds = await pageViewIds(firstWindow)
    const secondViewIds = await pageViewIds(secondWindow)
    assert.ok(firstViewIds.length > 0 && secondViewIds.length > 0)
    assert.notDeepEqual(firstViewIds, secondViewIds)

    const firstState = await snapshot(first)
    const secondState = await snapshot(second)
    assert.notEqual(firstState.tabs[0].address, secondState.tabs[0].address)

    // 销毁第一个窗口：只释放它自己的 WebContents，全局命令通道保持可用。
    await first.close()
    await waitFor(async () => (await shellsOf()).length === 1, { message: '关闭窗口后进程或页面未收敛。' })
    const destroyed = await waitFor(async () => {
      const states = await app.evaluate(({ webContents }, ids) =>
        ids.map((id) => {
          const contents = webContents.fromId(id)
          return contents === undefined || contents.isDestroyed()
        }), firstViewIds)
      return states.every(Boolean) ? states : null
    }, { timeout: 15_000, message: '旧窗口的 WebContents 未全部销毁。' })
    assert.ok(destroyed.every(Boolean))

    await navigate(second, `${server.baseUrl}/three`, '第三个页面')
    const afterClose = await snapshot(second)
    assert.equal(afterClose.activeId, secondState.activeId)
    assert.ok(afterClose.tabs.every((tab) => !tab.address.endsWith('/one')), '残留了已销毁窗口的标签地址。')
    assert.ok(afterClose.tabs.some((tab) => tab.address.endsWith('/three')))

    // 重建：新窗口不得继承旧窗口的标签、revision 或选中关系。
    await app.evaluate(({ app }) => app.emit('bao-next:open-window'))
    const rebuiltShells = await waitFor(async () => {
      const list = await shellsOf()
      return list.length >= 2 ? list : null
    }, { message: '重建窗口未创建。' })
    const rebuilt = rebuiltShells.find((page) => page !== second)
    assert.ok(rebuilt, '未找到重建的窗口。')
    await rebuilt.getByRole('textbox', { name: '地址栏' }).waitFor()
    const rebuiltState = await snapshot(rebuilt)
    assert.equal(rebuiltState.tabs.length, 1)
    assert.deepEqual(rebuiltState.tabs.map((tab) => tab.title), ['新标签页'])
    assert.ok(rebuiltState.tabs.every((tab) => tab.address === ''), '重建窗口继承了旧窗口的地址。')
    assert.ok(rebuiltState.revision < afterClose.revision + 5, '重建窗口继承了旧窗口的事件序号。')

    const revisionBefore = (await snapshot(rebuilt)).revision
    await navigate(second, `${server.baseUrl}/two`, '第二个页面')
    assert.equal((await snapshot(rebuilt)).revision, revisionBefore, '旧窗口事件污染了重建窗口的状态。')

    // 渲染进程崩溃后重建 WebContents：旧代际事件作废，旧内容释放。
    const crashedViewId = (await pageViewIds(secondWindow))[0]
    await app.evaluate(({ webContents }, id) => webContents.fromId(id)?.forcefullyCrashRenderer(), crashedViewId)
    await second.getByRole('heading', { name: /页面已停止响应/ }).waitFor({ timeout: 30_000 })
    const crashedState = await snapshot(second)
    assert.equal(crashedState.tabs.find((tab) => tab.id === crashedState.activeId)?.crashed, true)

    await second.getByRole('button', { name: '重新加载', exact: true }).click()
    await second.getByRole('button', { name: '第二个页面', exact: true }).waitFor({ timeout: 30_000 })
    const rebuiltViewId = (await pageViewIds(secondWindow))[0]
    assert.notEqual(rebuiltViewId, crashedViewId, '未重建 WebContents。')
    assert.equal(await app.evaluate(({ webContents }, id) => {
      const contents = webContents.fromId(id)
      return contents === undefined || contents.isDestroyed()
    }, crashedViewId), true)
    assert.equal((await snapshot(second)).tabs.find((tab) => tab.id === afterClose.activeId)?.crashed, false)

    // 最后一个窗口关闭后进程正常退出，不残留窗口或页面视图。
    const exitCode = await new Promise((resolveExit) => {
      const timer = setTimeout(() => resolveExit('timeout'), 20_000)
      app.process().once('exit', (code) => {
        clearTimeout(timer)
        resolveExit(code)
      })
      void second.close()
      void rebuilt.close()
    })
    assert.equal(exitCode, 0)
  } finally {
    await close()
    await server.close()
  }
})
