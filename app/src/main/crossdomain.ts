import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { registrableDomain } from '../shared/site'

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
 * 授权要求（2026-11-24 审计 P1）：策略必须是**目标站点自己**返回的。之前 `redirect: 'follow'`
 * 会跟到任意第三方并把结果缓存到目标名下（本地 SWF 已复现：B 的策略 302 到 C 被接受）。
 *
 * 但也不能一刀切——真实站点普查里 `www.armorgames.com` / `www.flasharch.com` 的
 * `/crossdomain.xml` 都是 301 到**裸域**（同站不同 host），这类必须放行。
 *
 * 实现取舍：不用 Electron 的网络 API 走跳转，原因都实测过——
 * - `net.fetch(manual)` 对 3xx 直接抛 "Redirect was cancelled"，拿不到 Location；
 * - `net.fetch(follow)` 的 `response.url` 是空串，看不出最终地址；
 * - `session.fetch` 不经 `webRequest.onBeforeRedirect`（监听器一次都没触发）；
 * - `net.request` 在本内核上只发 close、不给 response。
 * 因此用 Node 的 http(s) 自己走跳转链，每一跳都校验「同可注册域 + 不降级到 http」，
 * 跨站就整份丢弃。代价是不走 Chromium 代理设置（无代理环境无差异）。
 */
/** 一跳是否仍在同一站点：可注册域相同，且不允许 https → http 降级。 */
function sameSiteHop(from: string, to: string): boolean {
  let source: URL
  let target: URL
  try {
    source = new URL(from)
    target = new URL(to)
  } catch {
    return false
  }
  if (source.protocol === 'https:' && target.protocol !== 'https:') return false
  const sourceSite = registrableDomain(source.hostname) || source.hostname
  const targetSite = registrableDomain(target.hostname) || target.hostname
  return sourceSite === targetSite
}
const MAX_REDIRECT_HOPS = 5

interface HopResult {
  status: number
  location?: string
  body?: string
}

function requestOnce(url: string, signal: AbortSignal): Promise<HopResult> {
  return new Promise((resolve) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      resolve({ status: 0 })
      return
    }
    const get = parsed.protocol === 'https:' ? httpsGet : httpGet
    const request = get(url, { signal, headers: { accept: 'text/x-cross-domain-policy, */*' } }, (response) => {
      const status = response.statusCode ?? 0
      const location = response.headers.location
      if (status >= 300 && status < 400 && location) {
        response.resume()
        resolve({ status, location })
        return
      }
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        if (body.length < MAX_POLICY_BYTES) body += chunk
      })
      response.on('end', () => resolve({ status, body }))
      response.on('error', () => resolve({ status: 0 }))
    })
    request.on('error', () => resolve({ status: 0 }))
    request.setTimeout(FETCH_TIMEOUT_MS, () => {
      request.destroy()
      resolve({ status: 0 })
    })
  })
}

async function fetchPolicy(origin: string): Promise<CrossDomainPolicy | null> {
  const controller = new AbortController()
  let current = `${origin}/crossdomain.xml`
  try {
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
      const result = await requestOnce(current, controller.signal)
      if (result.status >= 300 && result.status < 400 && result.location) {
        const next = new URL(result.location, current).href
        // 跨站跳转直接放弃：谁的策略授权谁，不能被 302 带到别处。
        if (!sameSiteHop(current, next)) return null
        current = next
        continue
      }
      if (result.status !== 200 || !result.body) return null
      return /<cross-domain-policy/i.test(result.body) ? parsePolicy(result.body) : null
    }
    return null
  } finally {
    controller.abort()
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
