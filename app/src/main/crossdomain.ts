import { net } from 'electron'
import { domainMatches, parsePolicy, sameOriginHop } from './crossdomain-rules'
import type { CrossDomainPolicy } from './crossdomain-rules'

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
const CACHE_TTL_MS = 10 * 60_000
const MAX_POLICY_BYTES = 64 * 1024
const MAX_CACHE_ENTRIES = 200
const FETCH_TIMEOUT_MS = 6_000

const cache = new Map<string, { at: number; policy: CrossDomainPolicy | null }>()


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
/**
 * 取目标 origin 的 `crossdomain.xml`。
 *
 * 两条约束同时满足才算合格：
 * 1. **必须是目标站点自己**返回的策略（2026-11-24 审计 P1）：之前 `net.fetch(follow)` 会跟到
 *    任意第三方并把结果缓存到目标名下（本地 SWF 已复现：B 的策略 302 到 C 被接受）；
 * 2. **必须走 Chromium 网络栈**，否则系统代理 / PAC 下取不到策略——用 Node http 会静默直连。
 *
 * 所以用 `net.request` + `redirect: 'manual'`：它走 Chromium 网络栈（代理、TLS、证书都一致），
 * 又会在每一跳触发 `redirect` 事件给出目标地址。判定规则：只有**同可注册域**、
 * 且不退化成 https → http 才继续跟；跨站立刻中止，整份策略不采信。
 *
 * 注意：`net.request` 的 `close` 早于 `redirect`/`response` 触发（官方与自编译内核一致），
 * 不能拿 `close` 当结束信号，否则会漏掉整条响应。
 */

const MAX_REDIRECT_HOPS = 5

function fetchPolicy(origin: string): Promise<CrossDomainPolicy | null> {
  return new Promise((resolve) => {
    let settled = false
    let current = `${origin}/crossdomain.xml`
    let hops = 0
    let body = ''
    const finish = (value: CrossDomainPolicy | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }

    let request: Electron.ClientRequest
    try {
      request = net.request({ url: current, redirect: 'manual' })
    } catch {
      finish(null)
      return
    }

    const timer = setTimeout(() => {
      try {
        request.abort()
      } catch {
        // 已结束
      }
      finish(null)
    }, FETCH_TIMEOUT_MS)

    request.on('redirect', (_status, _method, redirectUrl) => {
      hops += 1
      if (hops > MAX_REDIRECT_HOPS || !sameOriginHop(current, redirectUrl)) {
        try {
          request.abort()
        } catch {
          // 已结束
        }
        finish(null)
        return
      }
      current = redirectUrl
      request.followRedirect()
    })
    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        // Electron 的 IncomingMessage 类型没有 resume()；丢掉剩余数据即可。
        response.on('data', () => undefined)
        clearTimeout(timer)
        finish(null)
        return
      }
      // Electron 的 IncomingMessage 类型没声明 setEncoding；数据是 Buffer，自己按 UTF-8 拼接。
      let overflowed = false
      response.on('data', (chunk) => {
        if (overflowed) return
        body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
        if (body.length > MAX_POLICY_BYTES) {
          /**
           * 超限整份丢弃（fail-closed）。原实现只是"不再追加"，然后拿**截短的 XML** 去解析——
           * 截断处如果刚好落在一条规则中间，解析结果就由攻击者控制（2026-11-26 审计）。
           * 策略文件本该只有几百字节，读不到完整内容就不该采信。
           */
          overflowed = true
          body = ''
          try {
            request.abort()
          } catch {
            // 已结束
          }
          clearTimeout(timer)
          finish(null)
        }
      })
      response.on('end', () => {
        clearTimeout(timer)
        finish(/<cross-domain-policy/i.test(body) ? parsePolicy(body) : null)
      })
      response.on('error', () => {
        clearTimeout(timer)
        finish(null)
      })
    })
    request.on('error', () => {
      clearTimeout(timer)
      finish(null)
    })
    request.on('abort', () => {
      clearTimeout(timer)
      finish(null)
    })
    request.end()
  })
}
async function loadPolicy(origin: string): Promise<CrossDomainPolicy | null> {
  const cached = cache.get(origin)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.policy

  const policy = await fetchPolicy(origin)

  if (cache.size >= MAX_CACHE_ENTRIES) cache.clear()
  cache.set(origin, { at: Date.now(), policy })
  return policy
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
