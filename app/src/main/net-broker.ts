import { ipcMain, net } from 'electron'
import type { ClientRequest, IncomingMessage } from 'electron'
import { brokerRefererMarker, BROKER_REFERER_HEADER } from './broker-token'
import { allowsCrossOrigin } from './crossdomain'
import { isPageView } from './page-views'

/**
 * 引擎网络 broker（架构 §3 引擎「站点兼容规则」、§3 IPC）。
 *
 * 为什么需要它：Ruffle 是页面里的 WASM 播放器，它的 `fetch` 受页面 origin 的 CORS 约束；
 * PPAPI 是独立插件进程，浏览器不对插件请求做 CORS，跨域策略由 Flash 自己按
 * `crossdomain.xml` 判。真实站点（4399 的 CDN、淘米的 `newmisc.taomee.com`）不返回
 * `Access-Control-Allow-Origin`，Ruffle 因此读不到字节。
 *
 * 安全边界（2026-11-23 审计后收紧）：
 * - **只有 Ruffle 的 fetch 调用能到这个通道**：preload 在注入 bundle 时把 wasm-bindgen 的
 *   `__wbg_fetch_*` import 指到私有传输上，传输只存在于那个闭包里；页面世界的
 *   `window.fetch` 保持原生，页面脚本拿不到任何特权入口（见 `preload/page.ts`）。
 * - 来源取自浏览器认证的文档 URL 的 **origin**，非 http(s)（含 opaque origin）一律拒绝。
 * - 跨源读取要求目标站 `crossdomain.xml` 允许该来源；同源按完整 origin 比较。
 * - 逐跳处理重定向：每一跳都重新授权，不跨协议回退。
 * - Cookie 交给 Chromium（`useSessionCookies`），不再手工拼 header。
 * - `Referer` 用带随机令牌的私有标记，由页面会话的 `onBeforeSendHeaders` 还原，
 *   令牌不匹配的标记一律剥离（页面无法伪造 Referer）。
 */
const MAX_BODY_BYTES = 32 * 1024 * 1024
const MAX_REDIRECTS = 5
const FETCH_TIMEOUT_MS = 20_000

export interface NetBrokerResult {
  /** true 表示 broker 已取到字节；false 表示调用方应回退到浏览器 fetch。 */
  readonly proxied: boolean
  readonly status?: number
  readonly contentType?: string
  readonly body?: Uint8Array
  /** 拒绝原因，仅用于日志与诊断，不含敏感内容。 */
  readonly reason?: 'not-page-view' | 'policy-denied' | 'too-large' | 'network-error' | 'too-many-redirects'
  /** 诊断用：被拒时的来源文档 URL（不含敏感内容）。 */
  readonly initiator?: string
  /** 诊断用：网络错误的简短描述。 */
  readonly error?: string
}

interface BrokerBytes {
  status: number
  contentType: string
  location?: string
  body: Uint8Array
}

function requestOnce(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  target: Electron.Session
): Promise<BrokerBytes> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error: Error | null, value?: BrokerBytes): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value as BrokerBytes)
    }

    const request: ClientRequest = net.request({
      method: 'GET',
      url,
      redirect: 'manual',
      session: target,
      // Cookie 由 Chromium 按会话与站点上下文附加，不再手工拼 header。
      useSessionCookies: true
    })
    const timer = setTimeout(() => {
      request.abort()
      finish(new Error('timeout'))
    }, timeoutMs)

    for (const [name, value] of Object.entries(headers)) request.setHeader(name, value)
    request.on('error', (error) => finish(error as Error))
    request.on('response', (response: IncomingMessage) => {
      const location = response.headers.location
      const chunks: Buffer[] = []
      let size = 0
      const contentType = String(response.headers['content-type'] ?? 'application/octet-stream')
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          request.abort()
          finish(new Error('too-large'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        finish(null, {
          status: response.statusCode,
          contentType: Array.isArray(contentType) ? String(contentType[0]) : contentType,
          location: Array.isArray(location) ? location[0] : location,
          body: new Uint8Array(Buffer.concat(chunks))
        })
      })
      response.on('error', (error) => finish(error as Error))
    })
    request.end()
  })
}

export function registerNetBroker(): void {
  ipcMain.handle('bao:net-request', async (event, url: unknown): Promise<NetBrokerResult> => {
    if (typeof url !== 'string' || !isPageView(event.sender.id)) {
      return { proxied: false, reason: 'not-page-view' }
    }
    // 浏览器认证过的文档 URL：页面 JS 无法伪造来源。
    const initiator = event.senderFrame?.url ?? ''
    if (!(await allowsCrossOrigin(url, initiator))) {
      return { proxied: false, reason: 'policy-denied', initiator }
    }

    const headers: Record<string, string> = {
      'User-Agent': event.sender.getUserAgent() || 'Mozilla/5.0',
      Accept: '*/*'
    }
    // Referer：4399 的 CDN 缺它会返回 23KB 的「访问错误」内容（正版 2.7MB）。
    if (initiator) headers[BROKER_REFERER_HEADER] = brokerRefererMarker(initiator)

    let current = url
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const bytes = await requestOnce(current, headers, FETCH_TIMEOUT_MS, event.sender.session)
        if (bytes.status >= 300 && bytes.status < 400 && bytes.location) {
          const next = new URL(bytes.location, current).href
          // 逐跳授权：重定向到未授权目标一律拒绝，不跟随。
          if (!(await allowsCrossOrigin(next, initiator))) {
            return { proxied: false, reason: 'policy-denied', initiator }
          }
          current = next
          continue
        }
        if (bytes.body.byteLength > MAX_BODY_BYTES) return { proxied: false, reason: 'too-large' }
        return {
          proxied: true,
          status: bytes.status,
          contentType: bytes.contentType,
          body: bytes.body
        }
      }
      return { proxied: false, reason: 'too-many-redirects', initiator }
    } catch (error) {
      const tooLarge = String(error).includes('too-large')
      return {
        proxied: false,
        reason: tooLarge ? 'too-large' : 'network-error',
        initiator,
        error: String(error).slice(0, 120)
      }
    }
  })
}
