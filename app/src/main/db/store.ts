import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { isBrowserEngine } from '../../shared/engine'
import { sanitizeSetting, settingsFromRows } from '../../shared/settings'
import type { SettingKey, SettingValue, Settings } from '../../shared/settings'
import type { BrowserEngine, EngineRules } from '../../shared/engine'
import { sanitizeSession, sessionFromPayload } from '../../shared/session'
import type { SessionSnapshot } from '../../shared/session'
import { Database, DatabaseError, toDatabaseError } from './sqlite'

/**
 * 业务库：文件布局、PRAGMA、迁移器与各表的读写原语（架构 §4 数据）。
 *
 * 本文件**不 import electron**：路径由调用方（`main/storage.ts`）从 `app.getPath('userData')`
 * 解析后传进来。这样存储合同可以在不启动 GUI 的进程里验证（实际做法见 `tests/data/`）。
 *
 * 数据库布局：
 * ```
 * <userData>/db/browser.sqlite3                业务库（WAL）
 * <userData>/db/backups/browser-v<n>-<ts>.sqlite3   迁移前快照
 * <userData>/engine-rules.json                  M1 遗留，导入成功后改名保留
 * <userData>/engine-rules.json.migrated-1      迁移备份（不删除）
 * ```
 */

export const SCHEMA_VERSION = 2
/** 一次性导入的幂等锚点：以库里的标记为准，而不是 JSON 文件是否还在。 */
const IMPORT_MARKER = 'migration.engine-rules@1'
/**
 * 遗留规则导入步骤的版本号。
 *
 * 归档文件名（`engine-rules.json.migrated-<n>`）钉住的是**导入步骤**，不是 schema 版本：
 * schema 以后还会继续升，但那份归档永远属于 v1 的导入，改名会让已有用户的数据看起来"丢了"。
 */
const LEGACY_IMPORT_VERSION = 1

/**
 * 「上次退出是否正常」的标记键（`meta` 表）。
 *
 * 崩溃恢复判定只需要一个布尔，但它必须和会话载荷**分开存**：启动时先把它改回 `crash`
 * （武装），正常退出时写 `clean`。进程被硬杀时来不及写 `clean`，下次启动据此认出
 * "上次没正常退出"。存在载荷内部也行，但那样每次武装都要重写整份会话。
 */
const SESSION_EXIT_KEY = 'session.last-exit'

export type SessionExitState = 'clean' | 'crash'

export interface StorePaths {
  directory: string
  database: string
  backups: string
}

export interface OpenedStore {
  db: Database
  paths: StorePaths
  settings: Settings
  rules: EngineRules
  /** 上次退出时的会话快照（没有、损坏或版本不符时为 `undefined`）。 */
  session?: SessionSnapshot
  /** 上次退出的方式；`undefined` 表示没有记录（首次运行或旧库）。 */
  sessionExit?: SessionExitState
  /** 打开前库里的版本（0 = 新建）。 */
  previousVersion: number
  /** 迁移前快照（仅在旧库升级时生成）。 */
  backupFile?: string
  /** 遗留规则导入的结局。 */
  legacy: 'none' | 'imported' | 'already' | 'empty' | 'failed'
}

export function storePaths(userDataDirectory: string): StorePaths {
  const directory = join(userDataDirectory, 'db')
  return {
    directory,
    database: join(directory, 'browser.sqlite3'),
    backups: join(directory, 'backups')
  }
}

function userVersion(db: Database): number {
  const row = db.pragma<{ user_version: number }>('PRAGMA user_version')
  const value = Number(row?.user_version ?? 0)
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '').replace('Z', 'Z')
}

