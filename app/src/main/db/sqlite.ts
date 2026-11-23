import { backup, DatabaseSync, constants } from 'node:sqlite'
import type { SQLInputValue, SQLOutputValue, StatementSync } from 'node:sqlite'

/**
 * SQLite 薄适配层（M2 存储）。
 *
 * 为什么需要这一层：`node:sqlite` 的 API 面够用，但有几处「静默行为」会咬人，且是
 * 实验性 API（Node 稳定性 1.1）。适配层只做五件事，业务代码不直接碰 `node:sqlite`：
 *
 * 1. **参数校验**：实测 `Date` 会被静默写成 NULL（文档说会抛异常，22.22.1 上不是），
 *    `NaN`/`Infinity` 同样静默变 NULL。这类错误必须在写入前抛，而不是变成一条空数据。
 * 2. **连接 PRAGMA**：WAL + `synchronous=NORMAL` + 显式 busy timeout（内核默认 0，
 *    多进程抢锁会立刻失败）。
 * 3. **事务**：`node:sqlite` 没有 `transaction()` 助手，且嵌套 `BEGIN` 直接抛
 *    `ERR_SQLITE_ERROR`；这里用 SAVEPOINT 实现可嵌套事务。
 * 4. **语句缓存**：prepare 约 3.4 µs/次，热路径按 SQL 文本缓存。
 * 5. **错误归一**：内核给 `{code:'ERR_SQLITE_ERROR', errcode:13}`，这里映射成
 *    `SQLITE_FULL` 这种稳定名字，业务代码按名字分支。
 *
 * 换绑定（例如 better-sqlite3）时只需要重写本文件。
 */

export type Param = null | number | bigint | string | Uint8Array
export type Row = Record<string, SQLOutputValue>

/** SQLite 主错误码 → 稳定名字。只列我们会分支处理的那些，其余给 `SQLITE_<n>`。 */
const ERROR_CODES: Record<number, string> = {
  1: 'SQLITE_ERROR',
  2: 'SQLITE_INTERNAL',
  3: 'SQLITE_PERM',
  4: 'SQLITE_ABORT',
  5: 'SQLITE_BUSY',
  6: 'SQLITE_LOCKED',
  8: 'SQLITE_READONLY',
  9: 'SQLITE_INTERRUPT',
  10: 'SQLITE_IOERR',
  11: 'SQLITE_CORRUPT',
  12: 'SQLITE_NOTFOUND',
  13: 'SQLITE_FULL',
  14: 'SQLITE_CANTOPEN',
  15: 'SQLITE_PROTOCOL',
  17: 'SQLITE_SCHEMA',
  19: 'SQLITE_CONSTRAINT',
  20: 'SQLITE_MISMATCH',
  21: 'SQLITE_MISUSE',
  26: 'SQLITE_NOTADB',
  27: 'SQLITE_NOTICE',
  28: 'SQLITE_WARNING'
}

export class DatabaseError extends Error {
  readonly code: string
  readonly errcode?: number

  constructor(message: string, code: string, errcode?: number) {
    super(message)
    this.name = 'DatabaseError'
    this.code = code
    this.errcode = errcode
  }
}

function describe(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'object') return Object.prototype.toString.call(value).slice(8, -1)
  return typeof value
}

/**
 * 把内核错误归一成 `DatabaseError`。
 *
 * 内核的错误对象形如 `{ code: 'ERR_SQLITE_ERROR', errcode: 13, errstr: 'database or disk is full' }`。
 */
export function toDatabaseError(error: unknown): DatabaseError {
  if (error instanceof DatabaseError) return error
  const record = error as { code?: unknown; errcode?: unknown; message?: unknown } | undefined
  const message = typeof record?.message === 'string' ? record.message : String(error)
  const errcode = typeof record?.errcode === 'number' ? record.errcode : undefined
  const code = errcode !== undefined
    ? (ERROR_CODES[errcode] ?? `SQLITE_${errcode}`)
    : (typeof record?.code === 'string' ? record.code : 'SQLITE_UNKNOWN')
  return new DatabaseError(message, code, errcode)
}

/**
 * 绑定参数校验。
 *
 * `Date` / `NaN` / `Infinity` / 普通对象 / 函数都会让 `node:sqlite` 静默写 NULL，
 * 所以这里显式拒绝。`boolean` 在 SQLite 里没有类型，调用方必须先决定存 0/1。
 */
function checkParam(value: unknown, index: number): SQLInputValue {
  if (value === null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new DatabaseError(`第 ${index + 1} 个参数不是有限数字（NaN/Infinity 会被静默写成 NULL）`, 'INVALID_PARAM')
    }
    return value
  }
  if (value instanceof Uint8Array) return value
  throw new DatabaseError(
    `第 ${index + 1} 个参数类型是 ${describe(value)}；只接受 null / number / bigint / string / Uint8Array` +
      (value instanceof Date ? '（Date 请先转成 epoch 毫秒）' : ''),
    'INVALID_PARAM'
  )
}

