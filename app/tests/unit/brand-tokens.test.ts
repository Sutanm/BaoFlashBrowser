import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { webDarkTheme, webLightTheme } from '@fluentui/tokens'
import { shellCssVariables } from '../../src/shared/shell-tokens'
import { injectInternalBootstrap } from '../../src/shared/internal-bootstrap'

/**
 * 品牌色 / 首帧配色的**单一来源**。
 *
 * 历史（2026-11-26）：内部页曾经在自己的 HTML 里抄一份首帧配色（`--critical-*`），
 * 结果 `newtab.html` 的第二个色漂成了 Fluent 的蓝——新标签页第一帧 logo 是蓝的，挂载后才变紫。
 * 现在首帧配色由主进程在返回 HTML 时注入（`shared/internal-bootstrap.ts`），
 * 映射只有 `shared/shell-tokens.ts` 一份。这条用例钉住"没有第二份副本"。
 */

const RENDERER = join(dirname(fileURLToPath(import.meta.url)), '../../src/renderer')

function read(name: string): string {
  return readFileSync(join(RENDERER, name), 'utf8')
}

/** 去掉注释再判断：注释里提到历史色值/历史变量名不算违规。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
}

describe('品牌色与首帧配色只有一个来源', () => {
  it('强调色在 tokens.css 里浅/深各一套，且不是 Fluent 的默认品牌蓝', () => {
    const tokens = read('tokens.css')
    const dark = tokens.indexOf(':root[data-theme="dark"]')
    expect(dark).toBeGreaterThan(0)
    for (const section of [tokens.slice(0, dark), tokens.slice(dark)]) {
      const accent = /--accent:\s*(#[0-9a-fA-F]{3,8})/.exec(section)?.[1]?.toLowerCase()
      expect(accent, '每个主题都要有 --accent').toBeTruthy()
      expect(accent).not.toBe(webLightTheme.colorBrandBackground.toLowerCase())
    }
  })

  it('内部页 HTML 不再自带颜色副本（首帧色只来自注入）', () => {
    for (const file of ['newtab.html', 'settings.html']) {
      const html = stripComments(read(file))
      expect(html, `${file} 不该再出现 --critical-* 副本`).not.toContain('--critical-')
      expect(html, `${file} 不该再出现颜色字面量`).not.toMatch(/#[0-9a-fA-F]{6}\b/)
    }
  })

  it('渲染层不再出现 Fluent 的默认品牌蓝（曾经混进来的第二个强调色）', () => {
    for (const file of ['tokens.css', 'newtab.html', 'settings.html', 'index.html']) {
      expect(stripComments(read(file)).toLowerCase()).not.toContain('#0f6cbd')
      expect(stripComments(read(file)).toLowerCase()).not.toContain('#479ef5')
    }
  })

  it('注入的变量与 shell-tokens 的映射一致（同一份真源）', () => {
    for (const mode of ['light', 'dark'] as const) {
      const css = injectInternalBootstrap('<html><head></head><body></body></html>', { theme: mode, snapshot: null })
      const variables = shellCssVariables(mode)
      for (const [name, value] of Object.entries(variables)) {
        expect(css, `${mode} 缺 ${name}`).toContain(`${name}: ${value};`)
      }
      expect(css).toContain(`color-scheme: ${mode}`)
    }
  })

  it('Fluent 的中性面与选中面取的是 token，而不是写死的灰', () => {
    const light = shellCssVariables('light')
    expect(light['--surface-page']).toBe(webLightTheme.colorNeutralBackground2)
    expect(light['--surface-toolbar']).toBe(webLightTheme.colorNeutralBackground1)
    expect(light['--surface-selected']).toBe(webLightTheme.colorNeutralBackground1Selected)
    const dark = shellCssVariables('dark')
    expect(dark['--surface-page']).toBe(webDarkTheme.colorNeutralBackground2)
    expect(dark['--surface-selected']).toBe(webDarkTheme.colorNeutralBackground1Selected)
  })
})
