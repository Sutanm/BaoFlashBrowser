/**
 * 搜索引擎模型（地址栏与新标签页 realbox 的「非 URL 输入」回退）。
 *
 * 为什么单独成模块：同一份目录要被三处使用——主进程解析导航（`main/address.ts`）、
 * 设置页的选项文案、以及写库前的取值校验（`shared/settings.ts`）。三处各写一份，
 * 迟早出现「设置里能选、主进程不认」的错位。这里不 import electron，单测可直接覆盖。
 *
 * 范围只到**内置引擎**：自定义搜索 URL 需要额外的模板占位约定与输入校验，与本期
 * 「先让搜索真的能用」解耦。
 */
export const SEARCH_ENGINES = ['baidu', 'bing', 'google'] as const
export type SearchEngine = (typeof SEARCH_ENGINES)[number]

/**
 * 默认搜索引擎：百度。
 *
 * 理由：本项目面向中文经典网页/Flash 站点用户，默认值必须**开箱就能出结果**；
 * Google 在目标网络环境下大概率连不上，Bing 可用但中文长尾偏弱。用户可在设置里改。
 */
export const DEFAULT_SEARCH_ENGINE: SearchEngine = 'baidu'

export function isSearchEngine(value: unknown): value is SearchEngine {
  return typeof value === 'string' && (SEARCH_ENGINES as readonly string[]).includes(value)
}

export const searchEngineLabels: Record<SearchEngine, string> = {
  baidu: '百度',
  bing: '必应',
  google: 'Google'
}

/** 搜索 URL 模板：`%s` 会被 `encodeURIComponent` 之后的关键词替换。 */
const SEARCH_TEMPLATES: Record<SearchEngine, string> = {
  baidu: 'https://www.baidu.com/s?wd=%s',
  bing: 'https://www.bing.com/search?q=%s',
  google: 'https://www.google.com/search?q=%s'
}

/**
 * 搜索地址。空白输入返回空串（调用方本来就不该发，这里只防手误）。
 *
 * 用 `encodeURIComponent` 而不是 `URLSearchParams`：后者的空格会变成 `+`，
 * 中文站点的 `wd`/`q` 都接受 `%20`，而 `+` 在少数引擎里会被当字面量。
 */
export function searchUrlFor(engine: SearchEngine, query: string): string {
  const text = query.trim()
  if (!text) return ''
  const template = SEARCH_TEMPLATES[engine] ?? SEARCH_TEMPLATES[DEFAULT_SEARCH_ENGINE]
  return template.replace('%s', encodeURIComponent(text))
}

/**
 * 输入看起来像「地址」吗——决定走导航还是搜索。
 *
 * 判据与 Chrome 的 omnibox 同一取舍：**只有主机名才像地址**。
 * - 含空白 → 搜索（`hello world` 不可能是不带编码的 URL）；
 * - 有域名点（`baidu.com`、`百度.com`）、IPv4/IPv6 字面量、`localhost[:port]` → 地址；
 * - 单段输入（`4399`、`百度`）→ 搜索。
 *
 * 这条判据是「输入中文却跳去 `https://xn--wxtr44c/`」的直接修复点：没有点号的单段
 * 中文会被 WHATWG URL 当成 IDN 主机名（`https://百度` → `xn--wxtr44c`）并真的去解析，
 * 于是得到 ERR_NAME_NOT_RESOLVED——按主机名判据它本来就不该走导航。
 */
export function looksLikeAddress(input: string): boolean {
  const text = input.trim()
  if (!text || /\s/.test(text)) return false
  // http(s) scheme 明确写了，就是地址。
  if (/^https?:\/\//i.test(text)) return true
  // 只看主机部分：路径/查询/hash 不参与判定（结尾的点按 FQDN 写法忽略）。
  const host = (text.split(/[/?#]/, 1)[0] ?? '').replace(/\.+$/, '')
  if (!host) return false
  // IPv6 字面量（`[::1]:8080`）：方括号里带冒号，必须先判掉。
  if (host.startsWith('[')) return true
  if (/^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/.test(host)) return true
  if (/^localhost(?::\d+)?$/i.test(host)) return true
  // 至少两段标签且每段非空：`example.com`、`a.b.c:8080`；`baidu.com/x` 已在上面截掉路径。
  return /^[^.:]+(?:\.[^.:]+)+(?::\d+)?$/.test(host)
}
