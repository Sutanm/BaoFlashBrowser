import { net } from 'electron'

/**
 * Flash 的跨域策略（`crossdomain.xml`）—— 架构 §3 引擎「站点兼容规则」。
 *
 * 语义来源：Flash 只对 **SWF 发起的跨域加载**（`Loader`/`URLLoader`/`Socket`）检查目标站的
 * `crossdomain.xml`；`allow-access-from` 列出**允许读取该目标的来源**，`secure` 只禁止
 * 「http 来源 → https 目标」这一种组合。
 *
 * 2026-11-22 普查（docs/evidence/2026-11-22-crossdomain-survey.json）：34 个站点里 15 个
 * 提供策略，两个实测站点（4399 的 `szhong.4399.com` → `*.4399.com`、淘米的
 * `newmisc.taomee.com` → wildcard）都在放行范围内。
 *
 * 2026-11-23 审计修正：
 * - 策略按**完整来源**（scheme + host + port）缓存与抓取，不再跨协议回退；
 * - 「同源」比较完整来源，不是 `host`；
 * - 读取有字节上限，不再整份 `text()` 后截断。
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
const MAX_CACHE_ENTRIES = 200
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

/** 有字节上限的读取：超出即中止，避免为一份策略文件读进无界内容。 */
/**
 * 取目标 origin 的 `crossdomain.xml`。
 *
 * 关键约束（2026-11-24 审计 P1，本地 SWF 已复现）：策略必须是**目标 origin 自己**返回的。
 * 之前的 `redirect: 'follow'` 会跟到别的 origin，并把结果缓存到目标名下
 * （实测：B 的 crossdomain.xml 302 到 C，broker 接受 C 的策略后 SWF 照样加载）。
 *
 * 实测过的 API 限制：
 * - `net.fetch(..., { redirect: 'follow' })` 的 `response.url` 是**空串**，看不出最终 URL；
 * - `net.fetch(..., { redirect: 'manual' })` 对 3xx 直接抛 "Redirect was cancelled"；
 * - `net.request` 在本内核上只发 `close`、不给 `response`，同样不可用。
 *
 * 所以用「manual + 抛错即视为发生了重定向」：只要重定向就不采信该策略；
 * 只额外放行「同主机 http → https」这一种升级（显式再取一次 https 版本，而不是跟随）。
 */
async function readPolicyText(url: string, signal: AbortSignal): Promise<string | 'redirect' | null> {
  try {
    const response = await net.fetch(url, { signal, redirect: 'manual' })
    if (response.status !== 200) return null
    return await readBounded(response, MAX_POLICY_BYTES)
  } catch (error) {
    return /Redirect was cancelled|redirect/i.test(String(error)) ? 'redirect' : null
  }
}

async function fetchPolicy(origin: string): Promise<CrossDomainPolicy | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    let text = await readPolicyText(`${origin}/crossdomain.xml`, controller.signal)
    if (text === 'redirect') {
      let upgraded: string | undefined
      try {
        const parsed = new URL(origin)
        if (parsed.protocol === 'http:') {
          parsed.protocol = 'https:'
          upgraded = `${parsed.origin}/crossdomain.xml`
        }
      } catch {
        upgraded = undefined
      }
      text = upgraded ? await readPolicyText(upgraded, controller.signal) : null
      if (text === 'redirect') text = null
    }
    if (typeof text === 'string' && /<cross-domain-policy/i.test(text)) return parsePolicy(text)
    return null
  } finally {
    clearTimeout(timer)
  }
}
async function readBounded(response: Response, limit: number): Promise<string> {
  const stream = response.body
  if (!stream) return ''
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        return ''
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

async function loadPolicy(origin: string): Promise<CrossDomainPolicy | null> {
  const cached = cache.get(origin)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.policy

  const policy = await fetchPolicy(origin)

  if (cache.size >= MAX_CACHE_ENTRIES) cache.clear()
  cache.set(origin, { at: Date.now(), policy })
  return policy
}

/** `*.example.com` 匹配子域，`example.com` 只匹配自身（与 Flash 一致）。 */
function domainMatches(pattern: string, host: string): boolean {
  if (pattern === '*') return true
  if (pattern.startsWith('*.')) return host === pattern.slice(2) || host.endsWith(pattern.slice(1))
  return host === pattern
}

/**
 * 判定「来源 `initiatorUrl` 能否读取 `targetUrl` 的跨域响应」。
 *
 * 同源（scheme + host + port 完全一致）直接放行；跨源要求目标站策略文件里有匹配该来源的
 * 规则。来源取自浏览器认证的文档 URL；非 http(s)（含 opaque origin）一律拒绝。
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
  if (target.origin === initiator.origin) return true

  const policy = await loadPolicy(target.origin)
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
