import { app, nativeTheme } from 'electron'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, sanitizeSetting } from '../shared/settings'
import type { SettingKey, Settings } from '../shared/settings'
import type { BrowserEngine, EngineRules } from '../shared/engine'
import type { BookmarkNode } from '../shared/bookmarks'
import type { SessionSnapshot } from '../shared/session'
import {
  addBookmark, clearBookmarks, clearEngineRules, clearSession, deleteBookmark, deleteRule, importBookmarks, moveBookmark, openStore,
  readBookmarks, renameBookmark, updateBookmarkUrl, writeBookmarksExpanded, writeRule, writeSession, writeSessionExit, writeSetting
} from './db/store'
import type { AddBookmarkInput, OpenedStore, SessionExitState } from './db/store'
import { parseBookmarksHtml } from '../shared/bookmark-import'
import type { ParsedBookmarks } from '../shared/bookmark-import'
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

/**
 * 收藏夹全量投影（含两个永久根）。
 *
 * 只读内存快照：写入路径已经用同一份 `readBookmarks()` 覆盖过它，所以这里不会比库旧。
 * 存储不可用时返回空数组——界面显示"还没有收藏"，比抛错让整个状态广播失败要好。
 */
export function bookmarkNodes(): BookmarkNode[] {
  return store ? store.bookmarks : []
}

/**
 * 新增一条收藏，成功后刷新内存快照。
 *
 * 校验只做存储层该管的（父节点存在且是文件夹、地址非空）；**地址是不是 http(s)** 由调用方
 * （`browser-window` 的命令入口）用 `isBookmarkableAddress()` 判——那是产品规则，
 * 存储层不该知道"内部页不算站点"。
 */
export function addBookmarkData(input: AddBookmarkInput): boolean {
  if (!store) return false
  try {
    addBookmark(store.db, input)
    store.bookmarks = readBookmarks(store.db)
    return true
  } catch (error) {
    console.error('[storage] 收藏写入失败。', error)
    return false
  }
}

/** 删除一条收藏（连同子树）。幂等：条目已经不在时也算成功，界面据此收行。 */
export function removeBookmarkData(id: string): boolean {
  if (!store) return false
  try {
    store.bookmarks = deleteBookmark(store.db, id)
    return true
  } catch (error) {
    console.error('[storage] 收藏删除失败。', error)
    return false
  }
}

/**
 * 改名 / 改地址 / 移动（编辑气泡的「完成」、完整编辑器的「保存」，以及名称框失焦时的即时保存）。
 *
 * 三件事都在存储层做，因为它们改的是同一份数据、而且必须一起进一个结果快照：只改一半会让
 * 界面显示"名字变了但还在原来的文件夹"。与 Chromium 一致：标题为空串时不写
 * （`renameBookmark` 会拒），移动用 `moveBookmark` 做环检测与重排。
 */
export function updateBookmarkData(
  id: string,
  changes: { title?: string; url?: string; parentId?: string }
): boolean {
  if (!store) return false
  try {
    if (changes.parentId !== undefined) {
      // 放到目标文件夹末尾：`moveBookmark` 会把 index 夹到同级长度，这里给一个足够大的值。
      moveBookmark(store.db, id, changes.parentId, Number.MAX_SAFE_INTEGER)
      store.bookmarks = readBookmarks(store.db)
    }
    if (changes.title !== undefined) {
      store.bookmarks = renameBookmark(store.db, id, changes.title)
    }
    if (changes.url !== undefined) {
      store.bookmarks = updateBookmarkUrl(store.db, id, changes.url)
    }
    return true
  } catch (error) {
    console.error('[storage] 收藏更新失败。', error)
    store.bookmarks = readBookmarks(store.db)
    return false
  }
}

/**
 * 移动 / 排序一条收藏（管理页拖动、编辑气泡的「换文件夹」）。
 *
 * 返回三态而不是布尔：**放不下**（环、目标不是文件夹）与**写盘失败**对用户是两句不同的话，
 * 混成一个 `false` 只能提示"没保存"，会让人以为数据出问题了。
 */
export type BookmarkMoveResult = 'ok' | 'placement' | 'unavailable'

export function moveBookmarkData(id: string, parentId: string, index: number): BookmarkMoveResult {
  if (!store) return 'unavailable'
  try {
    store.bookmarks = moveBookmark(store.db, id, parentId, index)
    return 'ok'
  } catch (error) {
    const code = toDatabaseError(error).code
    if (code === 'BOOKMARK_PLACEMENT') return 'placement'
    console.error('[storage] 收藏移动失败。', error)
    // 失败时把内存快照再读一遍：库里可能已经回滚，界面不该停在乐观结果上。
    store.bookmarks = readBookmarks(store.db)
    return 'unavailable'
  }
}

