import { readFileSync } from 'node:fs'

/**
 * 读取 PE 文件的固定版本号（`VS_FIXEDFILEINFO`），例如 `29.0.0.171`。
 *
 * 为什么自己解析：Electron 没有暴露 `GetFileVersionInfo`，而「插件就绪 + 版本号」是
 * 导入流程要显示的**可验证**信息（用户要能确认放进去的确实是 29.0.0.171）。
 * 非 PE 文件、解析越界一律返回 `undefined`，调用方按「版本未知」显示。
 */
export function readPeFileVersion(path: string): string | undefined {
  let buffer: Buffer
  try {
    buffer = readFileSync(path)
  } catch {
    return undefined
  }
  try {
    return parse(buffer)
  } catch {
    return undefined
  }
}

function parse(buffer: Buffer): string | undefined {
  const u16 = (offset: number): number => buffer.readUInt16LE(offset)
  const u32 = (offset: number): number => buffer.readUInt32LE(offset)

  if (buffer.length < 0x40 || buffer.toString('latin1', 0, 2) !== 'MZ') return undefined
  const peOffset = u32(0x3c)
  if (peOffset + 24 > buffer.length) return undefined
  if (buffer.toString('latin1', peOffset, peOffset + 4) !== 'PE\u0000\u0000') return undefined

  const coff = peOffset + 4
  const sectionCount = u16(coff + 2)
  const optionalSize = u16(coff + 16)
  const optional = coff + 20
  if (optional + optionalSize > buffer.length) return undefined

  const magic = u16(optional)
  const directoryOffset = magic === 0x20b ? 112 : magic === 0x10b ? 96 : undefined
  if (directoryOffset === undefined) return undefined

  // 数据目录第 3 项 = 资源表（RVA + 大小）
  const resourceRva = u32(optional + directoryOffset + 2 * 8)
  if (!resourceRva) return undefined

  const sectionTable = optional + optionalSize
  const toFileOffset = (rva: number): number | undefined => {
    for (let index = 0; index < sectionCount; index += 1) {
      const section = sectionTable + index * 40
      if (section + 40 > buffer.length) return undefined
      const virtualAddress = u32(section + 12)
      const rawSize = u32(section + 16)
      const rawPointer = u32(section + 20)
      if (rva >= virtualAddress && rva < virtualAddress + Math.max(rawSize, 1)) {
        return rawPointer + (rva - virtualAddress)
      }
    }
    return undefined
  }

  const resourceBase = toFileOffset(resourceRva)
  if (resourceBase === undefined) return undefined

  /** 资源目录的一层：返回同名条目的子目录偏移（相对资源表起点）。 */
  const childDirectory = (directoryOffsetInResource: number, id: number): number | undefined => {
    const directory = resourceBase! + directoryOffsetInResource
    if (directory + 16 > buffer.length) return undefined
    const entries = u16(directory + 12) + u16(directory + 14)
    for (let index = 0; index < entries; index += 1) {
      const entry = directory + 16 + index * 8
      if (entry + 8 > buffer.length) return undefined
      const name = u32(entry)
      const target = u32(entry + 4)
      if ((name & 0x80000000) !== 0) continue // 字符串名，不是我们要的数字 ID
      if ((name & 0xffff) !== id) continue
      if ((target & 0x80000000) === 0) return undefined // 不是子目录
      return target & 0x7fffffff
    }
    return undefined
  }

  // 类型 16 = RT_VERSION → 名称 1 → 第一门语言
  const versionType = childDirectory(0, 16)
  if (versionType === undefined) return undefined
  const versionName = childDirectory(versionType, 1)
  if (versionName === undefined) return undefined

  const languageDirectory = resourceBase + versionName
  if (languageDirectory + 20 > buffer.length) return undefined
  if (u16(languageDirectory + 12) + u16(languageDirectory + 14) === 0) return undefined
  const dataEntry = resourceBase + (u32(languageDirectory + 16 + 4) & 0x7fffffff)
  if (dataEntry + 8 > buffer.length) return undefined
  const dataOffset = toFileOffset(u32(dataEntry))
  if (dataOffset === undefined) return undefined

  // VS_VERSIONINFO：6 字节头 + "VS_VERSION_INFO\0"（16 个 UTF-16 字符 = 32 字节），
  // 之后按 4 字节对齐（38 → 40）才是 VS_FIXEDFILEINFO。
  const fixed = dataOffset + 40
  if (fixed + 52 > buffer.length) return undefined
  if (u32(fixed) !== 0xfeef04bd) return undefined

  const ms = u32(fixed + 8)
  const ls = u32(fixed + 12)
  return [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff].join('.')
}
