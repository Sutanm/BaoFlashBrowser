import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 自动发现插件时的**有界目录扫描**（纯逻辑：不 import electron，可在单测里覆盖）。
 *
 * 设计约束：
 * 1. **必须同步**——插件是在 `app.ready` 之前用 `--register-pepper-plugins` 注册的，
 *    异步扫描只能等到下一次启动才生效；
 * 2. **必须有界**——扫的是用户磁盘，不能因为某个目录巨大就把启动拖住。因此有三道闸：
 *    递归深度（由调用方给）、访问条目上限、时间预算；任一道用完就停下并**保留已找到的**；
 * 3. **必须可分组**——同一路径上可能既有 32 位又有 64 位插件，命中文件名只是候选，
 *    还要过 `validate`（PE 头 + `PPP_GetInterface` 导出）才算数；所以先按「文件名里的
 *    版本号」从新到旧排，再逐个校验，第一个通过的就是结果（通常只读一个文件）。
 */

export interface FlashScanRoot {
  /** 绝对路径；不存在时直接跳过。 */
  path: string
  /** 递归深度：1 = 只看该目录自身。 */
  depth: number
  /** 来源标签，透传到 `FlashScanHit.origin`。 */
  origin: string
}

export interface FlashScanHit {
  path: string
  origin: string
  size: number
  mtimeMs: number
  /** 展示用版本串：优先校验器（PE 资源）给的，其次从路径/文件名推断。 */
  version?: string
}

export interface FlashScanResult {
  hit?: FlashScanHit
  /** 进入的目录数（诊断用）。 */
  visitedDirectories: number
  /** 文件名命中、但没有通过校验的个数（32 位 DLL、假插件）。 */
  rejected: number
  /** 时间/条目预算是否被用完（用完意味着「可能还有没扫到的地方」）。 */
  budgetExhausted: boolean
}

export interface FlashScanOptions {
  /** 文件名是否像目标插件（平台相关）。 */
  match: (name: string) => boolean
  /** 文件能不能真的加载；返回 `undefined` 表示不能。 */
  validate: (path: string) => { version?: string } | undefined
  /** 访问条目上限，默认 20000。 */
  maxEntries?: number
  /** 时间预算（毫秒），默认 400。 */
  timeBudgetMs?: number
  /** 最多校验几个候选（每个可能是一次几十 MB 的读取），默认 4。 */
  maxValidations?: number
  /** 便于单测推进时间。 */
  now?: () => number
}

const DEFAULT_MAX_ENTRIES = 20_000
const DEFAULT_TIME_BUDGET_MS = 400
const DEFAULT_MAX_VALIDATIONS = 4

/** 插件文件名（`pepflashplayer64_34_0_0_384.dll` 这种带版本后缀的也算）。 */
export function isFlashPluginFileName(name: string, platform: NodeJS.Platform = process.platform): boolean {
  const lower = name.toLowerCase()
  if (platform === 'win32') return /^pepflashplayer(64)?(_[\d_]+)?\.dll$/.test(lower)
  if (platform === 'darwin') return lower === 'pepperflashplayer'
  return /^lib?pepflashplayer\.so(\.[\d.]+)?$/.test(lower)
}

/**
 * 从路径里猜版本号：文件名优先，取不到再看上级目录。
 *
 * 两种真实布局都要覆盖：
 * - `System32\Macromed\Flash\pepflashplayer64_34_0_0_384.dll`（版本在**文件名**里）
 * - `<User Data>\PepperFlash\32.0.0.371\pepflashplayer.dll`（版本在**目录名**里）
 *
 * 连续数字段用 `.`/`_` 连接成一个「数字串」，取最后 4 段——这样
 * `64_34_0_0_384` 会被读成 `34.0.0.384`，而不是把架构号 64 当成主版本。
 */