/**
 * 新建文件夹（完整编辑器里的「新建文件夹」）。
 *
 * 父节点合法性由 `addBookmark` 判（必须是文件夹），这里只兜住"名字不能是空白"——
 * 空名字在界面上就是一条看不见的文件夹，比报错更难查。返回新节点 id（界面据此选中它）。
 */
export function createBookmarkFolderData(input: { title: string; parentId: string }): string | undefined {
  if (!store) return undefined
  const title = input.title.trim()
  if (!title) return undefined
  try {
    const node = addBookmark(store.db, { parentId: input.parentId, kind: 'folder', title })
    store.bookmarks = readBookmarks(store.db)
    return node.id
  } catch (error) {
    console.error('[storage] 新建文件夹失败。', error)
    return undefined
  }
}

/**
 * 导入一份浏览器导出的书签 HTML。
 *
 * 解析在 `shared/bookmark-import.ts`（纯逻辑、有单测），合并规则在 `db/store.ts`
 * 的 `importBookmarks()`（对齐 Chromium 的 `ProfileWriter::AddBookmarks()`）。
 * 这里只做三件事：拿到当前库、把结果换成新快照、把"为什么没成功"翻译成稳定原因。
 *
 * 失败时**不写半份**：合并本身在一个事务里，异常回滚；这里再把内存快照重新读一遍，
 * 保证界面看到的一定是库里的样子。
 */
export type BookmarkImportOutcome =
  | { ok: true; folders: number; urls: number; skipped: number; toolbarFolder: boolean }
  | { ok: false; reason: 'unavailable' | 'unreadable' | 'empty' }

export function importBookmarksData(html: string): BookmarkImportOutcome {
  if (!store) return { ok: false, reason: 'unavailable' }
  let parsed: ParsedBookmarks
  try {
    parsed = parseBookmarksHtml(html)
  } catch (error) {
    console.error('[storage] 书签文件解析失败。', error)
    return { ok: false, reason: 'unreadable' }
  }
  // 一条都没解析出来：多半是选错了文件（比如导出的设置 JSON），说清楚比"导入 0 条"好。
  if (parsed.counts.urls === 0 && parsed.counts.folders === 0) return { ok: false, reason: 'empty' }
  try {
    const result = importBookmarks(store.db, parsed)
    store.bookmarks = result.nodes
    return {
      ok: true,
      folders: result.folders,
      urls: result.urls,
      skipped: parsed.counts.skipped,
      toolbarFolder: parsed.toolbarFolder
    }
  } catch (error) {
    console.error('[storage] 书签导入失败（已回滚）。', error)
    store.bookmarks = readBookmarks(store.db)
    return { ok: false, reason: 'unreadable' }
  }
}

/** 清除全部收藏夹内容（分类清理的「收藏」档）：保留两个永久根，内容清空。 */
export function clearBookmarksData(): boolean {
  if (!store) return false
  try {
    store.bookmarks = clearBookmarks(store.db)
    return true
  } catch (error) {
    console.error('[storage] 收藏夹清除失败。', error)
    return false
  }
}

/** 收藏夹树的展开状态（`undefined` = 从来没记录过，界面用自己的默认）。 */
export function bookmarksExpanded(): string[] | undefined {
  return store?.bookmarksExpanded
}

/**
 * 写收藏夹树的展开状态。失败只记日志、返回 `undefined`——
 * 这是"上次点开了哪个文件夹"的舒适度数据，写不进去不该让点击本身失败。
 */
export function setBookmarksExpanded(ids: unknown): boolean {
  if (!store) return false
  try {
    store.bookmarksExpanded = writeBookmarksExpanded(store.db, Array.isArray(ids) ? ids : [])
    return true
  } catch (error) {
    console.error('[storage] 收藏夹展开状态写入失败。', error)
    return false
  }
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

/**
 * 清除已保存的会话（会话载荷 + 退出标记），并同步清掉内存快照。
 *
 * 失败只记日志并返回 false，调用方据此提示用户；成功返回 true。
 */
export function clearSessionData(): boolean {
  if (!store) return false
  try {
    clearSession(store.db)
    store.session = undefined
    store.sessionExit = undefined
    return true
  } catch (error) {
    console.error('[storage] 会话数据清除失败。', error)
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
 * 清除全部站点引擎规则（分类清理的「规则」档）。
 *
 * 规则只影响"新建标签/新建导航"的默认引擎与来源标签，不动已打开的标签；
 * 失败时保持内存快照不变，UI 据此提示"规则未改动"。
 */
export function clearEngineRulesData(): boolean {
  if (!store) return false
  try {
    store.rules = clearEngineRules(store.db)
    return true
  } catch (error) {
    console.error('[storage] 站点规则清除失败。', error)
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
