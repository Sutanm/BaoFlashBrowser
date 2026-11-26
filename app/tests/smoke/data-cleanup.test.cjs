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

test('设置页「隐私、搜索和服务 → 清除会话」：删掉会话与退出标记，本次不再记录，重启不提示恢复', { timeout: 180_000 }, async () => {
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
      // 2026-11-26：清理入口在左侧导航的「隐私、搜索和服务」（照 Edge 的分法，真分区）。
      await waitFor(async () => inSettings(first.app, `(() => {
        const nav = [...document.querySelectorAll('.settings-nav button')].find((el) => el.textContent.trim() === '隐私、搜索和服务')
        if (!nav) return false
        nav.click()
        return true
      })()`), { message: '设置页没有「隐私、搜索和服务」分区入口' })
      const hasDataSection = await inSettings(first.app, `(() => {
        const button = document.querySelector('button[aria-label="清除已保存的会话"]')
        const section = document.getElementById('privacy-title')?.closest('.setting-section')
        return Boolean(button && section && !section.hidden)
      })()`)
      assert.equal(hasDataSection, true, '「隐私、搜索和服务」应包含「清除已保存的会话」按钮')

      const clicked = await inSettings(first.app, `(() => {
        const button = document.querySelector('button[aria-label="清除已保存的会话"]')
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
test('设置页「引擎 → 清除站点引擎规则」：规则真的删掉，新标签回到默认来源', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({ '/site': page('规则站点') })
  const profilePath = await mkdtemp(join(tmpdir(), 'bao-next-rules-'))
  try {
    const first = await launchAppAt(profilePath)
    try {
      const address = first.shell.getByRole('textbox', { name: '地址栏' })
      await address.fill(`${server.baseUrl}/site`)
      await address.press('Enter')
      await first.shell.getByRole('button', { name: '规则站点', exact: true }).waitFor()

      // 造一条真实规则：切到 Ruffle 再「记住当前引擎」。
      assert.equal((await first.shell.evaluate(() =>
        window.baoBrowser.run({ type: 'set-engine', engine: 'ruffle' }))).ok, true)
      await waitFor(async () => {
        const state = await snapshot(first.shell)
        const tab = state.tabs.find((item) => item.address.endsWith('/site'))
        return tab && tab.engine === 'ruffle' && !tab.loading ? state : null
      }, { message: '标签没有切到 Ruffle' })
      assert.equal((await first.shell.evaluate(() =>
        window.baoBrowser.run({ type: 'remember-engine' }))).ok, true)
      const remembered = await waitFor(async () => {
        const state = await snapshot(first.shell)
        const tab = state.tabs.find((item) => item.address.endsWith('/site'))
        return tab && tab.engineSource === 'site-rule' ? state : null
      }, { message: '站点规则没有生效' })
      assert.equal(remembered.tabs.find((tab) => tab.address.endsWith('/site')).pinnedEngine, 'ruffle')
      assert.equal(inspect(profilePath, 'SELECT host, engine FROM engine_rules').length, 1, '规则应落库')

      // 设置页里点「清除站点引擎规则」（在「引擎」分区，与 Flash 卡片同一处）。
      await pressShortcut(first.app, ',', ['control'])
      await waitFor(async () => inSettings(first.app, `(() => {
        const nav = [...document.querySelectorAll('.settings-nav button')].find((el) => el.textContent.trim() === '引擎')
        if (!nav) return false
        nav.click()
        return true
      })()`), { message: '设置页没有「引擎」分区入口' })
      // 列表要真的把这一个站点渲染出来（host + 引擎 + 单条忘记），不只是"一个按钮"。
      const listed = await waitFor(async () => {
        const value = await inSettings(first.app, `(() => {
          const row = document.querySelector('.rule-row')
          if (!row) return null
          return {
            host: row.querySelector('.rule-host')?.textContent?.trim() ?? '',
            engine: row.querySelector('.rule-engine')?.textContent?.trim() ?? '',
            forget: row.querySelector('button.action')?.getAttribute('aria-label') ?? '',
            count: document.querySelectorAll('.rule-row').length
          }
        })()`)
        return value && value.host ? value : null
      }, { message: '设置页没有列出已记住的站点' })
      assert.equal(listed.count, 1, '应只列出一条规则')
      assert.equal(listed.host, '127.0.0.1', '规则的 host 不对')
      assert.equal(listed.engine, 'Ruffle', '规则应显示它记住的引擎')
      assert.equal(listed.forget, '忘记 127.0.0.1 的引擎规则', '每行都要有单条忘记按钮')

      // 规则可能很多（每站点一条）：列表必须自身封顶滚动，不能把整页拉长；
      // 少量规则时不要多一个过滤框（阈值 8，见 RULE_FILTER_THRESHOLD）。
      const layout = await inSettings(first.app, `(() => {
        const list = document.querySelector('.rule-list')
        if (!list) return null
        const style = getComputedStyle(list)
        return {
          maxHeight: style.maxHeight,
          overflowY: style.overflowY,
          filter: Boolean(document.querySelector('.rule-filter'))
        }
      })()`)
      assert.equal(layout.maxHeight, '264px', '规则列表必须封顶，否则几百条会把页面拉到几千像素')
      assert.equal(layout.overflowY, 'auto', '规则列表应自身滚动')
      assert.equal(layout.filter, false, '只有一条规则时不该出现过滤框')

      const clicked = await waitFor(async () => {
        const value = await inSettings(first.app, `(() => {
          const button = document.querySelector('button[aria-label="清除站点引擎规则"]')
          if (!button) return ''
          button.click()
          return 'clicked'
        })()`)
        return value === 'clicked' ? value : null
      }, { message: '没有找到「清除站点引擎规则」按钮' })
      assert.equal(clicked, 'clicked')

      const notice = await waitFor(() => inSettings(first.app, `(() => {
        const status = [...document.querySelectorAll('[role="status"]')].map((item) => item.textContent).join(' ')
        return status.includes('已清除站点引擎规则') ? status : ''
      })()`), { message: '设置页没有显示规则清理结果' })

      // 真库：规则表被清空。
      assert.deepEqual(inspect(profilePath, 'SELECT host FROM engine_rules'), [], '规则表应被清空')

      // 已打开的标签不重载，但来源不再是站点规则；新标签回到默认来源。
      const after = await snapshot(first.shell)
      const site = after.tabs.find((tab) => tab.address.endsWith('/site'))
      assert.equal(site.engine, 'ruffle', '已打开的标签不应被重载/换引擎')
      assert.equal(site.engineSource, 'default', '清除后来源应回到默认')
      assert.equal(site.pinnedEngine, undefined, '不应再有「已记住」标记')

      const reuse = await first.shell.evaluate((url) => window.baoBrowser.run({ type: 'navigate', address: url }), `${server.baseUrl}/site`)
      assert.equal(reuse.ok, true)
      await waitFor(async () => {
        const state = await snapshot(first.shell)
        const tab = state.tabs.find((item) => item.address.endsWith('/site') && !item.loading)
        return tab ? state : null
      }, { message: '再次导航没有完成' })
      assert.equal((await snapshot(first.shell)).tabs.some((tab) => tab.engineSource === 'site-rule'), false,
        '清除后不应再有站点规则来源')
    } finally {
      await first.close()
    }

    // 规则是真的删掉了：重启后依然是空的。
    assert.deepEqual(inspect(profilePath, 'SELECT host FROM engine_rules'), [], '重启后规则仍应为空')
    const second = await launchAppAt(profilePath)
    try {
      assert.equal((await snapshot(second.shell)).settings.sessionStartup !== undefined, true)
      assert.deepEqual(inspect(profilePath, 'SELECT host FROM engine_rules'), [])
    } finally {
      await second.close()
    }
  } finally {
    await rm(profilePath, { recursive: true, force: true, maxRetries: 3 })
    await server.close()
  }
})

test('设置页「引擎 → 单条忘记」：只删这一条，已打开的标签不重载', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({ '/site': page('单条规则站点') })
  const profilePath = await mkdtemp(join(tmpdir(), 'bao-next-rule-forget-'))
  try {
    const first = await launchAppAt(profilePath)
    try {
      const address = first.shell.getByRole('textbox', { name: '地址栏' })
      await address.fill(`${server.baseUrl}/site`)
      await address.press('Enter')
      await first.shell.getByRole('button', { name: '单条规则站点', exact: true }).waitFor()

      assert.equal((await first.shell.evaluate(() =>
        window.baoBrowser.run({ type: 'set-engine', engine: 'ruffle' }))).ok, true)
      await waitFor(async () => {
        const state = await snapshot(first.shell)
        const tab = state.tabs.find((item) => item.address.endsWith('/site'))
        return tab && tab.engine === 'ruffle' && !tab.loading ? state : null
      }, { message: '标签没有切到 Ruffle' })
      assert.equal((await first.shell.evaluate(() =>
        window.baoBrowser.run({ type: 'remember-engine' }))).ok, true)
      await waitFor(async () => {
        const state = await snapshot(first.shell)
        return state.tabs.some((tab) => tab.engineSource === 'site-rule') ? state : null
      }, { message: '站点规则没有生效' })

      // 打开设置 → 引擎分区 → 点这一行的「忘记」。
      await pressShortcut(first.app, ',', ['control'])
      await waitFor(async () => inSettings(first.app, `(() => {
        const nav = [...document.querySelectorAll('.settings-nav button')].find((el) => el.textContent.trim() === '引擎')
        if (!nav) return false
        nav.click()
        return true
      })()`), { message: '设置页没有「引擎」分区入口' })
      const clicked = await waitFor(async () => {
        const value = await inSettings(first.app, `(() => {
          const button = document.querySelector('.rule-row button.action')
          if (!button) return ''
          const label = button.getAttribute('aria-label') ?? 'clicked'
          button.click()
          return label
        })()`)
        return value ? value : null
      }, { message: '没有找到单条「忘记」按钮' })
      assert.equal(clicked, '忘记 127.0.0.1 的引擎规则')

      const notice = await waitFor(() => inSettings(first.app, `(() => {
        const status = [...document.querySelectorAll('[role="status"]')].map((item) => item.textContent).join(' ')
        return status.includes('已忘记') ? status : ''
      })()`), { message: '设置页没有显示「已忘记」的结果' })
      assert.match(notice, /已忘记 127\.0\.0\.1/)

      // 真库为空；列表回到空状态；已打开的标签不重载、来源回到默认。
      assert.deepEqual(inspect(profilePath, 'SELECT host FROM engine_rules'), [], '规则表应被清空')
      const empty = await waitFor(async () => {
        const value = await inSettings(first.app, `(() => ({
          rows: document.querySelectorAll('.rule-row').length,
          empty: (document.querySelector('#rules-title')?.closest('.setting-section')?.innerText ?? '').includes('还没有记住的站点')
        }))()`)
        return value.rows === 0 && value.empty ? value : null
      }, { message: '忘掉最后一条后应回到空状态' })
      assert.equal(empty.rows, 0)
      const site = (await snapshot(first.shell)).tabs.find((tab) => tab.address.endsWith('/site'))
      assert.equal(site.engine, 'ruffle', '已打开的标签不应被重载')
      assert.equal(site.engineSource, 'default', '来源应回到默认')
    } finally {
      await first.close()
    }
    assert.deepEqual(inspect(profilePath, 'SELECT host FROM engine_rules'), [], '重启后规则仍应为空')
  } finally {
    await rm(profilePath, { recursive: true, force: true, maxRetries: 3 })
    await server.close()
  }
})
