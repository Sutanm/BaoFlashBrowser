import { describe, expect, it } from 'vitest'
import { BOOTSTRAP_META, BOOTSTRAP_STYLE_ID, injectInternalBootstrap } from '../../src/shared/internal-bootstrap'

/**
 * 内部页首帧注入（2026-11-26）。
 *
 * 背景：内部页的配色与首屏数据以前靠渲染层脚本去问（token 注入 + 一次 IPC），而模块脚本是
 * defer 的——第一帧早就画完了。于是只能靠 HTML 里手抄骨架：副本会漂、骨架与真页面是两套 DOM，
 * 交接时必然跳一下。现在主进程在返回 HTML 前把主题变量与快照内联进去，第一帧就是真页面。
 *
 * 这条用例钉住接口的四件事：主题标记、变量内联、快照转义可解析、注入位置在 <head> 最前。
 */

const HTML = '<!doctype html>\n<html lang="zh-CN" data-theme="light">\n<head>\n<meta charset="utf-8">\n</head>\n<body><div id="app"></div></body>\n</html>'

/** 把写入属性时的转义还原（顺序反过来：`&amp;` 必须最后解）。 */
function decode(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function bootstrapContent(html: string): Record<string, unknown> {
  const match = new RegExp(`<meta name="${BOOTSTRAP_META}" content="([^"]*)">`).exec(html)
  expect(match, '没有注入 bootstrap meta').toBeTruthy()
  return JSON.parse(decode(match![1])) as Record<string, unknown>
}

describe('injectInternalBootstrap', () => {
  it('主题标记写在 <html> 上，并且替换掉 HTML 里原有的 data-theme', () => {
    const html = injectInternalBootstrap(HTML, { theme: 'dark', snapshot: { a: 1 } })
    expect(html).toContain('<html lang="zh-CN" data-theme="dark">')
    expect(html.match(/data-theme="dark"/g)).toHaveLength(1)
  })

  it('内联样式放在 <head> 的最前面（早于 tokens.css 的 link，避免第一帧按缺省值算）', () => {
    const html = injectInternalBootstrap(HTML, { theme: 'light', snapshot: null })
    const headEnd = html.indexOf('<meta charset="utf-8">')
    expect(html.indexOf(`<style id="${BOOTSTRAP_STYLE_ID}">`)).toBeGreaterThan(html.indexOf('<head>'))
    expect(html.indexOf(`<style id="${BOOTSTRAP_STYLE_ID}">`)).toBeLessThan(headEnd)
    expect(html).toContain('--surface-page')
    expect(html).toContain('color-scheme: light')
  })

  it('快照里的引号/尖括号/& 转义后仍能原样解析回来', () => {
    const snapshot = { title: 'a "quoted" <b> & tag', list: [1, 2], nested: { ok: true } }
    const html = injectInternalBootstrap(HTML, { theme: 'dark', snapshot })
    // 属性值里不能出现裸引号，否则 meta 会被截断。
    expect(html).not.toContain('content="{"')
    expect(bootstrapContent(html)).toEqual({ theme: 'dark', snapshot })
  })

  it('缺少 <head> 的文档直接报错（宁可失败也不要注入到错误位置）', () => {
    expect(() => injectInternalBootstrap('<html><body>x</body></html>', { theme: 'light', snapshot: null }))
      .toThrow(/head/)
  })
})
