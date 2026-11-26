import { shellCssText } from './shell-tokens'
import type { ShellTheme } from './shell-theme'

/**
 * 内部页的**首帧引导数据**（渲染层文档与主进程之间的窄合同，只走 HTML，不走 IPC）。
 *
 * 为什么需要（2026-11-26）：
 * 内部页的配色与首屏数据过去靠渲染层脚本去问（`applyShellTheme` 要等 token 注入、
 * `read()` 要等一次 IPC）。而模块脚本是 defer 的——**第一帧早就画完了**。于是只能靠
 * `newtab.html` 里手抄一份"关键首帧"的骨架和配色：那既会漂移（`--critical-brand` 漂成过
 * Fluent 蓝），又因为骨架与真页面是两套 DOM 而在交接时跳变。
 *
 * 现在的做法：`bao://` 的响应在返回 HTML 之前，把**已解析好的主题变量与首屏快照**内联进去，
 * 于是第一帧就是真页面、且配色正确，不再需要骨架。
 *
 * 两条硬约束（来自 `internal-pages.ts` 的 CSP 与既有安全边界）：
 * 1. 数据只能进 `<meta>`：CSP 是 `script-src 'self'`，内联 `<script>` 会被拦；
 * 2. 样式可以内联：CSP 里 `style-src` 本来就带 `'unsafe-inline'`（骨架时期的既有允许）。
 *
 * 已知边界：开发态（`electron-vite dev`）下 vite 用 JS 注入**组件样式**，`<head>` 里只有
 * 我们内联的这一份，所以 dev 的第一帧与生产一样有正确底色（下面两条首帧规则），
 * 差的只是"卡片/布局什么时候出现"（要等组件 CSS 到达）。注入本身在 dev 与生产走同一条路径。
 */
export const BOOTSTRAP_META = 'bao-bootstrap'
export const BOOTSTRAP_STYLE_ID = 'bao-first-paint'

export interface InternalBootstrap {
  theme: ShellTheme
  /** 首屏快照（`SettingsSnapshot` / `NtpSnapshot`），JSON 可序列化。 */
  snapshot: unknown
}

/** HTML 属性值里的最小转义：`&` 必须第一个换，否则会把刚生成的实体再转一次。 */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * 把引导数据注入内部页 HTML。
 *
 * 注入点放在 `<head>` 的**最前面**：内联 `<style>` 必须早于 `tokens.css` 的 `<link>` 之前
 * 被解析，才不会出现"变量还没定义就先按缺省值算一遍"的那一帧。
 *
 * 纯函数（不碰 fs/IPC），由 `tests/unit/internal-bootstrap.test.ts` 钉住行为。
 */
export function injectInternalBootstrap(html: string, bootstrap: InternalBootstrap): string {
  const head = /<head[^>]*>/i.exec(html)
  if (!head) throw new Error('内部页 HTML 缺少 <head>')
  const meta = `<meta name="${BOOTSTRAP_META}" content="${escapeAttribute(JSON.stringify(bootstrap))}">`
  // 主题标记钉在 <html> 上：CSS（`:root[data-theme='dark']`）与渲染层都以它为准。
  const withTheme = html.replace(/<html([^>]*)>/i, (_match, attributes: string) => {
    const withoutTheme = attributes.replace(/\sdata-theme="[^"]*"/i, '')
    return `<html${withoutTheme} data-theme="${bootstrap.theme}">`
  })
  /**
   * 变量之外再给两条**首帧规则**：`html, body` 的底色与文字色。
   *
   * 为什么要这两条（2026-11-26）：变量注入只解决"值有没有"，但 `body { background: … }`
   * 这条规则本身来自组件 CSS——生产构建里它在 `<head>` 的 stylesheet 里（渲染阻塞，首帧就有）；
   * **开发态** vite 用 JS 注入 CSS，规则要等脚本执行，于是 dev 第一帧是白底。
   * 把这两条内联进来，dev 与生产首帧就一致了（值仍取自同一份 token，不是第二处颜色）。
   *
   * 约定：内部页的 body 底色必须继续用 `--surface-page`。将来若某个内部页要独立背景
   * （图片/主题色），要连同这里一起改，否则首帧会先用通用底色。
   */
  const firstPaint = [
    'html, body {',
    '  background: var(--surface-page);',
    '  color: var(--text-primary);',
    '}'
  ].join('\n')
  const style = `<style id="${BOOTSTRAP_STYLE_ID}">\n${shellCssText(bootstrap.theme)}\n${firstPaint}\n</style>`
  const index = withTheme.indexOf(head[0]) + head[0].length
  return `${withTheme.slice(0, index)}${meta}${style}${withTheme.slice(index)}`
}

/** 渲染层读取引导数据。缺省/坏 JSON 一律返回 `undefined`（页面自己回落到 IPC）。 */
export function readInternalBootstrap(): InternalBootstrap | undefined {
  if (typeof document === 'undefined') return undefined
  const meta = document.querySelector<HTMLMetaElement>(`meta[name="${BOOTSTRAP_META}"]`)
  if (!meta?.content) return undefined
  try {
    const parsed = JSON.parse(meta.content) as Partial<InternalBootstrap>
    if (parsed.theme !== 'light' && parsed.theme !== 'dark') return undefined
    return { theme: parsed.theme, snapshot: parsed.snapshot }
  } catch {
    return undefined
  }
}
