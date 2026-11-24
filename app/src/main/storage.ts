import { app, nativeTheme } from 'electron'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, sanitizeSetting } from '../shared/settings'
import type { SettingKey, Settings } from '../shared/settings'
import type { BrowserEngine, EngineRules } from '../shared/engine'
import type { SessionSnapshot } from '../shared/session'
import { deleteRule, openStore, writeRule, writeSession, writeSessionExit, writeSetting } from './db/store'
import type { OpenedStore, SessionExitState } from './db/store'
import { toDatabaseError } from './db/sqlite'

/**
 * 存储单例（架构 §4 数据：主进程持业务权威，渲染层只拿投影）。
 *
 * 三件事集中在这里，避免散落：
 * 1. 打开/迁移业务库（`db/store.ts` 只认路径，不认 electron）；
 * 2. 设置与站点规则的内存快照（写入成功才更新，UI 不会看到「没保存成功却生效」）；
 * 3. 需要**进程级副作用**的设置在写入后立即应用（目前只有主题 → `nativeTheme.themeSource`）。
 *
 * 失败语义：库打不开时**不阻断浏览**——以默认设置运行、写入返回 `unavailable`，
 * 由外壳提示；绝不在失败后偷偷写别的文件（那会让下一次启动读到两套数据）。
 */

let store: OpenedStore | undefined
let failure: string | undefined
let memorySettings: Settings = { ...DEFAULT_SETTINGS }

export type SettingWriteResult = 'ok' | 'invalid' | 'unavailable' | 'save-failed'

export async function initStorage(): Promise<void> {
  const userData = app.getPath('userData')
  try {
    store = await openStore({ userData, legacyRulesFile: join(userData, 'engine-rules.json') })
    memorySettings = store.settings
    failure = undefined
    if (store.legacy === 'failed') {
      console.warn('[storage] 遗留站点规则未导入，本次以库内规则运行。')
    }
  } catch (error) {
    store = undefined
    failure = toDatabaseError(error).code
    console.error('[storage] 业务库无法打开，本次以默认设置运行（不写盘）。', error)
  }
  applyThemeSource()
}

export function storageStatus(): 'ready' | 'unavailable' {
  return store ? 'ready' : 'unavailable'
}

/** 失败原因用稳定代码暴露给外壳（不把 SQLite 路径/errstr 漏给 UI）。 */
export function storageErrorCode(): string | undefined {
  return failure
}

export function settings(): Settings {
  return store ? store.settings : memorySettings
}

export function engineRules(): EngineRules {
  return store ? store.rules : {}
}

/** 上次退出时的会话快照（没有会话或载荷损坏时为 `undefined`）。 */
export function session(): SessionSnapshot | undefined {
  return store?.session
}

/** 上次退出的方式；`undefined` = 没有记录（首次运行、旧库或读失败）。 */
export function sessionExit(): SessionExitState | undefined {
  return store?.sessionExit
}

/**
 * 记录上次退出的方式。
 *
 * 语义是「武装/解除」而不是审计：启动时先写 `crash`，正常退出时写 `clean`。
 * 硬杀来不及写 `clean`，下次启动就能识别为异常退出。失败只记日志。
 */
export function markSessionExit(state: SessionExitState): boolean {
  if (!store) return false
  try {
    writeSessionExit(store.db, state)
    store.sessionExit = state
    return true
  } catch (error) {
    console.error('[storage] 退出标记写入失败。', error)
    return false
  }
}

/**
 * 覆盖写入会话快照。
 *
 * 失败只记日志、返回 false：会话是「可重建的舒适度数据」，写不进去不该让退出或
 * 切换标签失败。失败时也**不更新内存快照**——否则下次读到的会是没落盘的状态。
 */
export function saveSession(snapshot: SessionSnapshot): boolean {
  if (!store) return false
  try {
    // 用主进程校验后的那份更新内存快照：读到的一定是落盘的那份。
    store.session = writeSession(store.db, snapshot)
    return true
  } catch (error) {
    console.error('[storage] 会话写入失败（本次不保留）。', error)
    return false
  }
}

/** 写入一条设置。成功才更新快照并应用副作用；失败保持旧值（UI 与持久化不分叉）。 */
export function setSetting(key: unknown, value: unknown): SettingWriteResult {
  // 先校验再落库：非法键/值根本不该发出一条 SQL（也避免把校验失败误报成写盘失败）。
  const sanitized = sanitizeSetting(key, value)
  if (!sanitized) return 'invalid'
  if (!store) return 'unavailable'
  try {
    store.settings = writeSetting(store.db, sanitized.key, sanitized.value)
    memorySettings = store.settings
    applyThemeSource()
    return 'ok'
  } catch (error) {
    const code = toDatabaseError(error).code
    if (code === 'INVALID_PARAM' || code === 'INVALID_SETTING' || code === 'SQLITE_CONSTRAINT') return 'invalid'
    console.error('[storage] 设置写入失败，已保留原值。', error)
    return 'save-failed'
  }
}

export function rememberRule(host: string, engine: BrowserEngine): boolean {
  if (!store) return false
  try {
    store.rules = writeRule(store.db, host, engine)
    return true
  } catch (error) {
    console.error('[storage] 站点规则写入失败。', error)
    return false
  }
}

export function forgetRule(host: string): boolean {
  if (!store) return false
  try {
    store.rules = deleteRule(store.db, host)
    return true
  } catch (error) {
    console.error('[storage] 站点规则删除失败。', error)
    return false
  }
}

/**
 * 设置项 → 全局副作用。
 *
 * 主题是 1:1 映射：`theme.mode` 的取值域（system/light/dark）与
 * `nativeTheme.themeSource` 完全相同，所以不自己维护第二套「亮/暗」状态——
 * 解析后的 `shouldUseDarkColors` 才是唯一真源（外壳、叠加层、系统按钮、起始页、
 * 站点看到的 `prefers-color-scheme` 全由它派生）。
 */
export function applyThemeSource(): void {
  const mode = settings().themeMode
  if (nativeTheme.themeSource !== mode) nativeTheme.themeSource = mode
}

export function closeStorage(): void {
  store?.db.close()
  store = undefined
}
