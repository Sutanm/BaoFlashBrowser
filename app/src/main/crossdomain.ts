import { net } from 'electron'

/**
 * Flash 的跨域策略（`crossdomain.xml`）—— 架构 §3 引擎「站点兼容规则」。
 *
 * 语义来源：Flash 只对 **SWF 发起的跨域加载**（`Loader`/`URLLoader`/`Socket`）检查目标站的
 * `crossdomain.xml`；`allow-access-from` 列出**允许读取该目标的来源**，`secure` 默认 true
 * 表示只允许 https 来源（http 站点要写 `secure="false"` 才能被 http 页面读）。
 *
 * 2026-11-22 普查（docs/evidence/2026-11-22-crossdomain-survey.json）：34 个站点里 15 个
 * 提供策略，两个实测站点（4399 的 `szhong.4399.com` → `*.4399.com`、淘米的
 * `newmisc.taomee.com` → wildcard）都在放行范围内。
 */
interface AllowRule {
  /** `*`、`*.example.com` 或精确域（小写） */
  readonly domain: string
  /** 该条规则是否只允许 https 来源 */
  readonly secure: boolean
}

export interface CrossDomainPolicy {
  readonly rules: readonly AllowRule[]
}

const CACHE_TTL_MS = 10 * 60_000
const MAX_POLICY_BYTES = 64 * 1024
const FETCH_TIMEOUT_MS = 6_000

const cache = new Map<string, { at: number; policy: CrossDomainPolicy | null }>()

function parsePolicy(xml: string): CrossDomainPolicy {
  const rules: AllowRule[] = []
  for (const match of xml.matchAll(/<allow-access-from\b[^>]*>/gi)) {
    const tag = match[0]
    const domain = /domain\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase()
    if (!domain) continue
    rules.push({ domain, secure: !/secure\s*=\s*["']false["']/i.test(tag) })
  }
  return { rules }
}

async function loadPolicy(hostWithPort: string, preferred: string): Promise<CrossDomainPolicy | null> {
  const cached = cache.get(hostWithPort)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.policy

  let policy: CrossDomainPolicy | null = null
  // 先按目标自身协议取，失败再换另一个（策略文件通常与目标同协议）。
  const schemes = preferred === 'https:' ? ['https', 'http'] : ['http', 'https']
  for (const scheme of schemes) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      // 端口必须保留：策略文件按「目标 host:port」取（与 Flash 一致）。
      const response = await net.fetch(`${scheme}://${hostWithPort}/crossdomain.xml`, {
        signal: controller.signal,
        redirect: 'follow'
      })
      if (response.status !== 200) continue
      const text = (await response.text()).slice(0, MAX_POLICY_BYTES)
      if (!/<cross-domain-policy/i.test(text)) continue
      policy = parsePolicy(text)
      break
    } catch {
      // 换下一个协议；都失败按「无策略」处理
    } finally {
      clearTimeout(timer)
    }
  }

  cache.set(hostWithPort, { at: Date.now(), policy })
  return policy
}

/** `*.example.com` 匹配子域，`example.com` 只匹配自身（与 Flash 一致）。 */
function domainMatches(pattern: string, host: string): boolean {
  if (pattern === '*') return true
  if (pattern.startsWith('*.')) return host === pattern.slice(2) || host.endsWith(pattern.slice(1))
  return host === pattern
}

/**
 * 判定「来源 `initiator` 能否读取 `target` 的跨域响应」。
 *
 * 同源直接放行；跨源要求目标站策略文件里有匹配该来源的规则。
 *
 * `secure`（默认 true）的语义**不是**「只允许 https 来源」：它只禁止
 * **http 来源 → https 目标** 这一种组合，其余三种（http→http、https→http、https→https）
 * 都允许。真实站点（4399 的 https 策略、淘米的 http 策略）都没写 `secure="false"`，
 * 正是依赖这条规则。
 */
export async function allowsCrossOrigin(targetUrl: string, initiatorUrl: string): Promise<boolean> {
  let target: URL
  let initiator: URL
  try {
    target = new URL(targetUrl)
    initiator = new URL(initiatorUrl)
  } catch {
    return false
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false
  if (initiator.protocol !== 'http:' && initiator.protocol !== 'https:') return false
  if (target.host === initiator.host) return true

  const policy = await loadPolicy(target.host, target.protocol)
  if (!policy) return false

  const insecureUpgrade = target.protocol === 'https:' && initiator.protocol === 'http:'
  const host = initiator.hostname.toLowerCase()
  return policy.rules.some((rule) => {
    if (!domainMatches(rule.domain, host)) return false
    return !(rule.secure && insecureUpgrade)
  })
}

/** 测试用：清空策略缓存。 */
export function clearPolicyCache(): void {
  cache.clear()
}
