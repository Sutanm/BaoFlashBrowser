const assert = require('node:assert/strict')
const { test } = require('node:test')
const { existsSync } = require('node:fs')
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { _electron: electron } = require('playwright')

/**
 * 存储合同（架构 §4 数据）的集成验证。
 *
 * 两条原则：
 * - **用真库**：读校验走系统 Node 的 `node:sqlite` 直接打开 `<profile>/db/browser.sqlite3`，
 *   不 mock、不读内存快照；
 * - **用真进程边界**：写路径只能通过外壳命令走主进程，跨重启/硬杀都用真进程验证。
 *
 * 与 `tests/smoke/` 的区别：这里用系统 Node 跑（`npm run test:data`），
 * 不需要 Playwright 驱动页面交互，只借用它启动真内核 + 临时 profile。
 */

function executablePath() {
  // 环境里若有 ELECTRON_RUN_AS_NODE，Electron 会以 Node 模式启动，主进程拿不到 app。
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
    theme: () => app.evaluate(({ nativeTheme }) => ({
      source: nativeTheme.themeSource,
      dark: nativeTheme.shouldUseDarkColors
    })),
    async close() {
      await app.close().catch(() => {})
    },
    async kill() {
      const child = app.process()
      child.kill('SIGKILL')
      await new Promise((done) => setTimeout(done, 800))
      await app.close().catch(() => {})
    }
  }
}

function profileFile(profilePath, ...rest) {
  return join(profilePath, 'db', ...rest)
}

/** 直接打开业务库（应用已关闭时才调用；WAL 会由 SQLite 自己恢复）。 */
function inspect(profilePath, sql, ...params) {
  const db = new DatabaseSync(profileFile(profilePath, 'browser.sqlite3'))
  try {
    return db.prepare(sql).all(...params)
  } finally {
    db.close()
  }
}

function dbExists(profilePath) {
  return existsSync(profileFile(profilePath, 'browser.sqlite3'))
}

async function withProfile(work) {
  const profilePath = await mkdtemp(join(tmpdir(), 'bao-next-data-'))
  try {
    return await work(profilePath)
  } finally {
    await rm(profilePath, { recursive: true, force: true, maxRetries: 3 })
  }
}

test('设置写入落库并跨重启保留（主题模式 + 默认引擎）', { timeout: 120_000 }, async () => {
  await withProfile(async (profilePath) => {
    const first = await launch(profilePath)
    try {
      assert.equal((await first.state()).settings.themeMode, 'system', '默认主题模式应为跟随系统')

      const saved = await first.run({ type: 'set-setting', key: 'theme.mode', value: 'dark' })
      assert.equal(saved.ok, true, `写入失败：${saved.code}`)
      assert.equal(saved.state.settings.themeMode, 'dark')
      assert.equal(saved.state.theme, 'dark', '写入后投影里的解析主题应同步变暗')

      const theme = await first.theme()
      assert.equal(theme.source, 'dark', 'nativeTheme.themeSource 应 1:1 跟随设置项')
      assert.equal(theme.dark, true)

      const engine = await first.run({ type: 'set-setting', key: 'engine.default', value: 'ruffle' })
      assert.equal(engine.ok, true)
    } finally {
      await first.close()
    }

    // 真库断言：一行一个键，值就是写的那个。
    const rows = inspect(profilePath, 'SELECT key, value FROM settings ORDER BY key')
    assert.deepEqual(
      rows.map((row) => [row.key, row.value]),
      [['engine.default', 'ruffle'], ['theme.mode', 'dark']]
    )

    const second = await launch(profilePath)
    try {
      const state = await second.state()
      assert.equal(state.settings.themeMode, 'dark', '重启后主题模式应保留')
      assert.equal(state.settings.defaultEngine, 'ruffle', '重启后默认引擎应保留')
      assert.equal(state.theme, 'dark')
      assert.equal((await second.theme()).source, 'dark')
    } finally {
      await second.close()
    }
  })
})

test('非法设置值被拒绝且不改变状态', { timeout: 120_000 }, async () => {
  await withProfile(async (profilePath) => {
    const app = await launch(profilePath)
    try {
      const before = await app.state()
      for (const command of [
        { type: 'set-setting', key: 'theme.mode', value: 'purple' },
        { type: 'set-setting', key: 'engine.default', value: 'gecko' },
        { type: 'set-setting', key: 'unknown.key', value: 'x' },
        { type: 'set-setting', key: 'theme.mode' }
      ]) {
        const result = await app.run(command)
        assert.equal(result.ok, false, `非法写入被执行了：${JSON.stringify(command)}`)
        assert.equal(result.code, 'invalid-setting')
      }
      const after = await app.state()
      assert.deepEqual(after.settings, before.settings, '非法写入不应改变任何设置')
      assert.equal((await app.theme()).source, before.settings.themeMode)
    } finally {
      await app.close()
    }

    assert.deepEqual(inspect(profilePath, 'SELECT key FROM settings'), [], '非法写入不应留下任何行')
  })
})