export function versionFromPath(path: string): number[] | undefined {
  const segments = path.split(/[\\/]+/).filter(Boolean)
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const runs = segments[index].match(/\d+(?:[._]\d+)+/g)
    if (!runs?.length) continue
    const numbers = runs[runs.length - 1].split(/[._]/).map(Number)
    if (numbers.some((value) => !Number.isFinite(value))) continue
    const tail = numbers.slice(-4)
    // 少于 3 段（例如 `pepflashplayer64.dll` 里的 64）不是版本号，继续往上看目录。
    if (tail.length >= 3) return tail
  }
  return undefined
}

function compareVersionRanks(left: number[] | undefined, right: number[] | undefined): number {
  if (!left && !right) return 0
  if (!left) return -1
  if (!right) return 1
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

interface Candidate extends FlashScanHit {
  rank?: number[]
}

/**
 * 扫描若干已知目录，返回**第一个可用**的插件。
 *
 * 停止条件（按优先级）：找到可用插件 / 时间预算用完 / 条目上限用完 / 栈空。
 */
export function scanFlashPlugin(roots: readonly FlashScanRoot[], options: FlashScanOptions): FlashScanResult {
  const now = options.now ?? Date.now
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxValidations = options.maxValidations ?? DEFAULT_MAX_VALIDATIONS
  const deadline = now() + (options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS)

  // 栈是后进先出，先反转一次：调用方给的顺序就是「先扫谁」的顺序，预算用完时
  // 靠后的目录（下载/桌面）才会被放弃。
  const stack = roots.map((root) => ({
    dir: root.path,
    remaining: Math.max(1, root.depth),
    origin: root.origin
  })).reverse()
  const candidates: Candidate[] = []
  let entries = 0
  let visitedDirectories = 0
  let budgetExhausted = false

  while (stack.length > 0) {
    if (entries >= maxEntries) { budgetExhausted = true; break }
    if (now() > deadline) { budgetExhausted = true; break }
    const current = stack.pop()
    if (!current) break

    let dirents
    try {
      dirents = readdirSync(current.dir, { withFileTypes: true })
    } catch {
      // 目录不存在 / 无权限：这是正常情况（候选目录大部分不存在）。
      continue
    }
    visitedDirectories += 1

    for (const dirent of dirents) {
      entries += 1
      if (entries >= maxEntries) { budgetExhausted = true; break }
      if (now() > deadline) { budgetExhausted = true; break }
      const path = join(current.dir, dirent.name)
      if (dirent.isDirectory()) {
        // 只进到调用方给的深度；符号链接/联接点（isDirectory() 为 false）一律不跟，
        // 避免目录环与跨盘展开。
        if (current.remaining > 1) {
          stack.push({ dir: path, remaining: current.remaining - 1, origin: current.origin })
        }
        continue
      }
      if (!dirent.isFile() || !options.match(dirent.name)) continue
      try {
        const info = statSync(path)
        candidates.push({
          path,
          origin: current.origin,
          size: info.size,
          mtimeMs: info.mtimeMs,
          rank: versionFromPath(path)
        })
      } catch {
        continue
      }
    }
  }

  // 版本新的先校验：正常情况下只读一个文件就能定下来。
  candidates.sort((left, right) =>
    compareVersionRanks(right.rank, left.rank) ||
    right.mtimeMs - left.mtimeMs ||
    left.path.localeCompare(right.path))

  let rejected = 0
  for (const candidate of candidates.slice(0, maxValidations)) {
    const verdict = options.validate(candidate.path)
    if (!verdict) {
      rejected += 1
      continue
    }
    const versionNumbers = candidate.rank
    return {
      hit: {
        path: candidate.path,
        origin: candidate.origin,
        size: candidate.size,
        mtimeMs: candidate.mtimeMs,
        version: verdict.version ?? (versionNumbers ? versionNumbers.join('.') : undefined)
      },
      visitedDirectories,
      rejected,
      budgetExhausted
    }
  }

  return { visitedDirectories, rejected, budgetExhausted }
}
