import { isBrowserEngine } from './engine'
import type { BrowserEngine } from './engine'

/**
 * 会话恢复的持久化合同（M2 · 会话恢复首版）。
 *
 * 为什么要一个共享层：载荷来自磁盘，**一律不可信**——旧版本写的、手动改坏的、
 * 被截断的 JSON 都可能出现。校验必须在主进程进内存前完成，而且这份校验要能在
 * 不启动 Electron 的进程里跑（`tests/unit/session.test.ts`），所以本文件不 import electron。
 *
 * 首版范围（见 `docs/reports/2026-11-24-session-restore.md`）：
 * - 恢复标签的地址、标题、引擎、置顶、静音、用户「保持活跃」标记与活动标签；
 * - 内部页只恢复新标签页（`bao://newtab`），设置页不落盘（随时可重新打开）；
 * - **不**恢复：滚动位置、表单内容、导航栈、窗口尺寸/位置、下载与权限状态。
 *
 * 版本号与载荷结构耦合：结构变了就升 `SESSION_VERSION`，旧载荷整份丢弃
 * （会话是"可重建的舒适度数据"，不值得为它写迁移器；设置才需要）。
 */
export const SESSION_VERSION = 1

/** 恢复上限：防止损坏/恶意载荷让启动一次建出上百个窗口或标签。 */
export const SESSION_MAX_WINDOWS = 10
export const SESSION_MAX_TABS = 200

/** 标题进库前的截断长度（Chromium 自己的标题上限也在这个量级）。 */
const TITLE_LIMIT = 512

/** 会话里只承载新标签页这一种内部页；设置页等不落盘。 */
export type SessionInternal = 'newtab'

export interface SessionTab {
  /** 网页地址；`internal === 'newtab'` 时为空串。 */
  url: string
  title: string
  engine: BrowserEngine
  /** 用户手动切过引擎：恢复时保持手动值，而不是重新按站点规则解析。 */
  manualOverride: boolean
  pinned: boolean
  muted: boolean
  /** 用户「保持活跃」：恢复时重建一条 `user` 活动租约（架构 §7）。 */
  keepAwake: boolean
  internal?: SessionInternal
  /** 同一窗口内只认第一个 `active` 标签；恢复后就它一个立即加载。 */
  active?: boolean
}

export interface SessionWindow {
  tabs: SessionTab[]
}

export interface SessionSnapshot {
  version: number
  /** 写入时刻（毫秒），仅用于诊断；恢复逻辑不依赖它。 */
  savedAt: number
  windows: SessionWindow[]
}

function isWebUrl(value: string): boolean {
  const url = URL.parse(value)
  return !!url && (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
}

function isNewTabUrl(value: string): boolean {
  return /^bao:\/\/newtab(\/|$)/i.test(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, TITLE_LIMIT) : ''
}

/**
 * 校验单条标签。任何一处不合格就丢弃整条（而不是"修好一半"）：
 * 恢复出一个地址错误的标签比少恢复一个标签更糟。
 */
export function sanitizeSessionTab(value: unknown): SessionTab | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (!isBrowserEngine(record.engine)) return undefined

  const internal: SessionInternal | undefined = record.internal === 'newtab' ? 'newtab' : undefined
  const url = typeof record.url === 'string' ? record.url.trim() : ''
  if (internal) {
    // 新标签页允许空地址或自身的 bao:// 地址；别的值说明载荷被改过。
    if (url && !isNewTabUrl(url)) return undefined
  } else if (!isWebUrl(url)) {
    return undefined
  }

  return {
    url: internal ? '' : url,
    title: text(record.title),
    engine: record.engine,
    manualOverride: record.manualOverride === true,
    pinned: record.pinned === true,
    muted: record.muted === true,
    keepAwake: record.keepAwake === true,
    ...(internal ? { internal } : {}),
    ...(record.active === true ? { active: true } : {})
  }
}

/** 校验整份会话；完全不可用时返回 `undefined`（启动就按"没有会话"处理）。 */
export function sanitizeSession(value: unknown): SessionSnapshot | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.version !== SESSION_VERSION) return undefined
  if (!Array.isArray(record.windows)) return undefined

  const windows: SessionWindow[] = []
  let budget = SESSION_MAX_TABS
  for (const rawWindow of record.windows) {
    if (windows.length >= SESSION_MAX_WINDOWS || budget <= 0) break
    const rawTabs = rawWindow && typeof rawWindow === 'object' && Array.isArray((rawWindow as { tabs?: unknown }).tabs)
      ? (rawWindow as { tabs: unknown[] }).tabs
      : []
    const tabs: SessionTab[] = []
    let activeSeen = false
    for (const rawTab of rawTabs) {
      const tab = sanitizeSessionTab(rawTab)
      if (!tab) continue
      // 每个窗口只保留一个活动标签：多余的标记降级为普通标签，不丢页面。
      if (tab.active) {
        if (activeSeen) delete tab.active
        else activeSeen = true
      }
      tabs.push(tab)
      budget -= 1
      if (budget <= 0) break
    }
    // 空窗口没有恢复价值：多出来的空壳窗口只会让用户看到一片空白。
    if (tabs.length > 0) windows.push({ tabs })
  }

  if (windows.length === 0) return undefined
  const savedAt = typeof record.savedAt === 'number' && Number.isFinite(record.savedAt) ? record.savedAt : 0
  return { version: SESSION_VERSION, savedAt, windows }
}

/** 从数据库载荷解析会话（坏 JSON 或坏结构都当作"没有会话"）。 */
export function sessionFromPayload(payload: string | undefined): SessionSnapshot | undefined {
  if (!payload) return undefined
  try {
    return sanitizeSession(JSON.parse(payload))
  } catch {
    return undefined
  }
}

/** 整份会话的标签总数（崩溃恢复提示的文案用它，跨窗口累加）。 */
export function sessionTabCount(snapshot: SessionSnapshot | undefined): number {
  if (!snapshot) return 0
  return snapshot.windows.reduce((total, window) => total + window.tabs.length, 0)
}