test('M1 的 engine-rules.json 一次性迁移：入表、归档、幂等', { timeout: 120_000 }, async () => {
  await withProfile(async (profilePath) => {
    const legacy = join(profilePath, 'engine-rules.json')
    await writeFile(legacy, JSON.stringify({ 'flash.example.com': 'ruffle', 'bad.example.com': 'nope' }), 'utf8')

    const first = await launch(profilePath)
    await first.close()

    assert.equal(existsSync(legacy), false, '迁移成功后原文件应被改名归档')
    assert.equal(existsSync(`${legacy}.migrated-1`), true, '归档文件必须保留（不删除用户数据）')

    const rules = inspect(profilePath, 'SELECT host, engine FROM engine_rules ORDER BY host')
    assert.deepEqual(rules.map((row) => [row.host, row.engine]), [['flash.example.com', 'ruffle']],
      '只导入合法规则，坏值丢弃')
    const marker = inspect(profilePath, 'SELECT key, value FROM meta WHERE key = ?', 'migration.engine-rules@1')
    assert.equal(marker.length, 1, '必须留下幂等标记')

    // 用户删掉规则后，JSON 还在也不能"复活"它——幂等锚点是库里的标记。
    const db = new DatabaseSync(profileFile(profilePath, 'browser.sqlite3'))
    db.prepare('DELETE FROM engine_rules WHERE host = ?').run('flash.example.com')
    db.close()

    const second = await launch(profilePath)
    await second.close()
    assert.deepEqual(inspect(profilePath, 'SELECT host FROM engine_rules'), [], '已删除的规则不应被重新导入')
  })
})

test('库里的坏设置值不影响启动，回落到默认值', { timeout: 120_000 }, async () => {
  await withProfile(async (profilePath) => {
    const first = await launch(profilePath)
    await first.close()

    const db = new DatabaseSync(profileFile(profilePath, 'browser.sqlite3'))
    db.prepare('INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('theme.mode', 'chartreuse', Date.now())
    db.prepare('INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('engine.default', 'netscape', Date.now())
    db.close()

    const second = await launch(profilePath)
    try {
      const state = await second.state()
      assert.equal(state.settings.themeMode, 'system', '坏值应回落到默认主题')
      assert.equal(state.settings.defaultEngine, 'ppapi', '坏值应回落到默认引擎')
    } finally {
      await second.close()
    }
  })
})

test('异常退出（硬杀）后写入的值仍完整，库自检通过', { timeout: 120_000 }, async () => {
  await withProfile(async (profilePath) => {
    const app = await launch(profilePath)
    const saved = await app.run({ type: 'set-setting', key: 'locale', value: 'zh-CN' })
    assert.equal(saved.ok, true)
    await app.run({ type: 'set-setting', key: 'theme.mode', value: 'light' })
    await app.kill()

    // WAL 里的提交必须能恢复。
    const rows = inspect(profilePath, 'SELECT key, value FROM settings ORDER BY key')
    assert.deepEqual(rows.map((row) => [row.key, row.value]),
      [['locale', 'zh-CN'], ['theme.mode', 'light']], '硬杀后已提交的设置不能丢')

    const db = new DatabaseSync(profileFile(profilePath, 'browser.sqlite3'))
    try {
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
    } finally {
      db.close()
    }

    const again = await launch(profilePath)
    try {
      assert.equal((await again.state()).settings.themeMode, 'light')
    } finally {
      await again.close()
    }
  })
})

test('写库失败时不应用新值（外部持锁 → settings-save-failed）', { timeout: 120_000 }, async () => {
  await withProfile(async (profilePath) => {
    const app = await launch(profilePath)
    const before = await app.state()

    // 用另一个连接拿写锁，模拟"库写不进去"（磁盘满/被占用/只读）。
    const lock = new DatabaseSync(profileFile(profilePath, 'browser.sqlite3'))
    lock.exec('BEGIN EXCLUSIVE')
    try {
      const result = await app.run({ type: 'set-setting', key: 'theme.mode', value: 'dark' })
      assert.equal(result.ok, false, '锁住时写入必须失败')
      assert.equal(result.code, 'settings-save-failed')
      const theme = await app.theme()
      assert.equal(theme.source, before.settings.themeMode, '写失败时不能改 nativeTheme（否则会与持久化分叉）')
      assert.equal((await app.state()).settings.themeMode, before.settings.themeMode)
    } finally {
      lock.exec('ROLLBACK')
      lock.close()
      await app.close()
    }

    // 释放锁后数据没有被污染。
    const rows = inspect(profilePath, "SELECT value FROM settings WHERE key = 'theme.mode'")
    assert.deepEqual(rows, [], '失败的写入不应留下半截数据')
  })
})
