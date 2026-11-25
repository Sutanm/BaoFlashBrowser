const assert = require('node:assert/strict')
const { test } = require('node:test')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { audioStateOf, launchAppAt, page, startFixtureServer, waitFor } = require('./helpers.cjs')

/**
 * 崩溃恢复（Chrome 的「恢复页面」语义，M2）：
 *
 * - **正常退出后重启不恢复**：一律是新标签页，也没有任何提示；
 * - **异常退出后重启只提示、不恢复**：外壳顶部出现提示条，用户点「恢复标签页」才重建；
 * - 恢复出来的标签保留置顶、引擎、静音与「保持活跃」，后台标签仍是休眠状态。
 *
 * 存储层（schema v2、退出标记、坏载荷容错）在 `tests/data/session-store.test.cjs`，
 * 载荷校验在 `tests/unit/session.test.ts`。
 */

const snapshot = (shell) => shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' })).then((result) => result.state)

const tabByTitle = (state, title) => state.tabs.find((tab) => tab.title === title)

/** 打开一个新标签并导航过去，等它加载完成。 */
async function openPage(shell, url, title) {
  await shell.evaluate(() => window.baoBrowser.run({ type: 'add' }))
  await shell.evaluate((address) => window.baoBrowser.run({ type: 'navigate', address }), url)
  return waitFor(async () => {
    const tab = tabByTitle(await snapshot(shell), title)
    return tab && !tab.loading ? tab : null
  }, { message: `标签 ${title} 没有加载完` })
}

/**
 * 等会话真的落盘（节流写 800 ms），再硬杀才有意义。
 *
 * `match` 必须描述**完整的期望状态**（地址 + 引擎 + 保持活跃）：载荷可能是几次写入前
 * 的中间版本，只等地址就会在标记生效之前把进程杀掉。
 */
async function waitForSession(profilePath, match) {
  return waitFor(() => {
    const db = new DatabaseSync(join(profilePath, 'db', 'browser.sqlite3'))
    try {
      const rows = db.prepare('SELECT payload FROM session WHERE id = 0').all()
      if (rows.length !== 1) return false
      const payload = JSON.parse(rows[0].payload)
      return payload.windows.flatMap((window) => window.tabs).some((tab) => match(tab))
    } catch {
      return false
    } finally {
      db.close()
    }
  }, { message: '会话没有按期望落盘' })
}

async function withProfile(work) {
  const profilePath = await mkdtemp(join(tmpdir(), 'bao-next-session-'))
  try {
    return await work(profilePath)
  } finally {
    await rm(profilePath, { recursive: true, force: true, maxRetries: 3 })
  }
}

/** 打开 A（置顶）与 B（Ruffle + 保持活跃，活动标签），返回它们的 id。 */
async function prepareTabs(shell, baseUrl) {
  const tabA = await openPage(shell, `${baseUrl}/a`, 'A')
  assert.equal((await shell.evaluate((id) => window.baoBrowser.run({ type: 'pin', id }), tabA.id)).ok, true)

  const tabB = await openPage(shell, `${baseUrl}/b`, 'B')
  assert.equal((await shell.evaluate((id) => window.baoBrowser.run({ type: 'keep-awake', id, value: true }), tabB.id)).ok, true)
  const switched = await shell.evaluate(() => window.baoBrowser.run({ type: 'set-engine', engine: 'ruffle' }))
  assert.equal(switched.ok, true, `切换引擎失败：${switched.code}`)
  await waitFor(async () => {
    const tab = (await snapshot(shell)).tabs.find((item) => item.id === tabB.id)
    return tab && tab.engine === 'ruffle' && tab.engineSource === 'manual' && !tab.loading ? tab : null
  }, { message: '标签 B 没有切到 Ruffle' })
  return { tabA, tabB }
}

test('正常退出后重启：不恢复标签，也没有恢复提示', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({ '/a': page('A'), '/b': page('B') })
  try {
    await withProfile(async (profilePath) => {
      const first = await launchAppAt(profilePath)
      try {
        const { tabB } = await prepareTabs(first.shell, server.baseUrl)
        assert.equal((await snapshot(first.shell)).activeId, tabB.id)
      } finally {
        await first.close()
      }

      const second = await launchAppAt(profilePath)
      try {
        const state = await snapshot(second.shell)
        assert.equal(state.sessionPrompt, undefined, '正常退出后重启不应有恢复提示')
        assert.equal(state.tabs.length, 1, '正常退出后重启只有一个新标签页')
        assert.equal(state.tabs[0].internal, 'newtab')
        assert.equal(await second.shell.locator('.session-infobar').count(), 0, '界面上不应出现提示条')
      } finally {
        await second.close()
      }
    })
  } finally {
    await server.close()
  }
})

