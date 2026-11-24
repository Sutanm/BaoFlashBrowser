import { app } from 'electron'
import { dirname, join } from 'node:path'
import type { FlashPluginSource, FlashPluginState } from '../shared/settings'
import { flashCandidates, flashPluginStatus, resolveFlashPlugin } from './flash-plugin'

/**
 * 内核自带的 PPAPI Flash 插件（29.0.0.171）。
 *
 * 启动参数与 142 真机报告 §10.15/§10.16 记录的验收命令逐项一致：
 * `--allow-command-line-plugins` 放行命令行插件，`--register-pepper-plugins`
 * 注册 MIME 与版本通告。版本串只用于站点版本门，不冒充其它 Flash 版本。
 *
 * 插件路径解析见 `flash-plugin.ts`（环境变量 → 用户导入的 `<userData>/flash/` →
 * exe 同级目录 → 自动发现）。注册只在启动时做一次，所以**导入/新发现后需要重启**。
 * [142 真机报告 §10.16](../../../docs/reports/2026-11-21-142-flash-runtime.md)
 */
const PLUGIN_FILE_NAME = process.platform === 'win32' ? 'pepflashplayer64.dll' : 'libpepflashplayer.so'
const PLUGIN_DESCRIPTION = 'Shockwave Flash'
const PLUGIN_DISPLAY_VERSION = 'Shockwave Flash 29.0 r0'
const PLUGIN_VERSION = '29.0.0.171'
const PLUGIN_MIME = 'application/x-shockwave-flash'

/** 本进程启动时实际注册的插件路径；`undefined` 表示没注册上（用于区分「就绪」与「需重启」）。 */
let loadedPath: string | undefined

export interface FlashPluginStatus {
  readonly enabled: boolean
  readonly path?: string
  /** 用户应把插件放到哪个位置（未检测到时用于提示；本产品**不**随包分发 Flash）。 */
  readonly hint: string
  /** 插件从哪来（手工投放/导入，或自动发现）。 */
  readonly source?: FlashPluginSource
}

export function configureFlashPlugin(): FlashPluginStatus {
  // BYOP：本项目不随包分发 Flash。优先用用户自己提供的那份（命令目录的 `flash/` 或设置页导入），
  // 都没有时自动发现本机已安装的插件（`flash-discovery.ts`）。
  const dropIn = join(dirname(process.execPath), 'flash', PLUGIN_FILE_NAME)
  const resolved = resolveFlashPlugin()
  if (!resolved) {
    console.warn(`[flash] 未找到 ${PLUGIN_FILE_NAME}，原生 PPAPI 引擎停用。把插件放到：${dropIn}`)
    return { enabled: false, hint: dropIn }
  }

  app.commandLine.appendSwitch('allow-command-line-plugins')
  app.commandLine.appendSwitch(
    'register-pepper-plugins',
    `${resolved.path}#${PLUGIN_DESCRIPTION}#${PLUGIN_DISPLAY_VERSION}#${PLUGIN_VERSION};${PLUGIN_MIME}#swf#spl`
  )

  loadedPath = resolved.path
  if (resolved.source === 'scan') {
    console.info(`[flash] 自动发现插件：${resolved.path}（来源 ${resolved.origin}）`)
  }
  return { enabled: true, path: resolved.path, hint: dropIn, source: resolved.source }
}

/** 设置页读到的插件状态（版本、大小、来源、是否需要重启）。 */
export function flashStatus(): FlashPluginState {
  return flashPluginStatus(loadedPath)
}

/** 本进程启动时注册的插件路径（导入流程用它判断「导入后要不要重启」）。 */
export function flashLoadedPath(): string | undefined {
  return loadedPath
}

export { flashCandidates }
