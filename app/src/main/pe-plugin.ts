import { readFileSync } from 'node:fs'

/**
 * PPAPI 插件的 PE 校验（导入前用）。
 *
 * 审计 P2：之前只按扩展名接受，随便一个 `.dll` 都能被复制成
 * `<userData>/flash/pepflashplayer64.dll`，然后状态显示「已就绪、重启即可」，
 * 重启后插件加载失败——用户拿到的是一次没有任何提示的失败。
 *
 * 这里做两项检查：
 * 1. PE 头与机器类型（x64 必须是 `0x8664`）——32 位 DLL 必装不上；
 * 2. **解析导出表**确认导出了 `PPP_GetInterface`（Chromium 的 Pepper 加载器按它取入口）。
 *    不能只做字节搜索：`electron.exe` 里也含这个字符串（链接了 PPAPI 胶水），会误判。
 *
 * 不 import electron：这样可以在纯 Node 单测里验证。
 */
export interface PePluginInfo {
  /** PE 机器类型（0x8664 = x86-64，0x14c = x86）。 */
  readonly machine: number
  readonly is64: boolean
  readonly hasPepperExports: boolean
}

const MACHINE_AMD64 = 0x8664
const MAX_EXPORT_NAMES = 4096

/** 把 RVA 映射成文件偏移；越界返回 -1。 */
function rvaToOffset(buffer: Buffer, sectionTable: number, sections: number, rva: number): number {
  for (let index = 0; index < sections; index += 1) {
    const entry = sectionTable + index * 40
    if (entry + 40 > buffer.length) return -1
    const virtualSize = buffer.readUInt32LE(entry + 8)
    const virtualAddress = buffer.readUInt32LE(entry + 12)
    const rawOffset = buffer.readUInt32LE(entry + 20)
    if (rva >= virtualAddress && rva < virtualAddress + Math.max(virtualSize, 1)) {
      return rawOffset + (rva - virtualAddress)
    }
  }
  return -1
}

function exportNames(buffer: Buffer): string[] {
  const peOffset = buffer.readUInt32LE(0x3c)
  const sections = buffer.readUInt16LE(peOffset + 6)
  const optionalHeader = peOffset + 24
  const magic = buffer.readUInt16LE(optionalHeader)
  const dataDirectories = optionalHeader + (magic === 0x20b ? 112 : 96)
  const sectionTable = optionalHeader + buffer.readUInt16LE(peOffset + 20)
  if (dataDirectories + 8 > buffer.length) return []

  const exportRva = buffer.readUInt32LE(dataDirectories)
  if (!exportRva) return []
  const exportOffset = rvaToOffset(buffer, sectionTable, sections, exportRva)
  if (exportOffset < 0 || exportOffset + 40 > buffer.length) return []

  const nameCount = Math.min(buffer.readUInt32LE(exportOffset + 24), MAX_EXPORT_NAMES)
  const namesOffset = rvaToOffset(buffer, sectionTable, sections, buffer.readUInt32LE(exportOffset + 32))
  if (namesOffset < 0) return []

  const names: string[] = []
  for (let index = 0; index < nameCount; index += 1) {
    const pointerOffset = namesOffset + index * 4
    if (pointerOffset + 4 > buffer.length) break
    const nameOffset = rvaToOffset(buffer, sectionTable, sections, buffer.readUInt32LE(pointerOffset))
    if (nameOffset < 0 || nameOffset >= buffer.length) continue
    let end = nameOffset
    while (end < buffer.length && buffer[end] !== 0) end += 1
    names.push(buffer.toString('latin1', nameOffset, end))
  }
  return names
}

export function inspectPePlugin(path: string): PePluginInfo | undefined {
  let buffer: Buffer
  try {
    buffer = readFileSync(path)
  } catch {
    return undefined
  }
  if (buffer.length < 0x40 || buffer.readUInt16LE(0) !== 0x5a4d) return undefined
  const peOffset = buffer.readUInt32LE(0x3c)
  if (peOffset + 0x18 > buffer.length) return undefined
  if (buffer.readUInt32LE(peOffset) !== 0x00004550) return undefined
  const machine = buffer.readUInt16LE(peOffset + 4)
  const names = exportNames(buffer)
  return {
    machine,
    is64: machine === MACHINE_AMD64,
    hasPepperExports: names.includes('PPP_GetInterface')
  }
}

/** 这个文件能不能当作本产品的 PPAPI 插件用。 */
export function isUsablePepperPlugin(path: string): boolean {
  const info = inspectPePlugin(path)
  return !!info && info.is64 && info.hasPepperExports
}
