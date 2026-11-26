import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { webDarkTheme, webLightTheme } from '@fluentui/tokens'

/**
 * 品牌色的**唯一来源**是 `tokens.css`；静态 HTML 的首帧 CSS 只能抄一份。
 *
 * 为什么要有这条用例（2026-11-26）：`newtab.html` 的 critical CSS 抄了强调色，但第二个色
 * 一直留着 Fluent 的蓝 `#0f6cbd`——于是新标签页第一帧的 logo 渐变是蓝的，Vue 挂载后才变紫。
 * 这类"抄一份然后漂了"的问题光看代码发现不了，只能拿机器盯着。
 */

const RENDERER = join(dirname(fileURLToPath(import.meta.url)), '../../src/renderer')

function read(name: string): string {
  return readFileSync(join(RENDERER, name), 'utf8')
}

/** 取 `tokens.css` 里某一段（浅色 `:root` 或深色 `:root[data-theme="dark"]`）。 */
function cssSection(source: string, dark: boolean): string {
  const marker = ':root[data-theme="dark"]'
  const index = source.indexOf(marker)
  if (index < 0) throw new Error('tokens.css 里没有深色段')
  return dark ? source.slice(index) : source.slice(0, index)
}

function cssVar(section: string, name: string): string {
  const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})`).exec(section)
  if (!match) throw new Error(`没找到 ${name}`)
  return match[1].toLowerCase()
}

/** 取 HTML 的 critical CSS 段：`:root { … }` 与 `@media (prefers-color-scheme: dark)` 里的 `:root`。 */
function criticalBlocks(source: string): { light: string; dark: string } {
  const darkStart = source.indexOf('@media (prefers-color-scheme: dark)')
  if (darkStart < 0) throw new Error('没有深色 critical 段')
  return { light: source.slice(0, darkStart), dark: source.slice(darkStart) }
}

describe('品牌色只有一个来源（tokens.css）', () => {
  const tokens = read('tokens.css')

  it('tokens.css 的浅/深色强调色都齐备，且深色确实换了一套', () => {
    const light = cssSection(tokens, false)
    const dark = cssSection(tokens, true)
    for (const [name, section] of [['--accent', light], ['--accent-strong', light],
      ['--accent-soft', light]] as const) {
      expect(() => cssVar(section, name)).not.toThrow()
    }
    expect(cssVar(light, '--accent')).not.toBe(cssVar(dark, '--accent'))
  })

  it('newtab.html 的首帧 critical 色与 tokens.css 一致（漂了就是第一帧闪错色）', () => {
    const { light, dark } = criticalBlocks(read('newtab.html'))
    expect(cssVar(light, '--critical-accent')).toBe(cssVar(cssSection(tokens, false), '--accent'))
    expect(cssVar(light, '--critical-brand')).toBe(cssVar(cssSection(tokens, false), '--accent-strong'))
    expect(cssVar(dark, '--critical-accent')).toBe(cssVar(cssSection(tokens, true), '--accent'))
    expect(cssVar(dark, '--critical-brand')).toBe(cssVar(cssSection(tokens, true), '--accent-strong'))
  })

  it('渲染层不再出现 Fluent 的默认品牌蓝（曾经混进来的第二个强调色）', () => {
    // 注释里提到这个蓝（解释历史）不算违规：先剥掉块注释再扫。
    const strip = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').toLowerCase()
    for (const file of ['tokens.css', 'newtab.html', 'settings.html', 'index.html']) {
      expect(strip(read(file))).not.toContain('#0f6cbd')
      expect(strip(read(file))).not.toContain('#479ef5')
    }
  })

  it('内部页首帧底色跟 Fluent 的 colorNeutralBackground2 对齐', () => {
    const settings = read('settings.html').toLowerCase()
    expect(settings).toContain(webLightTheme.colorNeutralBackground2.toLowerCase())
    expect(settings).toContain(webDarkTheme.colorNeutralBackground2.toLowerCase())
  })
})