test('设置 session.startup=continue 后：正常退出重启直接恢复标签，没有提示条', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({ '/a': page('A'), '/b': page('B') })
  try {
    await withProfile(async (profilePath) => {
      const first = await launchAppAt(profilePath)
      try {
        const setting = await first.shell.evaluate(() =>
          window.baoBrowser.run({ type: 'set-setting', key: 'session.startup', value: 'continue' }))
        assert.equal(setting.ok, true, `设置写入失败：${setting.code}`)
        const { tabB } = await prepareTabs(first.shell, server.baseUrl)
        assert.equal((await snapshot(first.shell)).activeId, tabB.id)
      } finally {
        await first.close()
      }

      const second = await launchAppAt(profilePath)
      try {
        // 用户选了「继续上次会话」：正常退出也要恢复，而且不再问一遍。
        const state = await waitFor(async () => {
          const current = await snapshot(second.shell)
          const b = tabByTitle(current, 'B')
          return b && !b.loading ? current : null
        }, { message: 'continue 模式下没有恢复上次标签' })
        assert.equal(state.sessionPrompt, undefined, 'continue 模式不应再提示')
        assert.equal(await second.shell.locator('.session-infobar').count(), 0)
        assert.equal(state.settings.sessionStartup, 'continue', '重启后设置应保留')

        const a = tabByTitle(state, 'A')
        assert.equal(a.pinned, true, '置顶状态应恢复')
        assert.equal(a.discarded, true, '非活动标签以休眠状态恢复')
        assert.equal(tabByTitle(state, 'B').keepAwake, true, '保持活跃应恢复')
        assert.equal(state.tabs[0].title, 'A', '固定标签恢复后仍应在最左')
      } finally {
        await second.close()
      }
    })
  } finally {
    await server.close()
  }
})

test('异常退出后重启：只提示不恢复，点「恢复标签页」才重建并保留置顶/引擎/保持活跃', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({ '/a': page('A'), '/b': page('B') })
  try {
    await withProfile(async (profilePath) => {
      const first = await launchAppAt(profilePath)
      try {
        await prepareTabs(first.shell, server.baseUrl)
        await waitForSession(profilePath, (tab) =>
          tab.url === `${server.baseUrl}/b` && tab.keepAwake === true && tab.engine === 'ruffle')
        // 硬杀：不给 before-quit 写「正常退出」标记的机会。
        first.app.process().kill('SIGKILL')
        await new Promise((done) => setTimeout(done, 800))
      } finally {
        await first.close()
      }

      const second = await launchAppAt(profilePath)
      try {
        // 先把状态投影拿到手（提示必须在，标签必须没恢复）。
        const pending = await waitFor(async () => {
          const state = await snapshot(second.shell)
          return state.sessionPrompt ? state : null
        }, { message: '异常退出后重启没有出现恢复提示' })
        assert.equal(pending.tabs.length, 1, '提示期间不能自动恢复标签')
        assert.equal(pending.tabs[0].internal, 'newtab')
        assert.ok(pending.sessionPrompt.tabs >= 2, '提示应报出可恢复的标签数')

        const infobar = second.shell.locator('.session-infobar')
        await infobar.waitFor({ timeout: 10_000 })
        assert.match(await infobar.innerText(), /上次未正常退出/)

        // 用户选择恢复。
        await second.shell.getByRole('button', { name: '恢复标签页' }).click()
        const restored = await waitFor(async () => {
          const state = await snapshot(second.shell)
          const b = tabByTitle(state, 'B')
          return state.sessionPrompt === undefined && b && !b.loading ? state : null
        }, { message: '点「恢复标签页」后没有重建标签' })
        assert.equal(await second.shell.locator('.session-infobar').count(), 0, '回答后提示条应消失')

        const a = tabByTitle(restored, 'A')
        assert.ok(a, '应恢复标签 A')
        assert.equal(a.pinned, true, '置顶状态应恢复')
        assert.equal(a.discarded, true, '非活动标签以休眠状态恢复')

        const b = tabByTitle(restored, 'B')
        assert.ok(b, '应恢复标签 B')
        assert.equal(b.keepAwake, true, '「保持活跃」应恢复（user 租约被重建）')
        assert.equal(b.engine, 'ruffle', '引擎选择应恢复')
        assert.equal(b.engineSource, 'manual', '手动切换来源应恢复')
        assert.equal(b.discarded, undefined, '会话里的活动标签应立即加载')
        assert.equal(restored.tabs[0].title, 'A', '固定标签恢复后仍应在最左')
      } finally {
        await second.close()
      }

      // 本次正常退出：下次启动不再提示。
      const third = await launchAppAt(profilePath)
      try {
        const state = await snapshot(third.shell)
        assert.equal(state.sessionPrompt, undefined, '已经恢复过的会话不应再次提示')
        assert.equal(state.tabs.length, 1)
      } finally {
        await third.close()
      }
    })
  } finally {
    await server.close()
  }
})

