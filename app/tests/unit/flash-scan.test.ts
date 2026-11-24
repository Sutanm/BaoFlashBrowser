import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FlashScanRoot } from '../../src/main/flash-scan'
import { isFlashPluginFileName, scanFlashPlugin, versionFromPath } from '../../src/main/flash-scan'

/**
 * 自动发现的扫描层：只要能「在预算内找到最新的那一份、挡掉不能用的」，就不需要真读 30 MB。
 * 校验器在这里是注入的；真正的 PE/Pepper 校验由 `plugin-file` / `pe-plugin` 的用例覆盖。
 */
const roots: string[] = []

function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), 'bao-flash-scan-'))
  roots.push(path)
  return path
}

function touch(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, 'x')
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('versionFromPath', () => {
  it('文件名里带版本（flash.cn 的安装布局）', () => {
    expect(versionFromPath('C:\\Windows\\System32\\Macromed\\Flash\\pepflashplayer64_34_0_0_384.dll'))
      .toEqual([34, 0, 0, 384])
  })

  it('版本在目录名里（Chrome 组件更新的布局）', () => {
    expect(versionFromPath('/x/PepperFlash/32.0.0.371/pepflashplayer.dll')).toEqual([32, 0, 0, 371])
  })

  it('没有版本时返回 undefined（不会把架构号 64 当版本）', () => {
    expect(versionFromPath('C:\\exe\\pepflashplayer64.dll')).toBeUndefined()
    expect(versionFromPath('/usr/lib/libpepflashplayer.so')).toBeUndefined()
  })
})

describe('isFlashPluginFileName', () => {
  it('Windows：带版本后缀与不带后缀都算', () => {
    expect(isFlashPluginFileName('pepflashplayer64.dll', 'win32')).toBe(true)
    expect(isFlashPluginFileName('pepflashplayer64_34_0_0_384.dll', 'win32')).toBe(true)
    expect(isFlashPluginFileName('pepflashplayer.dll', 'win32')).toBe(true)
    expect(isFlashPluginFileName('flashplayer.dll', 'win32')).toBe(false)
    expect(isFlashPluginFileName('pepflashplayer64.dll.bak', 'win32')).toBe(false)
  })

  it('Linux / macOS：各自的库名', () => {
    expect(isFlashPluginFileName('libpepflashplayer.so', 'linux')).toBe(true)
    expect(isFlashPluginFileName('pepflashplayer.dll', 'linux')).toBe(false)
    expect(isFlashPluginFileName('PepperFlashPlayer', 'darwin')).toBe(true)
  })
})

describe('scanFlashPlugin', () => {
  it('在深度内找到插件，按版本从新到旧校验', () => {
    const root = tempRoot()
    touch(join(root, 'pepflashplayer64_30_0_0_1.dll'))
    touch(join(root, 'pepflashplayer64_34_0_0_384.dll'))
    touch(join(root, 'unrelated.dll'))
    touch(join(root, 'nested', 'deep', 'pepflashplayer64_20_0_0_0.dll'))

    const seen: string[] = []
    const result = scanFlashPlugin([{ path: root, depth: 2, origin: 'system-flash' }], {
      match: (name) => isFlashPluginFileName(name, 'win32'),
      validate: (path) => {
        seen.push(path)
        return path.includes('34') ? { version: '34.0.0.384' } : undefined
      }
    })

    expect(result.hit?.version).toBe('34.0.0.384')
    expect(result.hit?.origin).toBe('system-flash')
    // 34 一定先被校验（新版本优先），30 不应被读到。
    expect(seen[0]).toContain('34')
    expect(seen.some((path) => path.includes('30_'))).toBe(false)
  })

  it('超过 depth 的目录不再展开', () => {
    const root = tempRoot()
    touch(join(root, 'a', 'b', 'c', 'pepflashplayer64.dll'))
    const result = scanFlashPlugin([{ path: root, depth: 2, origin: 'exe' }], {
      match: (name) => isFlashPluginFileName(name, 'win32'),
      validate: () => ({})
    })
    expect(result.hit).toBeUndefined()
  })

  it('校验不通过的候选算 rejected，不会被当成结果', () => {
    const root = tempRoot()
    touch(join(root, 'pepflashplayer.dll'))
    const result = scanFlashPlugin([{ path: root, depth: 1, origin: 'chrome' }], {
      match: (name) => isFlashPluginFileName(name, 'win32'),
      // 32 位 Chrome 的组件式 Flash：文件名对、但校验（PE 位数）不过。
      validate: () => undefined
    })
    expect(result.hit).toBeUndefined()
    expect(result.rejected).toBe(1)
  })

  it('校验次数有上限（每个候选可能是几十 MB 的读取）', () => {
    const root = tempRoot()
    for (let index = 1; index <= 6; index += 1) touch(join(root, `pepflashplayer64_3${index}_0_0_1.dll`))
    let validations = 0
    const result = scanFlashPlugin([{ path: root, depth: 1, origin: 'chrome' }], {
      match: (name) => isFlashPluginFileName(name, 'win32'),
      validate: () => {
        validations += 1
        return undefined
      },
      maxValidations: 2
    })
    expect(validations).toBe(2)
    expect(result.rejected).toBe(2)
  })

  it('时间预算用完立即停手，并标记 budgetExhausted', () => {
    const root = tempRoot()
    touch(join(root, 'pepflashplayer64.dll'))
    let clock = 0
    const result = scanFlashPlugin([{ path: root, depth: 1, origin: 'chrome' }], {
      match: (name) => isFlashPluginFileName(name, 'win32'),
      validate: () => ({}),
      timeBudgetMs: 5,
      now: () => (clock += 10)
    })
    expect(result.budgetExhausted).toBe(true)
    expect(result.visitedDirectories).toBe(0)
  })

  it('按调用方给的顺序扫描（预算用完时先扫的目录优先）', () => {
    const first = tempRoot()
    touch(join(first, 'pepflashplayer64.dll'))
    const second = tempRoot()
    touch(join(second, 'pepflashplayer64_99_0_0_1.dll'))
    const result = scanFlashPlugin([
      { path: first, depth: 1, origin: 'first' },
      { path: second, depth: 1, origin: 'second' }
    ], {
      match: (name) => isFlashPluginFileName(name, 'win32'),
      validate: () => ({}),
      maxEntries: 2
    })
    expect(result.hit?.origin).toBe('first')
    expect(result.budgetExhausted).toBe(true)
  })

  it('不存在的目录直接跳过', () => {
    const missing: FlashScanRoot = { path: join(tempRoot(), 'nope'), depth: 2, origin: 'chrome' }
    const result = scanFlashPlugin([missing], {
      match: (name) => isFlashPluginFileName(name, 'win32'),
      validate: () => ({})
    })
    expect(result.hit).toBeUndefined()
    expect(result.visitedDirectories).toBe(0)
  })
})