function checkParams(params: readonly unknown[]): SQLInputValue[] {
  return params.map((value, index) => checkParam(value, index))
}

export interface OpenOptions {
  /** 只读打开（用于外部检查/备份校验）。 */
  readOnly?: boolean
  /** busy timeout 毫秒；内核默认 0，这里默认 2000。 */
  timeoutMs?: number
}

export class Database {
  private readonly connection: DatabaseSync
  private readonly statements = new Map<string, StatementSync>()
  private savepoints = 0
  private closed = false

  constructor(path: string, options: OpenOptions = {}) {
    const readOnly = options.readOnly === true
    try {
      this.connection = new DatabaseSync(path, {
        readOnly,
        enableForeignKeyConstraints: true,
        // 内核默认 busy timeout 是 0：实测多连接抢锁时 0.19 ms 就失败。
        timeout: options.timeoutMs ?? 2000,
        allowExtension: false
      })
      if (!readOnly) {
        this.connection.exec('PRAGMA journal_mode = WAL')
        this.connection.exec('PRAGMA synchronous = NORMAL')
        const mode = this.connection.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown } | undefined
        if (mode?.journal_mode !== 'wal') {
          throw new DatabaseError(`无法启用 WAL（journal_mode=${String(mode?.journal_mode)}）`, 'WAL_UNAVAILABLE')
        }
      }
    } catch (error) {
      throw toDatabaseError(error)
    }
  }

  get isOpen(): boolean {
    return !this.closed && this.connection.isOpen
  }

  get inTransaction(): boolean {
    return this.connection.isTransaction
  }

  exec(sql: string): void {
    this.guard(() => this.connection.exec(sql))
  }

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql)
    if (!statement) {
      statement = this.connection.prepare(sql)
      this.statements.set(sql, statement)
    }
    return statement
  }

  run(sql: string, ...params: readonly unknown[]): { changes: number; lastInsertRowid: number } {
    return this.guard(() => {
      const result = this.statement(sql).run(...checkParams(params))
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) }
    })
  }

  get(sql: string, ...params: readonly unknown[]): Row | undefined {
    return this.guard(() => this.statement(sql).get(...checkParams(params)) as Row | undefined)
  }

  all(sql: string, ...params: readonly unknown[]): Row[] {
    return this.guard(() => this.statement(sql).all(...checkParams(params)) as Row[])
  }

  /** `PRAGMA` 之类返回单行的语句（不能参数化）。 */
  pragma<T extends Row = Row>(sql: string): T | undefined {
    return this.guard(() => this.connection.prepare(sql).get() as T | undefined)
  }

  /**
   * 可嵌套事务。外层用 `BEGIN IMMEDIATE`，内层用 SAVEPOINT——内核不允许嵌套 BEGIN
   * （实测抛 `cannot start a transaction within a transaction`）。
   */
  transaction<T>(work: () => T): T {
    const nested = this.connection.isTransaction
    const name = `bao_sp_${this.savepoints++}`
    this.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE')
    try {
      const value = work()
      this.exec(nested ? `RELEASE ${name}` : 'COMMIT')
      return value
    } catch (error) {
      try {
        if (nested) {
          this.exec(`ROLLBACK TO ${name}`)
          this.exec(`RELEASE ${name}`)
        } else {
          this.exec('ROLLBACK')
        }
      } catch {
        // 回滚本身失败（连接已坏）：保留原始错误更有价值。
      }
      throw error
    }
  }

  /** 一致性快照（迁移前备份）。SQLite backup API 会处理 WAL 里未落盘的页。 */
  async snapshotTo(path: string): Promise<number> {
    return this.guardAsync(() => backup(this.connection, path))
  }

  /** 关闭前把 WAL 并回主库，避免备份/拷贝时漏掉未 checkpoint 的页。 */
  checkpoint(): void {
    this.guard(() => this.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)'))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.checkpoint()
    } catch {
      // 连接已损坏时 checkpoint 会失败，仍然尝试关闭。
    }
    try {
      this.connection.close()
    } catch {
      // 关闭失败不抛出：调用方（退出/降级路径）不应因此中断。
    }
  }

  private guard<T>(work: () => T): T {
    try {
      return work()
    } catch (error) {
      throw toDatabaseError(error)
    }
  }

  private async guardAsync<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (error) {
      throw toDatabaseError(error)
    }
  }
}

/** 冲突处理常量（`applyChangeset` 用；导出给未来的增量同步）。 */
export const conflict = constants
