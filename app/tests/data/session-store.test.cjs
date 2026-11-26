const assert = require('node:assert/strict')
const { test } = require('node:test')
const { once } = require('node:events')
const { createServer } = require('node:http')
const { existsSync, readdirSync } = require('node:fs')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { _electron: electron } = require('playwright')

/**
 * 会话存储合同（M2 会话恢复，schema v2）。
 *
 * 和 `settings-store.test.cjs` 同一套原则：用真库、真进程边界。
 * 这里只验证**存储层**：v1→v2 迁移、会话载荷往返、坏载荷不阻断启动。
 * 标签恢复的端到端行为在 `tests/smoke/session-restore.test.cjs`。
 */

function executablePath() {
  delete process.env.ELECTRON_RUN_AS_NODE
  const path = process.env.ELECTRON_EXEC_PATH
  assert.ok(path && require('node:path').isAbsolute(path), '请设置 ELECTRON_EXEC_PATH 为自编译 Electron 的绝对路径。')
  return path
}

const isShellPage = (page) => page.url().endsWith('/out/renderer/index.html')

async function launch(profilePath) {
  const app = await electron.launch({
    executablePath: executablePath(),
    args: [resolve(__dirname, '../..'), `--user-data-dir=${profilePath}`],
    timeout: 20_000
  })
  const shell = app.windows().find(isShellPage) ??
    await app.waitForEvent('window', { predicate: isShellPage, timeout: 10_000 })
  shell.setDefaultTimeout(10_000)
  return {
    app,
    shell,
    run: (command) => shell.evaluate((value) => window.baoBrowser.run(value), command),
    state: async () => {
      const result = await shell.evaluate(() => window.baoBrowser.run({ type: 'snapshot' }))
      assert.equal(result.ok, true, `snapshot 失败：${result.code}`)
      return result.state
    },
    async close() {
      await app.close().catch(() => {})
    },
    /** 模拟异常退出：硬杀进程，不给 `before-quit` 写 `clean` 的机会。 */
    async kill() {
      const child = app.process()
      child.kill('SIGKILL')
      await new Promise((done) => setTimeout(done, 800))
      await app.close().catch(() => {})
    }
  }
}

const dbFile = (profilePath) => join(profilePath, 'db', 'browser.sqlite3')

function inspect(profilePath, sql, ...params) {
  const db = new DatabaseSync(dbFile(profilePath))
  try {
    return db.prepare(sql).all(...params)
  } finally {
    db.close()
  }
}

function exec(profilePath, sql, ...params) {
  const db = new DatabaseSync(dbFile(profilePath))
  try {
    db.prepare(sql).run(...params)
  } finally {
    db.close()
  }
}

async function withProfile(work) {
  const profilePath = await mkdtemp(join(tmpdir(), 'bao-next-session-data-'))
  try {
    return await work(profilePath)
  } finally {
    await rm(profilePath, { recursive: true, force: true, maxRetries: 3 })
  }
}

/** 本地样本页：会话载荷里要有一个真实加载成功的 http 地址，DNS 超时会污染断言。 */
async function startServer() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><meta charset="utf-8"><title>会话样本</title><h1>session</h1>')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done))
  }
}

async function waitFor(predicate, { timeout = 15_000, message = '条件未在超时内满足。' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await Promise.resolve().then(predicate).catch(() => undefined)
    if (value) return value
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((done) => setTimeout(done, 100))
  }
}