/** v1：设置、迁移标记、站点引擎规则。 */
function migrateToV1(db: Database): void {
  db.exec(`
    CREATE TABLE settings(
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE meta(
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE engine_rules(
      host TEXT PRIMARY KEY,
      engine TEXT NOT NULL CHECK (engine IN ('ppapi', 'ruffle')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
}

/**
 * v2：会话恢复的单行载荷（M2 会话恢复）。
 *
 * 为什么整份 JSON 存一行而不是一张标签表：会话是**整体替换**的可重建数据，
 * 不是可查询的业务实体；一行写入天然原子，恢复时也只需要一次读。
 * 校验与版本判定在 `shared/session.ts`（进内存前完成，坏载荷整份丢弃）。
 */
function migrateToV2(db: Database): void {
  db.exec(`
    CREATE TABLE session(
      id INTEGER PRIMARY KEY CHECK (id = 0),
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
}

/** 迁移步骤：按版本号递增执行，只跑比库里 `user_version` 新的那些。 */
const MIGRATIONS: ReadonlyArray<{ version: number; apply: (db: Database) => void }> = [
  { version: 1, apply: migrateToV1 },
  { version: 2, apply: migrateToV2 }
]

/**
 * 把 M1 的 `engine-rules.json` 导入 `engine_rules` 表。
 *
 * 幂等：以 `meta` 标记为准。用户之后在库里删掉某条规则，不会因为 JSON 还在就被复活。
 * 解析失败时**不写标记、不改名**，下次启动重试——迁移失败不能把用户数据吃掉。
 */
function importLegacyRules(db: Database, file: string | undefined): OpenedStore['legacy'] {
  const marked = db.get('SELECT value FROM meta WHERE key = ?', IMPORT_MARKER)
  if (marked) return 'already'
  if (!file || !existsSync(file)) {
    db.run('INSERT INTO meta(key, value) VALUES(?, ?)', IMPORT_MARKER, 'no-legacy-file')
    return 'none'
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    console.warn(`[store] 无法解析遗留站点规则，本次不导入（下次启动重试）：${file}`, error)
    return 'failed'
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn(`[store] 遗留站点规则格式不对，本次不导入（下次启动重试）：${file}`)
    return 'failed'
  }
  const now = Date.now()
  let imported = 0
  const insert = 'INSERT INTO engine_rules(host, engine, created_at, updated_at) VALUES(?, ?, ?, ?) ' +
    'ON CONFLICT(host) DO NOTHING'
  for (const [host, engine] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isBrowserEngine(engine) || !host) continue
    db.run(insert, host, engine, now, now)
    imported += 1
  }
  db.run('INSERT INTO meta(key, value) VALUES(?, ?)', IMPORT_MARKER, String(imported))
  console.info(`[store] 已导入 ${imported} 条站点引擎规则。`)
  return imported === 0 ? 'empty' : 'imported'
}

/** 迁移成功后把遗留文件改名保留（不删除）。改名失败不影响数据：标记已经写进库。 */
function archiveLegacyRules(file: string | undefined): string | undefined {
  if (!file || !existsSync(file)) return undefined
  let target = `${file}.migrated-${LEGACY_IMPORT_VERSION}`
  if (existsSync(target)) target = `${file}.migrated-${LEGACY_IMPORT_VERSION}-${stamp()}`
  try {
    renameSync(file, target)
    console.info(`[store] 遗留站点规则已归档：${target}`)
    return target
  } catch (error) {
    console.warn('[store] 遗留站点规则改名失败（数据已导入，下次启动补做）。', error)
    return undefined
  }
}

export interface OpenStoreOptions {
  /** `app.getPath('userData')`。 */
  userData: string
  /** 遗留 JSON 路径；默认 `<userData>/engine-rules.json`。 */
  legacyRulesFile?: string
  /** 迁移前快照的保留份数。 */
  keepBackups?: number
}

export async function openStore(options: OpenStoreOptions): Promise<OpenedStore> {
  const paths = storePaths(options.userData)
  mkdirSync(paths.backups, { recursive: true })
  const legacy = options.legacyRulesFile ?? join(options.userData, 'engine-rules.json')
  const db = new Database(paths.database)
  try {
    const previousVersion = userVersion(db)
    if (previousVersion > SCHEMA_VERSION) {
      throw toDatabaseError(new Error(
        `数据库版本 ${previousVersion} 高于当前应用支持的 ${SCHEMA_VERSION}，请升级应用后再打开这份数据。`
      ))
    }
    let backupFile: string | undefined
    let legacyResult: OpenedStore['legacy'] = 'none'
    if (previousVersion < SCHEMA_VERSION) {
      // 旧库升级才备份；新建库没有可丢的数据。
      if (previousVersion > 0) {
        backupFile = join(paths.backups, `browser-v${previousVersion}-${stamp()}.sqlite3`)
        await db.snapshotTo(backupFile)
      }
      db.transaction(() => {
        for (const step of MIGRATIONS) {
          if (step.version > previousVersion) step.apply(db)
        }
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      })
    }

    // 遗留规则导入**不在迁移事务里**，而且每次打开都跑：
    // - 导入失败（JSON 坏了）不写标记，下次启动会重试（审计 P2：之前失败也提交 user_version，
    //   之后再也不进导入分支，等于永久放弃用户数据）；
    // - 标记已写但归档没成功（文件还在）时，也在这里补做归档。
    legacyResult = importLegacyRules(db, legacy)
    if (legacyResult === 'imported' || legacyResult === 'empty' ||
        (legacyResult === 'already' && existsSync(legacy))) {
      archiveLegacyRules(legacy)
    }

    // 轻量自检：能发现"文件在但页损坏"（例如断电/杀进程落在坏扇区）。
    // 设置规模的库是毫秒级；历史数据长到十万行后要改成定期检查。
    const check = db.pragma<{ quick_check: string }>('PRAGMA quick_check')
    if (check?.quick_check !== 'ok') {
      throw toDatabaseError(new Error(`数据库自检失败：${String(check?.quick_check)}`))
    }

    return {
      db,
      paths,
      settings: readSettings(db),
      rules: readRules(db),
      session: readSession(db),
      sessionExit: readSessionExit(db),
      previousVersion,
      backupFile,
      legacy: legacyResult
    }
  } catch (error) {
    db.close()
    throw toDatabaseError(error)
  }
}

export function readSettings(db: Database): Settings {
  const rows = db.all('SELECT key, value FROM settings')
  return settingsFromRows(rows.map((row) => ({ key: String(row.key), value: String(row.value) })))
}

/** 写一条设置并返回最新快照；失败抛 `DatabaseError`（调用方决定如何降级）。 */
export function writeSetting(db: Database, key: SettingKey, value: unknown): Settings {
  const sanitized = sanitizeSetting(key, value)
  if (!sanitized) throw new DatabaseError(`非法的设置项：${String(key)}`, 'INVALID_SETTING')
  db.run(
    'INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    sanitized.key,
    String(sanitized.value),
    Date.now()
  )
  return readSettings(db)
}

export function readRules(db: Database): EngineRules {
  const rules: Record<string, BrowserEngine> = {}
  for (const row of db.all('SELECT host, engine FROM engine_rules')) {
    const host = String(row.host ?? '')
    if (host && isBrowserEngine(row.engine)) rules[host] = row.engine
  }
  return rules
}

export function writeRule(db: Database, host: string, engine: BrowserEngine): EngineRules {
  const now = Date.now()
  db.run(
    'INSERT INTO engine_rules(host, engine, created_at, updated_at) VALUES(?, ?, ?, ?) ' +
      'ON CONFLICT(host) DO UPDATE SET engine = excluded.engine, updated_at = excluded.updated_at',
    host,
    engine,
    now,
    now
  )
  return readRules(db)
}

export function deleteRule(db: Database, host: string): EngineRules {
  db.run('DELETE FROM engine_rules WHERE host = ?', host)
  return readRules(db)
}

/**
 * 清除全部站点引擎规则（分类清理的「规则」档）。
 *
 * 单条 `DELETE` 本身就是原子的，不需要事务；返回删除后的空规则表，
 * 调用方据此更新内存快照（避免"库里清了、内存还留着旧规则"）。
 */
export function clearEngineRules(db: Database): EngineRules {
  db.run('DELETE FROM engine_rules')
  return readRules(db)
}

/** 设置项的类型化取值（供投影与判定使用）。 */
export function settingValue(settings: Settings, key: SettingKey): SettingValue[SettingKey] {
  switch (key) {
    case 'overlay.prewarm': return settings.overlayPrewarm
    case 'tab.discard': return settings.tabDiscard
    case 'session.startup': return settings.sessionStartup
    case 'theme.mode': return settings.themeMode
    case 'engine.default': return settings.defaultEngine
    case 'locale': return settings.locale
  }
}

/** 读上次退出的方式。没有记录（首次运行/旧库）返回 `undefined`。 */
export function readSessionExit(db: Database): SessionExitState | undefined {
  const row = db.get('SELECT value FROM meta WHERE key = ?', SESSION_EXIT_KEY)
  const value = typeof row?.value === 'string' ? row.value : undefined
  return value === 'clean' || value === 'crash' ? value : undefined
}

/**
 * 写上次退出的方式（启动时写 `crash` 武装，正常退出时写 `clean`）。
 *
 * 走 `meta` 表而不是会话载荷：武装发生在启动早期、会话载荷还没准备好；
 * 而且这条标记的写入频率与内容生命周期都和会话完全不同。
 */
export function writeSessionExit(db: Database, state: SessionExitState): void {
  db.run(
    'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    SESSION_EXIT_KEY,
    state
  )
}

/**
 * 清除已保存的会话：会话载荷 + 退出标记。
 *
 * 一个事务里做两件事：清掉载荷但留下 `crash` 标记，会在下次启动产生一条"空会话提示"，
 * 或者反过来留下载荷但没有标记——两种半截状态都不该出现。
 */
export function clearSession(db: Database): void {
  db.transaction(() => {
    db.run('DELETE FROM session')
    db.run('DELETE FROM meta WHERE key = ?', SESSION_EXIT_KEY)
  })
}

/** 读会话载荷。坏 JSON / 坏结构 / 版本不符一律当作「没有会话」，不阻断启动。 */
export function readSession(db: Database): SessionSnapshot | undefined {
  const row = db.get('SELECT payload FROM session WHERE id = 0')
  return sessionFromPayload(typeof row?.payload === 'string' ? row.payload : undefined)
}

/**
 * 写会话载荷（覆盖式）。
 *
 * 写入前再校验一次：会话是**整体替换**的数据，写进去一份坏载荷等于让下次启动少恢复标签，
 * 而校验只有一处实现（`shared/session.ts`），这里不重复规则、只兜住调用方的手误。
 */
export function writeSession(db: Database, snapshot: SessionSnapshot): SessionSnapshot {
  const sanitized = sanitizeSession(snapshot)
  if (!sanitized) throw new DatabaseError('会话载荷未通过校验，拒绝写入', 'INVALID_PARAM')
  db.run(
    'INSERT INTO session(id, payload, updated_at) VALUES(0, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at',
    JSON.stringify(sanitized),
    Date.now()
  )
  return sanitized
}
