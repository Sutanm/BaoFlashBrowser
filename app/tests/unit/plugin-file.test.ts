import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectNativePlugin, isUsableNativePlugin } from '../../src/main/plugin-file'

/**
 * 「这个文件能不能当 PPAPI 插件加载」的跨平台判断。
 *
 * Windows 的 PE 解析已由 `pe-plugin.test.ts` 覆盖，这里补：真实插件正例、非插件反例，
 * 以及 POSIX 的 ELF / Mach-O 魔数与位宽判断（避免把 32 位 .so 当插件注册上去）。
 */
const runtimePlugin = join(process.cwd(), '.runtime', 'win-x64', 'pepflashplayer64.dll')
const tempDirs: string[] = []

function tempImage(name: string, bytes: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'bao-plugin-file-'))
  tempDirs.push(dir)
  const path = join(dir, name)
  writeFileSync(path, bytes)
  return path
}

function elfBuffer({ is64, pepper }: { is64: boolean; pepper: boolean }): Buffer {
  const buffer = Buffer.alloc(128)
  buffer.writeUInt32BE(0x7f454c46, 0)
  buffer[4] = is64 ? 2 : 1
  if (pepper) Buffer.from('PPP_GetInterface').copy(buffer, 64)
  return buffer
}

function machoBuffer({ is64, pepper }: { is64: boolean; pepper: boolean }): Buffer {
  const buffer = Buffer.alloc(128)
  buffer.writeUInt32LE(is64 ? 0xfeedfacf : 0xfeedface, 0)
  if (pepper) Buffer.from('PPP_GetInterface').copy(buffer, 64)
  return buffer
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('inspectNativePlugin / isUsableNativePlugin', () => {
  it('非 PE/ELF 文件一律不可用', () => {
    const text = join(process.cwd(), 'package.json')
    expect(inspectNativePlugin(text, 'win32')).toBeUndefined()
    expect(isUsableNativePlugin(text, 'win32')).toBe(false)
  })

  it.skipIf(!existsSync(runtimePlugin))('真实 pepflashplayer64.dll 可用（64 位 + PPP_* 导出）', () => {
    const info = inspectNativePlugin(runtimePlugin, 'win32')
    expect(info?.is64).toBe(true)
    expect(info?.hasPepperExports).toBe(true)
    expect(isUsableNativePlugin(runtimePlugin, 'win32')).toBe(true)
  })

  it('ELF：64 位且含 PPP_GetInterface 才可用', () => {
    expect(isUsableNativePlugin(tempImage('ok.so', elfBuffer({ is64: true, pepper: true })), 'linux')).toBe(true)
    expect(isUsableNativePlugin(tempImage('32.so', elfBuffer({ is64: false, pepper: true })), 'linux')).toBe(false)
    expect(isUsableNativePlugin(tempImage('other.so', elfBuffer({ is64: true, pepper: false })), 'linux')).toBe(false)
  })

  it('Mach-O：64 位可用，32 位拒绝', () => {
    const good = tempImage('PepperFlashPlayer', machoBuffer({ is64: true, pepper: true }))
    expect(isUsableNativePlugin(good, 'darwin')).toBe(true)
    const bad = tempImage('PepperFlashPlayer32', machoBuffer({ is64: false, pepper: true }))
    expect(isUsableNativePlugin(bad, 'darwin')).toBe(false)
  })

  it('跨平台不会误判（Linux 的 ELF 在 Windows 判定下不可用）', () => {
    const elf = tempImage('libpepflashplayer.so', elfBuffer({ is64: true, pepper: true }))
    expect(isUsableNativePlugin(elf, 'win32')).toBe(false)
  })
})
