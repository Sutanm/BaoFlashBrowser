import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { knownFlashRoots } from './flash-roots'
import type { FlashScanRoot } from './flash-scan'
import { isFlashPluginFileName, scanFlashPlugin } from './flash-scan'
import { isUsableNativePlugin } from './plugin-file'
import { readPeFileVersion } from './pe-version'

/**
 * 自动发现：在本机常见位置找一份**已经存在**的 PPAPI 插件（BYOP 的另一半）。
 *
 * 与「手工导入」的分工：
 * - 手工导入（设置页「导入」）把文件复制到 `<userData>/flash/`，**优先级最高**，
 *   用户需要特定版本时仍然走这条路；
 * - 自动发现只在前面所有投放位置都没有插件时才跑，结果不复制、不移动，只记住路径。
 *
 * 扫描是启动路径上的同步操作（插件必须在 `app.ready` 前注册），因此结果写进
 * `<userData>/flash/discovery.json`：下次启动只 `stat` 一次就能确认缓存还成立，
 * 不必重扫。缓存失效（文件被删/大小变了）就重扫并覆盖，扫不到就删掉缓存。
 *
 * 关闭开关：`BAO_FLASH_DISCOVERY=off`（成品冒烟需要「明确没有插件」的场景会用它）。
 */

export interface FlashDiscovery {
  path: string
  /** 来源标签（`system-flash` / `chrome` / `downloads` …）。 */
  origin: string
  size: number
  mtimeMs: number
  /** 插件版本（PE 资源里的版本串，或从路径推断）。 */
  version?: string
  /** 这次结果来自哪次扫描（毫秒时间戳；命中缓存时是上次扫描时间）。 */
  scannedAt: number
  /** 是否直接来自缓存（没有重新扫盘）。 */
  fromCache: boolean
}

export interface FlashDiscoveryOptions {
  userDataDir: string
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  homeDir?: string
  /** 忽略缓存，强制重新扫描。 */
  force?: boolean
  now?: () => number
  /** 测试注入：候选目录。 */
  roots?: readonly FlashScanRoot[]
  timeBudgetMs?: number
  maxEntries?: number
  /** 测试注入：文件名匹配与可用性校验。 */
  match?: (name: string) => boolean
  validate?: (path: string) => { version?: string } | undefined
}

const CACHE_VERSION = 1

interface CacheRecord {
  version: number
  path: string
  origin: string
  size: number
  pluginVersion?: string
  scannedAt: number
}

/** 缓存文件与插件投放目录同层（`<userData>/flash/`），便于用户一眼看到最近的扫描结果。 */
export function discoveryCachePath(userDataDir: string): string {
  return join(userDataDir, 'flash', 'discovery.json')
}

/** `BAO_FLASH_DISCOVERY=off|0|false|no` 时完全不扫盘（只用手工导入/投放）。 */
export function discoveryDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = (env.BAO_FLASH_DISCOVERY ?? '').trim().toLowerCase()
  return value === 'off' || value === '0' || value === 'false' || value === 'no'
}

/** 本机是否已经有可加载的 Flash 插件（自动发现）。找不到返回 `undefined`。 */
export function discoverFlashPlugin(options: FlashDiscoveryOptions): FlashDiscovery | undefined {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  if (discoveryDisabled(env)) return undefined

  const cacheFile = discoveryCachePath(options.userDataDir)
  if (!options.force) {
    const cached = readCache(cacheFile, platform)
    if (cached) return cached
  }

  const match = options.match ?? ((name: string) => isFlashPluginFileName(name, platform))
  const validate = options.validate ?? ((path: string) => {
    if (!isUsableNativePlugin(path, platform)) return undefined
    return { version: platform === 'win32' ? readPeFileVersion(path) : undefined }
  })
  const roots = options.roots ?? knownFlashRoots({ platform, env, homeDir: options.homeDir })
  const result = scanFlashPlugin(roots, {
    match,
    validate,
    timeBudgetMs: options.timeBudgetMs,
    maxEntries: options.maxEntries,
    now: options.now
  })

  if (!result.hit) {
    // 扫不到就把旧缓存清掉：留着它会让下一次启动继续引用一个已失效的路径。
    removeCache(cacheFile)
    if (result.budgetExhausted) {
      console.warn('[flash] 自动发现因时间/条目预算提前结束，可能还有未扫描的位置。')
    }
    return undefined
  }

  const discovery: FlashDiscovery = {
    path: result.hit.path,
    origin: result.hit.origin,
    size: result.hit.size,
    mtimeMs: result.hit.mtimeMs,
    version: result.hit.version,
    scannedAt: (options.now ?? Date.now)(),
    fromCache: false
  }
  writeCache(cacheFile, discovery)
  return discovery
}

/**
 * 读缓存。唯一的新鲜度判据是「路径还在 ∧ 大小没变」。
 *
 * 不在这里重新做 PE 校验：那等于把 30 MB 文件读一遍，而缓存的全部意义就是省掉这次读。
 * 文件被换成另一个同大小插件的概率可以忽略，且换插件本来就要重启才生效。
 */
function readCache(file: string, platform: NodeJS.Platform): FlashDiscovery | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
  const record = parsed as Partial<CacheRecord>
  if (record?.version !== CACHE_VERSION) return undefined
  if (typeof record.path !== 'string' || typeof record.origin !== 'string') return undefined
  if (typeof record.size !== 'number' || typeof record.scannedAt !== 'number') return undefined
  // 缓存文件是用户可写的普通 JSON：只接受「文件名仍然像插件」的路径，避免被改成任意文件。
  if (!isFlashPluginFileName(basename(record.path), platform)) return undefined
  if (!existsSync(record.path)) return undefined
  let info
  try {
    info = statSync(record.path)
  } catch {
    return undefined
  }
  if (!info.isFile() || info.size !== record.size) return undefined
  return {
    path: record.path,
    origin: record.origin,
    size: record.size,
    mtimeMs: info.mtimeMs,
    version: typeof record.pluginVersion === 'string' ? record.pluginVersion : undefined,
    scannedAt: record.scannedAt,
    fromCache: true
  }
}

function writeCache(file: string, discovery: FlashDiscovery): void {
  const record: CacheRecord = {
    version: CACHE_VERSION,
    path: discovery.path,
    origin: discovery.origin,
    size: discovery.size,
    pluginVersion: discovery.version,
    scannedAt: discovery.scannedAt
  }
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(record, undefined, 2)}\n`, 'utf8')
  } catch (error) {
    // 缓存写失败只影响下次启动要不要重扫，不该阻止启动。
    console.warn('[flash] 自动发现结果未能写入缓存。', error)
  }
}

function removeCache(file: string): void {
  try {
    rmSync(file, { force: true })
  } catch {
    // 忽略：删不掉就等下次扫描覆盖。
  }
}
