import { registrableDomain } from '../shared/site'

/**
 * `crossdomain.xml` 的**纯规则**部分（不 import electron，可在单测里覆盖）。
 *
 * 拆出来的原因：这些判定是安全边界，必须有确定性用例；而抓取策略要用 `net.request`，
 * 在 vitest 里跑不起来。抓取与缓存留在 `crossdomain.ts`，这里只做「解析 + 匹配 + 跳转判定」。
 */
export interface AllowRule {
  /** `*`、`*.example.com` 或精确域（小写） */
  readonly domain: string
  /** 该条规则是否只允许 https 来源 */
  readonly secure: boolean
}

export interface CrossDomainPolicy {
  readonly rules: readonly AllowRule[]
}

export function parsePolicy(xml: string): CrossDomainPolicy {
  const rules: AllowRule[] = []
  for (const match of xml.matchAll(/<allow-access-from\b[^>]*>/gi)) {
    const tag = match[0]
    const domain = /domain\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase()
    if (!domain) continue
    rules.push({ domain, secure: !/secure\s*=\s*["']false["']/i.test(tag) })
  }
  return { rules }
}

/** `*.example.com` 匹配子域，`example.com` 只匹配自身（与 Flash 一致）。 */
export function domainMatches(pattern: string, host: string): boolean {
  if (pattern === '*') return true
  if (pattern.startsWith('*.')) return host === pattern.slice(2) || host.endsWith(pattern.slice(1))
  return host === pattern
}

/**
 * 这一跳重定向是否还能采信（2026-11-26 审计）。
 *
 * 原来的判据是「**同可注册域**」，它允许 `evil.example.com` 的策略被当作 `www.example.com` 的
 * 策略使用——子域常常是用户内容（论坛、上传、CDN 回源），等于把「目标站自己声明」换成「任何人
 * 在子域上声明」。现在收紧为：
 *
 * 1. **同源**（scheme + host + port 完全一致）→ 放行；
 * 2. 唯一例外：**同协议、同可注册域、且只在 `www.` 前缀上增减**（真实站点普查里
 *    `www.armorgames.com` / `www.flasharch.com` 的 `/crossdomain.xml` 都是 301 到裸域）；
 * 3. https → http 降级一律拒绝。
 *
 * 其它情况（跨站、任意子域互跳、协议变化）整份策略不采信，返回 `false`。
 */
export function sameOriginHop(from: string, to: string): boolean {
  let source: URL
  let target: URL
  try {
    source = new URL(from)
    target = new URL(to)
  } catch {
    return false
  }
  if (source.protocol === 'https:' && target.protocol !== 'https:') return false
  if (source.origin === target.origin) return true
  if (source.protocol !== target.protocol) return false
  // `www.` 例外只在同端口成立：`https://example.com:443` 与 `https://example.com:8443` 是
  // 两个不同的部署，不能让前者替后者声明策略。
  if (source.port !== target.port) return false
  const sourceSite = registrableDomain(source.hostname) || source.hostname
  const targetSite = registrableDomain(target.hostname) || target.hostname
  if (sourceSite !== targetSite) return false
  return stripWww(source.hostname) === stripWww(target.hostname)
}

function stripWww(host: string): string {
  return host.toLowerCase().replace(/^www\./, '')
}
