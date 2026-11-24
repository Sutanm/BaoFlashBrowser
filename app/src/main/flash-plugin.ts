import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import type { FlashImportResult, FlashPluginSource, FlashPluginState } from '../shared/settings'
import type { FlashDiscovery } from './flash-discovery'
import { discoverFlashPlugin } from './flash-discovery'
import { inspectNativePlugin } from './plugin-file'
import { readPeFileVersion } from './pe-version'

/**
 * PPAPI Flash 插件的定位与导入（BYOP：本产品**不**随包分发 Adobe 二进制）。
 *
 * 解析顺序（架构 §3 引擎 / M1 §9.4）：
 * 1. `BAO_FLASH_PLUGIN` 环境变量（显式覆盖，调试/验收用）；
 * 2. **用户导入**：`<userData>/flash/pepflashplayer64.dll`（设置页「导入插件」写这里，
 *    不需要管理员权限，也不会污染安装目录）；
 * 3. `<exe目录>/flash/`（手工投放）；
 * 4. `<exe目录>/`；
 * 5. `<resources>/`；
 * 6. **自动发现**：在本机常见位置（系统 Macromed、Chrome/Chromium 的 PepperFlash、
 *    国产双核浏览器、下载/桌面目录）找一份已经存在的插件，见 `flash-discovery.ts`。
 *
 * 1–5 是「用户明确给的插件」，只要存在就**不会**退到 6：用户导入某个特定版本时，
 * 不能被机器上另一份更新/更旧的插件顶掉。只有前五档都没有时才会扫盘。
 *
 * 插件在启动时用命令行注册（`--register-pepper-plugins`），所以**导入/新发现后需要重启**
 * 才生效；状态里带 `restartRequired` 供界面提示。
 */
const PLUGIN_FILE_NAME = process.platform === 'win32' ? 'pepflashplayer64.dll' : 'libpepflashplayer.so'
const DROPIN_DIR = 'flash'
const ALLOWED_EXTENSIONS = ['.dll', '.so', '.dylib']

export interface FlashPluginCandidate {
  path: string
  source: FlashPluginSource
  /** 自动发现的来源标签（仅 `source === 'scan'`）。 */
  origin?: string
  version?: string
  size?: number
  /** 发现时间（毫秒时间戳），仅 `source === 'scan'`。 */
  discoveredAt?: number
}

export interface FlashResolveOptions {
  /** 忽略自动发现的缓存，强制重扫（设置页「重新扫描」）。 */
  force?: boolean
}

interface VersionMemo {
  size: number
  mtimeMs: number
  version?: string
}

/** 读 PE 版本要整读文件（30 MB），状态被反复查询时不要重复读。 */
const versionMemo = new Map<string, VersionMemo>()

/** 本进程内自动发现的结果缓存：没找到也要记住，否则每次查状态都会重扫磁盘。 */
let discoveryMemo: FlashDiscovery | undefined
let discoveryResolved = false

function userDropIn(): string {
  return join(app.getPath('userData'), DROPIN_DIR, PLUGIN_FILE_NAME)
}

function pluginVersion(path: string): string | undefined {
  try {
    const info = statSync(path)
    const memo = versionMemo.get(path)
    if (memo && memo.size === info.size && memo.mtimeMs === info.mtimeMs) return memo.version
    const version = readPeFileVersion(path)
    versionMemo.set(path, { size: info.size, mtimeMs: info.mtimeMs, version })
    return version
  } catch {
    return undefined
  }
}

/** 用户显式提供的位置（1–5 档），按优先级排列。 */
export function flashCandidates(): FlashPluginCandidate[] {
  const exeDir = dirname(process.execPath)
  const candidates: Array<FlashPluginCandidate | undefined> = [
    process.env.BAO_FLASH_PLUGIN ? { path: process.env.BAO_FLASH_PLUGIN, source: 'env' } : undefined,
    { path: userDropIn(), source: 'user' },
    { path: join(exeDir, DROPIN_DIR, PLUGIN_FILE_NAME), source: 'exe' },
    { path: join(exeDir, PLUGIN_FILE_NAME), source: 'exe' },
    { path: join(process.resourcesPath, PLUGIN_FILE_NAME), source: 'resources' }
  ]
  return candidates.filter((candidate): candidate is FlashPluginCandidate => !!candidate)
}

