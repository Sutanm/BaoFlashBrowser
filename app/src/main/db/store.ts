import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { isBrowserEngine } from '../../shared/engine'
import { sanitizeSetting, settingsFromRows } from '../../shared/settings'
import type { SettingKey, SettingValue, Settings } from '../../shared/settings'
import type { BrowserEngine, EngineRules } from '../../shared/engine'
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

export const SCHEMA_VERSION = 1
/** 一次性导入的幂等锚点：以库里的标记为准，而不是 JSON 文件是否还在。 */
const IMPORT_MARKER = 'migration.engine-rules@1'

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
function migrateToV1(db: Database, legacyRulesFile: string | undefined): OpenedStore['legacy'] {
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
  return importLegacyRules(db, legacyRulesFile)
}

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
  let target = `${file}.migrated-${SCHEMA_VERSION}`
  if (existsSync(target)) target = `${file}.migrated-${SCHEMA_VERSION}-${stamp()}`
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
      legacyResult = db.transaction(() => {
        const result = migrateToV1(db, legacy)
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
        return result
      })
      if (legacyResult === 'imported' || legacyResult === 'empty') archiveLegacyRules(legacy)
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

/** 设置项的类型化取值（供投影与判定使用）。 */
export function settingValue(settings: Settings, key: SettingKey): SettingValue[SettingKey] {
  switch (key) {
    case 'theme.mode': return settings.themeMode
    case 'engine.default': return settings.defaultEngine
    case 'locale': return settings.locale
  }
}
