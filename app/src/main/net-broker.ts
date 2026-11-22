import { ipcMain, net } from 'electron'
import type { ClientRequest, IncomingMessage } from 'electron'
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
 * 之前用「页面会话全局补 `Access-Control-Allow-Origin: *`」绕过，等于**移除页面 JS 的
 * 同源策略**（内网设备、公共接口可读）。现在改为**按 Flash 策略放行**：
 *
 * - 不引入 URL 可寻址的代理 scheme（那等于给页面一个全局读原语）；
 * - 全部走 IPC，来源用 `event.senderFrame.url`（浏览器认证过的文档 URL），页面无法伪造；
 * - 跨源读取要求目标站 `crossdomain.xml` 允许该来源；同源直接放行；
 * - 未放行的请求**原样退回**浏览器 fetch（CORS 规则照常生效），不返回任何字节。
 *
 * 请求用 `net.request` 而不是 `net.fetch`：`fetch` 规范禁止设置 `Referer`/`Cookie`，
 * 而反盗链站点（4399）缺了 `Referer` 会直接返回「访问错误」页。
 */
const MAX_BODY_BYTES = 32 * 1024 * 1024
const TIMEOUT_MS = 20_000

export interface NetBrokerResult {
  /** true 表示 broker 已取到字节；false 表示调用方应回退到浏览器 fetch。 */
  readonly proxied: boolean
  readonly status?: number
  readonly contentType?: string
  readonly body?: Uint8Array
  /** 拒绝原因，仅用于日志与诊断，不含敏感内容。 */
  readonly reason?: 'not-page-view' | 'policy-denied' | 'too-large' | 'network-error'
  /** 诊断用：被拒时的来源文档 URL（不含敏感内容）。 */
  readonly initiator?: string
  /** 诊断用：网络错误的简短描述。 */
  readonly error?: string
}

interface BrokerBytes {
  status: number
  contentType: string
  body: Uint8Array
}

function requestBytes(
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
      redirect: 'follow',
      session: target
    })
    const timer = setTimeout(() => {
      request.abort()
      finish(new Error('timeout'))
    }, timeoutMs)

    for (const [name, value] of Object.entries(headers)) request.setHeader(name, value)
    request.on('error', (error) => finish(error as Error))
    request.on('response', (response: IncomingMessage) => {
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

    // 补齐 Flash 会带的请求头：
    // - Referer：flash 的 URLLoader 带发起文档地址；4399 的 CDN 缺它会返回 23KB 的
    //   「访问错误」内容（正版 2.7MB）。Chromium 不接受 header 直接设 Referer
    //   （ERR_BLOCKED_BY_CLIENT），改用 `X-Bao-Referer` 标记，由页面会话的
    //   `onBeforeSendHeaders` 还原成真正的 Referer（见 sessions.ts）。
    // - Cookie：Flash 对目标域会带 cookie（登录后的游戏接口依赖它）。
    // - User-Agent：沿用页面视图的 UA，避免站点按 Electron 默认 UA 区分。
    const headers: Record<string, string> = {
      'User-Agent': event.sender.getUserAgent() || 'Mozilla/5.0',
      Accept: '*/*'
    }
    if (initiator) headers['X-Bao-Referer'] = encodeURIComponent(initiator)
    try {
      const cookies = await event.sender.session.cookies.get({ url })
      if (cookies.length > 0) {
        headers.Cookie = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
      }
    } catch {
      // cookie 取不到不影响主体请求
    }

    try {
      const bytes = await requestBytes(url, headers, TIMEOUT_MS, event.sender.session)
      if (bytes.body.byteLength > MAX_BODY_BYTES) return { proxied: false, reason: 'too-large' }
      return {
        proxied: true,
        status: bytes.status,
        contentType: bytes.contentType,
        body: bytes.body
      }
    } catch (error) {
      const tooLarge = String(error).includes('too-large')
      return { proxied: false, reason: tooLarge ? 'too-large' : 'network-error', initiator, error: String(error).slice(0, 120) }
    }
  })
}
