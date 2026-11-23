import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import type { FlashImportResult, FlashPluginSource, FlashPluginState } from '../shared/settings'
import { readPeFileVersion } from './pe-version'

/**
 * PPAPI Flash 插件的定位与导入（BYOP：本产品**不**随包分发 Adobe 二进制）。
 *
 * 解析顺序（架构 §3 引擎 / M1 §9.4）：
 * 1. `BAO_FLASH_PLUGIN` 环境变量；
 * 2. **用户导入**：`<userData>/flash/pepflashplayer64.dll`（设置页「导入插件」写这里，
 *    不需要管理员权限，也不会污染安装目录）；
 * 3. `<exe目录>/flash/`（手工投放）；
 * 4. `<exe目录>/`；
 * 5. `<resources>/`。
 *
 * 插件在启动时用命令行注册（`--register-pepper-plugins`），所以**导入后需要重启**才生效；
 * 状态里带 `restartRequired` 供界面提示。
 */
const PLUGIN_FILE_NAME = process.platform === 'win32' ? 'pepflashplayer64.dll' : 'libpepflashplayer.so'
const DROPIN_DIR = 'flash'
const ALLOWED_EXTENSIONS = ['.dll', '.so', '.dylib']

export interface FlashPluginCandidate {
  path: string
  source: FlashPluginSource
}

function userDropIn(): string {
  return join(app.getPath('userData'), DROPIN_DIR, PLUGIN_FILE_NAME)
}

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

export function resolveFlashPlugin(): FlashPluginCandidate | undefined {
  return flashCandidates().find((candidate) => existsSync(candidate.path))
}

/**
 * 当前插件状态。`loaded` 是**本进程启动时**是否已注册（由 `plugins.ts` 传进来），
 * 用来区分「就绪」与「已导入但需要重启」。
 */
export function flashPluginStatus(loaded: boolean): FlashPluginState {  const resolved = resolveFlashPlugin()
  const hint = userDropIn()
  if (!resolved) return { ready: false, path: hint, restartRequired: false }
  let size: number | undefined
  try {
    size = statSync(resolved.path).size
  } catch {
    size = undefined
  }
  return {
    ready: loaded,
    path: resolved.path,
    version: readPeFileVersion(resolved.path),
    size,
    source: resolved.source,
    // 磁盘上有了、但启动时没注册上 → 必须重启
    restartRequired: !loaded
  }
}

/** 把用户选中的文件复制成 `<userData>/flash/pepflashplayer64.dll`。 */
export function importFlashPlugin(source: string, loaded: boolean): FlashImportResult {
  if (!ALLOWED_EXTENSIONS.includes(extname(source).toLowerCase())) return { ok: false, code: 'invalid' }
  const target = userDropIn()
  try {
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
  } catch {
    return { ok: false, code: 'copy-failed' }
  }
  return { ok: true, status: flashPluginStatus(loaded) }
}
