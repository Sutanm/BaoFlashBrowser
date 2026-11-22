import { ipcMain, net } from 'electron'
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
 */
const MAX_BODY_BYTES = 32 * 1024 * 1024
const FETCH_TIMEOUT_MS = 20_000

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

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const response = await net.fetch(url, { signal: controller.signal, redirect: 'follow' })
      const buffer = await response.arrayBuffer()
      if (buffer.byteLength > MAX_BODY_BYTES) return { proxied: false, reason: 'too-large' }
      return {
        proxied: true,
        status: response.status,
        contentType: response.headers.get('content-type') ?? 'application/octet-stream',
        body: new Uint8Array(buffer)
      }
    } catch {
      return { proxied: false, reason: 'network-error' }
    } finally {
      clearTimeout(timer)
    }
  })
}
