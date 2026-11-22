import { app } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 内核自带的 PPAPI Flash 插件（29.0.0.171）。
 *
 * 启动参数与 142 真机报告 §10.15/§10.16 记录的验收命令逐项一致：
 * `--allow-command-line-plugins` 放行命令行插件，`--register-pepper-plugins`
 * 注册 MIME 与版本通告。版本串只用于站点版本门，不冒充其它 Flash 版本。
 *
 * 假设（文档未定，采用可逆最小方案）：插件 DLL 与 electron.exe 同目录时默认启用，
 * `BAO_FLASH_PLUGIN` 可指向其它路径；找不到 DLL 时整体停用并记录原因。
 * 站点级启用范围与沙箱例外属于后续按证据决定的事项。
 * [142 真机报告 §10.16](../../../docs/reports/2026-11-21-142-flash-runtime.md)
 */
const PLUGIN_FILE_NAME = 'pepflashplayer64.dll'
const PLUGIN_DESCRIPTION = 'Shockwave Flash'
const PLUGIN_DISPLAY_VERSION = 'Shockwave Flash 29.0 r0'
const PLUGIN_VERSION = '29.0.0.171'
const PLUGIN_MIME = 'application/x-shockwave-flash'

export interface FlashPluginStatus {
  readonly enabled: boolean
  readonly path?: string
}

export function configureFlashPlugin(): FlashPluginStatus {
  const candidates = [
    process.env.BAO_FLASH_PLUGIN,
    join(dirname(process.execPath), PLUGIN_FILE_NAME),
    join(process.resourcesPath, PLUGIN_FILE_NAME)
  ].filter((value): value is string => !!value)

  const pluginPath = candidates.find((candidate) => existsSync(candidate))
  if (!pluginPath) {
    console.warn(`[flash] 未找到 ${PLUGIN_FILE_NAME}，原生 PPAPI 引擎停用。`)
    return { enabled: false }
  }

  app.commandLine.appendSwitch('allow-command-line-plugins')
  app.commandLine.appendSwitch(
    'register-pepper-plugins',
    `${pluginPath}#${PLUGIN_DESCRIPTION}#${PLUGIN_DISPLAY_VERSION}#${PLUGIN_VERSION};${PLUGIN_MIME}#swf#spl`
  )

  return { enabled: true, path: pluginPath }
}