/** 自动发现（6 档）：结果按进程缓存，`force` 时重扫。 */
function scanCandidate(force: boolean | undefined): FlashPluginCandidate | undefined {
  if (force || !discoveryResolved) {
    discoveryMemo = discoverFlashPlugin({ userDataDir: app.getPath('userData'), force })
    discoveryResolved = true
  }
  const found = discoveryMemo
  // 缓存说在这里，但文件已经被删掉（用户卸载了 Flash）：按没找到处理。
  if (!found || !existsSync(found.path)) return undefined
  return {
    path: found.path,
    source: 'scan',
    origin: found.origin,
    version: found.version,
    size: found.size,
    discoveredAt: found.scannedAt
  }
}

/**
 * 当前生效的插件。用户给的位置优先，只有它们都没有时才自动发现。
 *
 * 注意：这里只判「文件存在」，不重复做 PE 校验（手工投放一向如此，校验发生在导入时）。
 * 自动发现的那一份在扫描阶段已经过 PE/Pepper 校验。
 */
export function resolveFlashPlugin(options: FlashResolveOptions = {}): FlashPluginCandidate | undefined {
  for (const candidate of flashCandidates()) {
    if (!existsSync(candidate.path)) continue
    return { ...candidate, version: pluginVersion(candidate.path) }
  }
  return scanCandidate(options.force)
}

/**
 * 当前插件状态。`loadedPath` 是**本进程启动时**实际注册的路径（由 `plugins.ts` 传进来）。
 *
 * 「就绪」的判据是「启动时注册的路径 == 现在解析到的路径」：只比较 `loaded` 布尔值会把
 * 「启动时加载的是自动发现的那份、之后用户又导入了另一个版本」误报成已就绪。
 */
export function flashPluginStatus(loadedPath: string | undefined, options: FlashResolveOptions = {}): FlashPluginState {
  const resolved = resolveFlashPlugin(options)
  const hint = userDropIn()
  // 磁盘上的选择与本进程注册的不一致 → 必须重启才能生效。
  const restartRequired = resolved ? resolved.path !== loadedPath : loadedPath !== undefined
  if (!resolved) return { ready: false, found: false, path: hint, restartRequired }

  let size = resolved.size
  if (size === undefined) {
    try {
      size = statSync(resolved.path).size
    } catch {
      size = undefined
    }
  }
  return {
    ready: resolved.path === loadedPath,
    found: true,
    path: resolved.path,
    version: resolved.version ?? pluginVersion(resolved.path),
    size,
    source: resolved.source,
    origin: resolved.origin,
    discoveredAt: resolved.discoveredAt,
    restartRequired
  }
}

/** 把用户选中的文件复制成 `<userData>/flash/pepflashplayer64.dll`。 */
export function importFlashPlugin(source: string, loadedPath: string | undefined): FlashImportResult {
  if (!ALLOWED_EXTENSIONS.includes(extname(source).toLowerCase())) return { ok: false, code: 'invalid' }
  // 只按扩展名接受会把「随便一个 dll」复制成插件文件，然后显示「就绪、重启即可」，
  // 重启后却加载失败（审计 P2）。导入前先做 PE / Pepper 导出检查。
  const info = inspectNativePlugin(source)
  if (!info) return { ok: false, code: 'invalid' }
  if (!info.is64) return { ok: false, code: 'not-64-bit' }
  if (!info.hasPepperExports) return { ok: false, code: 'not-pepper' }

  const target = userDropIn()
  try {
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
    // 复制换了内容：文件大小/时间可能不变，主动丢掉版本记忆。
    versionMemo.delete(target)
  } catch {
    return { ok: false, code: 'copy-failed' }
  }
  // 导入写的是 <userData>/flash/，它优先于自动发现；如果环境变量或安装目录里有更高
  // 优先级的候选，状态里会显示那个（source 字段），这里一并返回，界面据此提示「需要重启」。
  const status = flashPluginStatus(loadedPath, { force: true })
  return { ok: true, status: { ...status, restartRequired: status.path !== target || loadedPath !== target } }
}