/**
 * 静音标签的会话恢复：
 *
 * `createRestoredTab()` 只恢复元数据、不建视图，活动标签随后由 `select()` → `revive()`
 * 重建。回归点是「休眠/恢复会换一个新的 WebContents」，所以静音必须在重建时重新应用；
 * 这里直接读实际 WebContents 的 `isAudioMuted()`，不只看外壳快照里的 `muted`。
 */
test('静音标签保存后重启恢复：恢复出的 WebContents 实际静音', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({ '/m': page('M') })
  try {
    await withProfile(async (profilePath) => {
      const url = `${server.baseUrl}/m`
      const first = await launchAppAt(profilePath)
      try {
        const tab = await openPage(first.shell, url, 'M')
        assert.equal((await first.shell.evaluate((id) => window.baoBrowser.run({ type: 'mute', id }), tab.id)).ok, true)
        await waitFor(async () => ((await audioStateOf(first.app, url))?.muted ? true : null),
          { message: '静音没有作用到实际的 WebContents' })
        // 会话里必须已经记下 muted=true，否则重启后测的是别的路径。
        await waitForSession(profilePath, (entry) => entry.url === url && entry.muted === true)
        first.app.process().kill('SIGKILL')
        await new Promise((done) => setTimeout(done, 800))
      } finally {
        await first.close()
      }

      const second = await launchAppAt(profilePath)
      try {
        await second.shell.locator('.session-infobar').waitFor({ timeout: 10_000 })
        await second.shell.getByRole('button', { name: '恢复标签页' }).click()
        const restored = await waitFor(async () => {
          const tab = tabByTitle(await snapshot(second.shell), 'M')
          return tab && !tab.loading && !tab.discarded ? tab : null
        }, { message: '点「恢复标签页」后没有重建标签 M' })
        assert.equal(restored.muted, true, '会话里的静音状态应恢复')

        const actual = await waitFor(async () => {
          const entry = await audioStateOf(second.app, url)
          return entry && !entry.destroyed ? entry : null
        }, { message: '恢复后找不到该地址的 WebContents' })
        assert.equal(actual.muted, true, '恢复后的 WebContents 必须实际静音')
      } finally {
        await second.close()
      }
    })
  } finally {
    await server.close()
  }
})

test('异常退出后点「忽略」：不恢复标签，且下次启动不再提示', { timeout: 180_000 }, async () => {
  const server = await startFixtureServer({ '/a': page('A'), '/b': page('B') })
  try {
    await withProfile(async (profilePath) => {
      const first = await launchAppAt(profilePath)
      try {
        await prepareTabs(first.shell, server.baseUrl)
        await waitForSession(profilePath, (tab) =>
          tab.url === `${server.baseUrl}/b` && tab.keepAwake === true && tab.engine === 'ruffle')
        first.app.process().kill('SIGKILL')
        await new Promise((done) => setTimeout(done, 800))
      } finally {
        await first.close()
      }

      const second = await launchAppAt(profilePath)
      try {
        await second.shell.locator('.session-infobar').waitFor({ timeout: 10_000 })
        await second.shell.getByRole('button', { name: '忽略' }).click()
        const state = await waitFor(async () => {
          const current = await snapshot(second.shell)
          return current.sessionPrompt === undefined ? current : null
        }, { message: '点「忽略」后提示没有消失' })
        assert.equal(state.tabs.length, 1, '忽略时不应恢复任何标签')
        assert.equal(state.tabs[0].internal, 'newtab')
      } finally {
        await second.close()
      }

      const third = await launchAppAt(profilePath)
      try {
        const state = await snapshot(third.shell)
        assert.equal(state.sessionPrompt, undefined, '忽略过的会话不应再次提示')
        assert.equal(state.tabs.length, 1)
      } finally {
        await third.close()
      }
    })
  } finally {
    await server.close()
  }
})
