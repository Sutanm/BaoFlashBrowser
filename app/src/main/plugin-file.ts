import { readFileSync } from 'node:fs'
import { inspectPePlugin } from './pe-plugin'

/**
 * 平台无关的「这个文件能不能当 PPAPI 插件加载」判断。
 *
 * Windows 走 `pe-plugin.ts` 的导出表解析（**不能**只做字节搜索：`electron.exe` 里也有
 * `PPP_GetInterface` 字符串，会误判）。POSIX 上是 ELF / Mach-O，没有等价的轻量解析器，
 * 因此按「魔数 + 位宽 + 符号名字符串」判断——对 .so/.dylib 来说这已经足够：内核自己
 * 还会在加载时做一次真正的符号解析，我们这里只负责挡掉明显不能用的文件（32 位、随便
 * 一个同名文件）。
 */
export interface NativePluginInfo {
  readonly is64: boolean
  readonly hasPepperExports: boolean
}

const ELF_MAGIC = 0x7f454c46
const ELF_CLASS_64 = 2
const MACHO_MAGIC_64 = 0xfeedfacf
const MACHO_MAGIC_FAT = 0xcafebabe
const PEPPER_ENTRY = 'PPP_GetInterface'

export function inspectNativePlugin(
  path: string,
  platform: NodeJS.Platform = process.platform
): NativePluginInfo | undefined {
  if (platform === 'win32') {
    const info = inspectPePlugin(path)
    return info ? { is64: info.is64, hasPepperExports: info.hasPepperExports } : undefined
  }
  let buffer: Buffer
  try {
    buffer = readFileSync(path)
  } catch {
    return undefined
  }
  return inspectPosixImage(buffer, platform)
}

export function isUsableNativePlugin(path: string, platform: NodeJS.Platform = process.platform): boolean {
  const info = inspectNativePlugin(path, platform)
  return !!info && info.is64 && info.hasPepperExports
}

function inspectPosixImage(buffer: Buffer, platform: NodeJS.Platform): NativePluginInfo | undefined {
  if (buffer.length < 0x40) return undefined
  const hasPepperExports = buffer.includes(PEPPER_ENTRY)
  if (platform === 'darwin') {
    const magic = buffer.readUInt32LE(0)
    // 32 位 Mach-O（0xfeedface）在 64 位进程里必然装不上；universal 包先按可用处理，
    // 具体切片由内核加载器选。
    if (magic === MACHO_MAGIC_64) return { is64: true, hasPepperExports }
    if (buffer.readUInt32BE(0) === MACHO_MAGIC_FAT) return { is64: true, hasPepperExports }
    return undefined
  }
  if (buffer.readUInt32BE(0) !== ELF_MAGIC) return undefined
  // EI_CLASS 在偏移 4：1 = 32 位，2 = 64 位。
  return { is64: buffer[4] === ELF_CLASS_64, hasPepperExports }
}
