import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FlashDiscoveryOptions } from '../../src/main/flash-discovery'
import { discoverFlashPlugin, discoveryCachePath, discoveryDisabled } from '../../src/main/flash-discovery'
import { isFlashPluginFileName } from '../../src/main/flash-scan'

/**
 * 自动发现的编排层：缓存写/读/失效、开关、以及「用户已有插件优先」在调用侧的前提。
 *
 * 扫描与 PE 校验已各自有用例，这里把校验器注入掉，只验证缓存语义——它是启动路径上
 * 唯一会「重扫整盘」的东西，坏了就是每次启动都慢。
 */
const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bao-flash-discovery-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scenario(): { options: FlashDiscoveryOptions; plugin: string } {
  const userDataDir = tempDir()
  const pluginDir = tempDir()
  const plugin = join(pluginDir, 'pepflashplayer64_34_0_0_384.dll')
  writeFileSync(plugin, Buffer.alloc(1024))
  return {
    plugin,
    options: {
      userDataDir,
      platform: 'win32',
      env: {},
      roots: [{ path: pluginDir, depth: 1, origin: 'system-flash' }],
      match: (name) => isFlashPluginFileName(name, 'win32'),
      validate: () => ({ version: '34.0.0.384' })
    }
  }
}

describe('discoverFlashPlugin', () => {
  it('第一次扫到并写缓存；第二次直接命中缓存，不再扫盘', () => {
    const { options, plugin } = scenario()
    const first = discoverFlashPlugin(options)
    expect(first).toMatchObject({ path: plugin, origin: 'system-flash', version: '34.0.0.384', fromCache: false })
    expect(existsSync(discoveryCachePath(options.userDataDir))).toBe(true)

    // 候选目录换成一个空列表：只有走缓存才可能还找得到。
    const second = discoverFlashPlugin({ ...options, roots: [] })
    expect(second?.fromCache).toBe(true)
    expect(second?.path).toBe(plugin)
  })

  it('force 忽略缓存，重新扫描', () => {
    const { options } = scenario()
    expect(discoverFlashPlugin(options)?.fromCache).toBe(false)
    expect(discoverFlashPlugin({ ...options, force: true })?.fromCache).toBe(false)
  })

  it('缓存里的文件被删掉后视为未找到，并清掉缓存', () => {
    const { options, plugin } = scenario()
    expect(discoverFlashPlugin(options)).toBeDefined()
    rmSync(plugin)
    expect(discoverFlashPlugin({ ...options, roots: [] })).toBeUndefined()
    expect(existsSync(discoveryCachePath(options.userDataDir))).toBe(false)
  })

  it('文件大小变了要重新扫描（别继续信任旧缓存）', () => {
    const { options, plugin } = scenario()
    discoverFlashPlugin(options)
    writeFileSync(plugin, Buffer.alloc(2048))
    const after = discoverFlashPlugin({ ...options, force: false })
    expect(after?.fromCache).toBe(false)
    expect(after?.size).toBe(2048)
  })

  it('缓存里的路径不像插件文件名时不采信（缓存文件是用户可写的）', () => {
    const { options } = scenario()
    const first = discoverFlashPlugin(options)
    expect(first).toBeDefined()
    const other = join(dirname(first!.path), 'pepflashplayer-notes.txt')
    copyFileSync(first!.path, other)
    writeFileSync(discoveryCachePath(options.userDataDir), JSON.stringify({
      version: 1,
      path: other,
      origin: 'system-flash',
      size: statSync(other).size,
      scannedAt: 1
    }))
    // 缓存被拒 → 重新扫描；候选列表为空 → 扫不到。
    expect(discoverFlashPlugin({ ...options, roots: [] })).toBeUndefined()
  })

  it('BAO_FLASH_DISCOVERY=off 时完全不扫盘', () => {
    const { options, plugin } = scenario()
    expect(discoverFlashPlugin({ ...options, env: { BAO_FLASH_DISCOVERY: 'off' } })).toBeUndefined()
    expect(existsSync(discoveryCachePath(options.userDataDir))).toBe(false)
    expect(existsSync(plugin)).toBe(true)
  })
})

describe('discoveryDisabled', () => {
  it('只认明确的关闭值', () => {
    for (const value of ['off', 'OFF', '0', 'false', 'no']) {
      expect(discoveryDisabled({ BAO_FLASH_DISCOVERY: value })).toBe(true)
    }
    for (const value of [undefined, '', 'on', '1', 'true']) {
      expect(discoveryDisabled({ BAO_FLASH_DISCOVERY: value })).toBe(false)
    }
  })
})
