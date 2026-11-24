const assert = require('node:assert/strict')
const { test } = require('node:test')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { launchAppAt, page, pressShortcut, startFixtureServer, waitFor } = require('./helpers.cjs')

/**
 * 存储清理（M2）：「设置 → 数据 → 已保存的会话 → 清除」。
 *
 * 这条用例只验证**分类清理**这一档：会话载荷与退出标记被删掉，本次运行不再记录，
 * 下次启动不会拿旧会话弹恢复提示。站点规则、设置本身不在本次范围。
 *
 * 为什么用真库断言：清理是"删了没有"的问题，只有直接看库才可信；
 * 页面上的提示文案只能证明 UI 收到了结果。
 */

const dbFile = (profilePath) => join(profilePath, 'db', 'browser.sqlite3')

/** 直接读库（应用运行中也可以：WAL 允许并发读）。 */
function inspect(profilePath, sql, ...params) {
  const db = new DatabaseSync(dbFile(profilePath))
  try {
    return db.prepare(sql).all(...params)
  } finally {
    db.close()
  }
}

async function settingsViewId(app) {
  return app.evaluate(({ webContents }) => {
    const target = webContents.getAllWebContents().find((contents) => (contents.getURL() ?? '').startsWith('bao://settings'))
    return target ? target.id : null
  })
}

async function inSettings(app, code) {
  const id = await waitFor(() => settingsViewId(app), { timeout: 10_000, interval: 30, message: '没有找到设置页的 WebContents' })
  return app.evaluate(async ({ webContents }, payload) => {
    const target = webContents.fromId(payload.id)
    if (!target) throw new Error('设置页已销毁')
    return target.executeJavaScript(payload.code)
  }, { id, code })
}

const snapshot = (shell) => shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' })).then((result) => result.state)

test('设置页「数据 → 清除会话」：删掉会话与退出标记，本次不再记录，重启不提示恢复', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({ '/one': page('清理测试页') })
  const profilePath = await mkdtemp(join(tmpdir(), 'bao-next-cleanup-'))
  try {
    const first = await launchAppAt(profilePath)
    try {
      // 打开一个网页标签，让会话里确实有内容。
      const address = first.shell.getByRole('textbox', { name: '地址栏' })
      await address.fill(`${server.baseUrl}/one`)
      await address.press('Enter')
      await first.shell.getByRole('button', { name: '清理测试页', exact: true }).waitFor()
      await waitFor(() => {
        const rows = inspect(profilePath, 'SELECT payload FROM session WHERE id = 0')
        return rows.length === 1
      }, { message: '会话没有落盘' })

      // Ctrl+, 打开设置页（当前标签是网页，所以会新建一个设置标签）。
      await pressShortcut(first.app, ',', ['control'])
      const hasDataSection = await inSettings(first.app, `(() => {
        const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === '清除')
        return Boolean(button && document.querySelector('#data-title'))
      })()`)
      assert.equal(hasDataSection, true, '设置页应有「数据」分区与「清除」按钮')

      const clicked = await inSettings(first.app, `(() => {
        const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === '清除')
        if (!button) return false
        button.click()
        return true
      })()`)
      assert.equal(clicked, true)

      // 页面反馈：清除成功。
      const notice = await waitFor(() => inSettings(first.app, `(() => {
        const status = [...document.querySelectorAll('[role="status"]')].map((item) => item.textContent).join(' ')
        return status.includes('已清除') ? status : ''
      })()`), { message: '设置页没有显示清除结果' })
      assert.match(notice, /下次启动恢复记录/)

      // 真库断言：会话行与退出标记都没了。
      assert.deepEqual(inspect(profilePath, 'SELECT payload FROM session'), [], '会话载荷应被删除')
      assert.deepEqual(
        inspect(profilePath, 'SELECT value FROM meta WHERE key = ?', 'session.last-exit'), [],
        '退出标记应被删除')
    } finally {
      await first.close()
    }

    // 本次运行已停止记录：正常退出后库里仍然没有会话（不会把当前标签写回去）。
    assert.deepEqual(inspect(profilePath, 'SELECT payload FROM session'), [],
      '清除之后本次运行的退出写盘不应重新生成会话')

    // 重启：没有会话可恢复，也没有提示条。
    const second = await launchAppAt(profilePath)
    try {
      const state = await snapshot(second.shell)
      assert.equal(state.tabs.length, 1, '重启后只有新标签页')
      assert.equal(state.tabs[0].internal, 'newtab')
      assert.equal(state.sessionPrompt, undefined, '清除过的会话不应再触发恢复提示')
      assert.equal(await second.shell.locator('.session-infobar').count(), 0)
    } finally {
      await second.close()
    }

    // 下次启动恢复正常记录：再逛一次并正常退出，会话应重新出现。
    const third = await launchAppAt(profilePath)
    try {
      const address = third.shell.getByRole('textbox', { name: '地址栏' })
      await address.fill(`${server.baseUrl}/one`)
      await address.press('Enter')
      await third.shell.getByRole('button', { name: '清理测试页', exact: true }).waitFor()
      await waitFor(() => {
        const rows = inspect(profilePath, 'SELECT payload FROM session WHERE id = 0')
        return rows.length === 1
      }, { message: '重启后会话记录能力没有恢复' })
    } finally {
      await third.close()
    }
  } finally {
    await rm(profilePath, { recursive: true, force: true, maxRetries: 3 })
    await server.close()
  }
})
