import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { knownFlashRoots } from '../../src/main/flash-roots'

/**
 * 已知安装位置：只验证「该给的给了、不该出现的没出现」。
 *
 * 这些目录来自真实机器（flash.cn 安装器、Chrome 组件更新、国产双核浏览器），
 * 具体清单会随版本变化，但几处关键位置必须一直在——少了它们自动发现就基本失效。
 */
describe('knownFlashRoots', () => {
  const windowsEnv = {
    WINDIR: 'C:\\Windows',
    LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
    APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
    USERPROFILE: 'C:\\Users\\u',
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)'
  }

  it('Windows：系统 Macromed 目录排在最前（国内最常见的可加载来源）', () => {
    const roots = knownFlashRoots({ platform: 'win32', env: windowsEnv })
    expect(roots[0]?.path).toBe(join('C:\\Windows', 'System32', 'Macromed', 'Flash'))
    expect(roots[0]?.origin).toBe('system-flash')
    expect(roots.some((root) => root.path.includes('PepperFlash') && root.origin === 'chrome')).toBe(true)
    expect(roots.some((root) => root.origin === 'downloads')).toBe(true)
  })

  it('Windows：深度都很小，不会展开 User Data 这类大目录', () => {
    const roots = knownFlashRoots({ platform: 'win32', env: windowsEnv })
    for (const root of roots) {
      expect(root.depth).toBeGreaterThanOrEqual(1)
      expect(root.depth).toBeLessThanOrEqual(4)
    }
  })

  it('缺少环境变量时只跳过对应条目，不产生 undefined 路径', () => {
    const roots = knownFlashRoots({ platform: 'win32', env: { USERPROFILE: 'C:\\Users\\u' } })
    for (const root of roots) {
      expect(typeof root.path).toBe('string')
      expect(root.path).not.toContain('undefined')
      expect(root.path.startsWith('C:\\Users\\u')).toBe(true)
    }
  })

  it('同样的目录只出现一次（大小写不敏感）', () => {
    const roots = knownFlashRoots({
      platform: 'win32',
      env: { ...windowsEnv, PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'c:\\program files' }
    })
    const keys = roots.map((root) => root.path.toLowerCase())
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('Linux / macOS：各自的包位置也在清单里', () => {
    const linux = knownFlashRoots({ platform: 'linux', env: {}, homeDir: '/home/u' })
    expect(linux.map((root) => root.path)).toContain('/usr/lib/adobe-flashplugin')
    expect(linux.map((root) => root.path)).toContain(join('/home/u', '.config', 'google-chrome', 'PepperFlash'))

    const mac = knownFlashRoots({ platform: 'darwin', env: {}, homeDir: '/Users/u' })
    expect(mac.map((root) => root.path)).toContain('/Library/Internet Plug-Ins')
    expect(mac.map((root) => root.path)).toContain('/Library/Application Support/Google/Chrome/PepperFlash')
  })
})
