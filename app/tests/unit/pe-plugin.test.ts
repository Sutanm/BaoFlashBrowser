import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectPePlugin, isUsablePepperPlugin } from '../../src/main/pe-plugin'

const runtime = join(process.cwd(), '.runtime', 'win-x64')
const plugin = join(runtime, 'pepflashplayer64.dll')
const electron = join(runtime, 'electron.exe')

describe('PPAPI 插件的 PE 校验', () => {
  it('拒绝非 PE 文件（按扩展名蒙混的导入）', () => {
    const text = join(process.cwd(), 'package.json')
    expect(inspectPePlugin(text)).toBeUndefined()
    expect(isUsablePepperPlugin(text)).toBe(false)
  })

  it.skipIf(!existsSync(electron))('electron.exe 是 PE 但不是 Pepper 插件', () => {
    const info = inspectPePlugin(electron)
    expect(info?.is64).toBe(true)
    expect(info?.hasPepperExports).toBe(false)
    expect(isUsablePepperPlugin(electron)).toBe(false)
  })

  it.skipIf(!existsSync(plugin))('真实 pepflashplayer64.dll（导出 PPP_* 接口）通过校验', () => {
    const info = inspectPePlugin(plugin)
    expect(info?.is64).toBe(true)
    expect(info?.hasPepperExports).toBe(true)
    expect(isUsablePepperPlugin(plugin)).toBe(true)
  })
})