/** 手写一份 v1 库（设置 + 规则 + 迁移标记），模拟升级前的用户数据。 */
async function writeV1Database(profilePath) {
  const { mkdir } = require('node:fs/promises')
  await mkdir(join(profilePath, 'db'), { recursive: true })
  const db = new DatabaseSync(dbFile(profilePath))
  try {
    db.exec(`
      CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE engine_rules(
        host TEXT PRIMARY KEY,
        engine TEXT NOT NULL CHECK (engine IN ('ppapi', 'ruffle')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
    db.prepare('INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?)').run('theme.mode', 'dark', 1)
    db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run('migration.engine-rules@1', '0')
    db.prepare('INSERT INTO engine_rules(host, engine, created_at, updated_at) VALUES(?, ?, ?, ?)')
      .run('flash.example.com', 'ruffle', 1, 1)
    db.exec('PRAGMA user_version = 1')
  } finally {
    db.close()
  }
}

test('v1 库升级到 v2：建立 session 表、保留旧数据、生成迁移前备份', { timeout: 120_000 }, async () => {
  await withProfile(async (profilePath) => {
    await writeV1Database(profilePath)

    const app = await launch(profilePath)
    try {
      assert.equal((await app.state()).settings.themeMode, 'dark', '升级不能丢用户设置')
    } finally {
      await app.close()
    }

    assert.equal(inspect(profilePath, 'PRAGMA user_version')[0].user_version, 3, '库版本应升到当前 schema（v3 = 收藏夹树）')
    const tables = inspect(profilePath, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .map((row) => row.name)
    assert.ok(tables.includes('session'), '升级后必须有 session 表')
    assert.ok(tables.includes('settings') && tables.includes('engine_rules'), '旧表不能被重建掉')

    assert.deepEqual(
      inspect(profilePath, 'SELECT host, engine FROM engine_rules').map((row) => [row.host, row.engine]),
      [['flash.example.com', 'ruffle']], '旧规则应保留')

    const backups = readdirSync(join(profilePath, 'db', 'backups'))
    assert.equal(backups.length, 1, '升级前必须留一份快照')
    assert.match(backups[0], /^browser-v1-.*\.sqlite3$/)

    // 已有的迁移标记不能被升级清掉（否则遗留 rules 文件会被重复导入）。
    assert.equal(
      inspect(profilePath, 'SELECT value FROM meta WHERE key = ?', 'migration.engine-rules@1').length, 1,
      '升级不应影响遗留规则导入的幂等标记')
  })
})

test('会话载荷写入真库；坏载荷不阻断启动且会被重写成合法载荷', { timeout: 120_000 }, async () => {
  const server = await startServer()
  const target = `${server.baseUrl}/game`
  try {
    await withProfile(async (profilePath) => {
      const first = await launch(profilePath)
      try {
        assert.equal((await first.run({ type: 'add' })).ok, true)
        const navigated = await first.run({ type: 'navigate', address: target })
        assert.equal(navigated.ok, true, `导航命令失败：${navigated.code}`)
        await waitFor(async () => (await first.state()).tabs.some((tab) => tab.address === target && !tab.loading),
          { message: '标签没有加载到目标地址' })
      } finally {
        await first.close()
      }

      assert.equal(existsSync(dbFile(profilePath)), true)
      const rows = inspect(profilePath, 'SELECT payload, updated_at FROM session WHERE id = 0')
      assert.equal(rows.length, 1, '退出后必须有一行会话载荷')
      assert.ok(rows[0].updated_at > 0)

      const payload = JSON.parse(rows[0].payload)
      assert.equal(payload.version, 1, '载荷版本必须是 1')
      assert.ok(Array.isArray(payload.windows) && payload.windows.length >= 1, '至少记录一个窗口')
      const tabs = payload.windows.flatMap((window) => window.tabs)
      assert.ok(tabs.some((tab) => tab.url === target), '会话里应有打开的网页标签')
      assert.ok(tabs.some((tab) => tab.internal === 'newtab'), '新标签页也应被记录')
      assert.ok(tabs.some((tab) => tab.active === true), '至少要有一个活动标签')
      for (const tab of tabs) {
        assert.ok(!('internal' in tab) || tab.internal === 'newtab', '设置页等内部页不落盘')
      }

      // 正常退出后重启：**不恢复**，只有一个新标签页、没有崩溃提示。
      assert.deepEqual(
        inspect(profilePath, 'SELECT value FROM meta WHERE key = ?', 'session.last-exit').map((row) => row.value),
        ['clean'], '正常退出必须把标记写成 clean')

      const second = await launch(profilePath)
      try {
        const state = await second.state()
        assert.equal(state.tabs.length, 1, '正常退出后重启不应恢复标签')
        assert.equal(state.tabs[0].internal, 'newtab')
        assert.equal(state.sessionPrompt, undefined, '正常退出后重启不应提示恢复')
      } finally {
        await second.close()
      }

      // 手动改坏载荷：启动必须照常，而且下一次退出会写回合法载荷。
      exec(profilePath, 'UPDATE session SET payload = ? WHERE id = 0', '{ 这不是 JSON')

      const third = await launch(profilePath)
      try {
        const state = await third.state()
        assert.equal(state.tabs.length, 1, '坏会话应按"没有会话"处理，只开一个新标签页')
        assert.equal(state.tabs[0].internal, 'newtab')
      } finally {
        await third.close()
      }

      const repaired = inspect(profilePath, 'SELECT payload FROM session WHERE id = 0')
      assert.equal(repaired.length, 1)
      assert.doesNotThrow(() => JSON.parse(repaired[0].payload), '下一次退出必须写回合法载荷')
    })
  } finally {
    await server.close()
  }
})

test('session.startup=continue：正常退出后重启直接恢复上次标签，不再提示', { timeout: 120_000 }, async () => {
  const server = await startServer()
  const target = `${server.baseUrl}/continue`
  try {
    await withProfile(async (profilePath) => {
      const first = await launch(profilePath)
      try {
        const setting = await first.run({ type: 'set-setting', key: 'session.startup', value: 'continue' })
        assert.equal(setting.ok, true, `设置写入失败：${setting.code}`)
        assert.equal(setting.state.settings.sessionStartup, 'continue', '写回的快照应立刻反映新值')
        assert.equal((await first.run({ type: 'add' })).ok, true)
        assert.equal((await first.run({ type: 'navigate', address: target })).ok, true)
        await waitFor(async () => (await first.state()).tabs.some((tab) => tab.address === target && !tab.loading),
          { message: '标签没有加载到目标地址' })
      } finally {
        await first.close()
      }

      assert.deepEqual(
        inspect(profilePath, "SELECT value FROM settings WHERE key = 'session.startup'").map((row) => row.value),
        ['continue'], '设置必须落库')

      const second = await launch(profilePath)
      try {
        // 正常退出（标记是 clean），但用户选了「继续上次会话」：直接恢复，不提示。
        const state = await waitFor(async () => {
          const current = await second.state()
          const tab = current.tabs.find((item) => item.address === target)
          return tab && !tab.loading ? current : null
        }, { message: 'continue 模式下没有恢复上次标签' })
        assert.equal(state.sessionPrompt, undefined, 'continue 模式是用户主动选择，不需要再提示')
        assert.equal(state.settings.sessionStartup, 'continue', '重启后设置应保留')
      } finally {
        await second.close()
      }
    })
  } finally {
    await server.close()
  }
})

test('异常退出（硬杀）后重启：只提示不恢复，用户点「恢复」才重建标签', { timeout: 120_000 }, async () => {
  const server = await startServer()
  const target = `${server.baseUrl}/crash`
  try {
    await withProfile(async (profilePath) => {
      const first = await launch(profilePath)
      try {
        assert.equal((await first.run({ type: 'add' })).ok, true)
        assert.equal((await first.run({ type: 'navigate', address: target })).ok, true)
        await waitFor(async () => (await first.state()).tabs.some((tab) => tab.address === target && !tab.loading),
          { message: '标签没有加载到目标地址' })
        // 崩溃前必须已经有会话落盘：节流写 800 ms，这里读库确认后再硬杀。
        await waitFor(() => {
          const rows = inspect(profilePath, 'SELECT payload FROM session WHERE id = 0')
          if (rows.length !== 1) return false
          const payload = JSON.parse(rows[0].payload)
          return payload.windows.flatMap((window) => window.tabs).some((tab) => tab.url === target)
        }, { message: '硬杀之前会话没有落盘' })
        await first.kill()
      } finally {
        await first.close()
      }

      // 硬杀来不及写 clean：标记停在 crash。
      assert.deepEqual(
        inspect(profilePath, 'SELECT value FROM meta WHERE key = ?', 'session.last-exit').map((row) => row.value),
        ['crash'], '硬杀后标记必须停在 crash')

      const second = await launch(profilePath)
      try {
        const state = await second.state()
        // 关键合同：先不恢复，只给提示。
        assert.equal(state.tabs.length, 1, '崩溃后重启不能自动恢复标签')
        assert.equal(state.tabs[0].internal, 'newtab')
        assert.ok(state.sessionPrompt, '崩溃后重启必须出现恢复提示')
        assert.equal(state.sessionPrompt.tabs, 2, '提示里应报出可恢复的标签数（网页 + 新标签页）')

        const restored = await second.run({ type: 'restore-session' })
        assert.equal(restored.ok, true, `恢复命令失败：${restored.code}`)
        assert.equal(restored.state.sessionPrompt, undefined, '用户回答后提示必须消失')
        // 恢复会触发加载：等标签真正到目标地址再断言（与用户看到的效果一致）。
        const revived = await waitFor(async () => {
          const state = await second.state()
          const tab = state.tabs.find((item) => item.address === target)
          return tab && !tab.loading ? state : null
        }, { message: '恢复后应回到崩溃前的标签' })
        assert.equal(revived.tabs.filter((tab) => tab.internal === 'newtab').length, 1,
          '空白新标签页应被恢复覆盖，而不是多留一个')

        // 已经回答过一次：重复调用必须返回稳定错误码，而不是再恢复一遍。
        assert.equal((await second.run({ type: 'restore-session' })).code, 'no-session')
      } finally {
        await second.close()
      }

      // 本次正常退出：标记回到 clean，下次启动不再提示。
      assert.deepEqual(
        inspect(profilePath, 'SELECT value FROM meta WHERE key = ?', 'session.last-exit').map((row) => row.value),
        ['clean'])

      const third = await launch(profilePath)
      try {
        const state = await third.state()
        assert.equal(state.sessionPrompt, undefined, '正常退出后重启不应再提示')
        assert.equal(state.tabs.length, 1, '正常退出后重启仍是新标签页')
      } finally {
        await third.close()
      }
    })
  } finally {
    await server.close()
  }
})
