/**
 * 站点边界（架构 §3 权限与会话「对弹窗、新窗口、导航及外部协议设显式策略」）。
 *
 * 「同站」不等于「域名末两段」：`a.com.cn` 与 `b.com.cn` 的末两段是 `com.cn`，
 * 那是公共后缀，两者其实是不同站点。2026-11-23 审计把这条记为 P1-3。
 *
 * 这里用**精简公共后缀表**算可注册域（registrable domain）：先按后缀表找到公共后缀，
 * 再取它前面一个标签。表只覆盖常见多段后缀，未收录的后缀按「末两段」处理——这是
 * 有意的保守取舍：宁可把两个不同站点判成同站的风险留在罕见后缀上，也不引入完整 PSL
 * 的数据体量（完整 PSL 需要随包分发 ~80KB 并定期更新）。
 */
const MULTI_LABEL_SUFFIXES = new Set([
  // 中国
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn', 'bj.cn', 'sh.cn', 'gd.cn', 'zj.cn',
  // 港澳台
  'com.hk', 'org.hk', 'net.hk', 'edu.hk', 'com.tw', 'org.tw', 'net.tw', 'edu.tw', 'com.mo',
  // 英国 / 日本 / 韩国 / 澳新 / 巴西 / 印度
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp',
  'co.kr', 'or.kr', 'com.au', 'net.au', 'org.au', 'edu.au', 'com.br', 'co.in', 'net.in',
  // 常见托管
  'github.io', 'vercel.app', 'netlify.app', 'herokuapp.com'
])

/** 返回可注册域（`game.example.com.cn` → `example.com.cn`）；非法输入返回空串。 */
export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (!host || host.includes(':')) return ''
  // IP 字面量：整段就是自己
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return host
  const labels = host.split('.')
  if (labels.length <= 2) return host
  const lastTwo = labels.slice(-2).join('.')
  const suffixLabels = MULTI_LABEL_SUFFIXES.has(lastTwo) ? 2 : 1
  const take = suffixLabels + 1
  if (labels.length <= take) return host
  return labels.slice(-take).join('.')
}

export interface SiteBoundary {
  /** 可注册域（同站判定的依据） */
  readonly site: string
  /** 完整 origin（scheme + host + port） */
  readonly origin: string
}

export function siteBoundary(url: string | undefined): SiteBoundary | undefined {
  if (!url) return undefined
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  const site = registrableDomain(parsed.hostname)
  if (!site) return undefined
  return { site, origin: parsed.origin }
}

/**
 * 同站判定：协议一致且可注册域相同。
 *
 * 要求「协议一致」是为了不让 https 页面开 http 弹窗降级；Flash 时代 lobby→game 的
 * 跨子域交接（`www.x.com` → `game.x.com`）仍然放行。
 */
export function isSameSite(opener: SiteBoundary | undefined, target: SiteBoundary | undefined): boolean {
  if (!opener || !target) return false
  const openerScheme = opener.origin.slice(0, opener.origin.indexOf(':'))
  const targetScheme = target.origin.slice(0, target.origin.indexOf(':'))
  if (openerScheme !== targetScheme) return false
  return opener.site === target.site
}
