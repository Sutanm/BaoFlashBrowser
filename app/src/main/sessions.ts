import { session } from 'electron'
import { BROKER_REFERER_HEADER, readBrokerRefererMarker } from './broker-token'
import type { Session } from 'electron'

/**
 * 会话边界（架构 §3 权限与会话）。
 *
 * - 外壳使用受信任的本地来源与精简 preload，独立非持久分区。
 * - 页面默认关闭 Node，开启 context isolation、sandbox、webSecurity。
 * - 每个会话同时接权限检查与权限请求，当前一律拒绝；按请求来源与嵌入来源
 *   分级的规则属于 M1 后续增量，在引入需要权限的站点前补齐。
 */
const PAGE_PARTITION = 'persist:bao-next-pages'
const SHELL_PARTITION = 'bao-next-shell'

/**
 * 权限白名单（架构 §3 权限与会话「按请求来源及嵌入来源处理」）。
 *
 * 只放行 Flash 游戏真正需要的两项：`fullscreen`（游戏里的全屏按钮）与 `pointerLock`
 * （第一人称/拖拽类操作）。其余一律拒绝，旧产品同样只放行这两项。
 *
 * 2026-11-23 审计 P2：原先只看 WebContents 顶层 URL，无法区分**实际请求帧**与**嵌入来源**
 * ——被 `file:`/opaque 源嵌入的 iframe 也能借父页面的 http(s) 地址拿到权限。现在：
 * - 请求侧用 `details.requestingUrl`（真正发起请求的帧）；
 * - 检查侧用 `requestingOrigin` 与 `details.embeddingOrigin`（跨源子帧才给）；
 * - 两者出现时都必须是 http(s)：`file:`、`data:`、`about:blank`、`null`（opaque origin）一律拒绝。
 */
const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'pointerLock'])

function isHttpUrl(value: string | undefined | null): boolean {
  return !!value && /^https?:\/\/[^/]/i.test(value)
}

/** `null` / 空串是 opaque origin 的表示，不是 http(s)，必须拒绝。 */
function isHttpOrigin(value: string | undefined | null): boolean {
  if (!value) return false
  return /^https?:\/\//i.test(value) && value !== 'null'
}

function allows(
  permission: string,
  requestingUrl: string | undefined | null,
  embeddingOrigin?: string | undefined | null
): boolean {
  if (!ALLOWED_PERMISSIONS.has(permission)) return false
  if (!isHttpUrl(requestingUrl)) return false
  // 只有跨源子帧才会带 embeddingOrigin；出现就必须也是 http(s)。
  if (embeddingOrigin !== undefined && !isHttpOrigin(embeddingOrigin)) return false
  return true
}

function applyPermissionPolicy(target: Session): Session {
  target.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    allows(permission, requestingOrigin || contents?.getURL(), details.embeddingOrigin))
  target.setPermissionRequestHandler((contents, permission, callback, details) => {
    const requestingUrl = 'requestingUrl' in details ? details.requestingUrl : undefined
    callback(allows(permission, requestingUrl || contents?.getURL()))
  })
  return target
}

/**
 * 下载默认拒绝（架构 §3 权限与会话「对弹窗、新窗口、导航及外部协议设显式策略」）。
 *
 * M1 还没有下载能力，也没有下载 UI 与落盘位置策略（§4 的下载在 M2 立项）。浏览器外壳
 * 在没有明确策略前不应静默写文件，因此先默认拒绝并打日志；M2 接入下载时替换为显式策略
 * （身份、分区、暂停/恢复、去重）。
 *
 * 注：曾把工作树里出现的第三方 SWF 误判为站点触发的下载，实际是人工放置的本地测试素材。
 * 该误判已从文档中更正；本策略的理由与站点无关。
 */
function denyDownloads(target: Session): Session {
  target.on('will-download', (event, item) => {
    console.warn(`[download] 已拒绝下载：${item.getURL()}`)
    event.preventDefault()
  })
  return target
}

/**
 * 跨源读权限由主进程 broker 按站点 `crossdomain.xml` 判定（见 `net-broker.ts`）。
 * 页面会话本身**不再**全局补 `Access-Control-Allow-Origin` —— 那等于移除页面 JS 的
 * 同源策略（内网设备、公共接口可读）。
 */
/**
 * 把 broker 打的 `X-Bao-Referer` 标记还原成真正的 `Referer`。
 *
 * Chromium 不接受在 `net.request`/`net.fetch` 的 header 里直接设 `Referer`
 * （会以 `ERR_BLOCKED_BY_CLIENT` 拒绝），只能在 `onBeforeSendHeaders` 里改。
 * 真实站点（4399）缺 Referer 时会返回「访问错误」内容而不是正版 SWF。
 *
 * 这个钩子是**整个页面会话**级别的，页面脚本也能写同名头，所以标记值带主进程随机令牌
 * （见 `broker-token.ts`）：令牌不匹配时**只剥离标记**、不改 Referer，页面无法伪造。
 */
function restoreBrokerReferer(target: Session): Session {
  target.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    const headers: Record<string, string> = { ...details.requestHeaders }
    const key = BROKER_REFERER_HEADER.toLowerCase()
    const marker = headers[BROKER_REFERER_HEADER] ?? headers[key]
    if (!marker) {
      callback({ requestHeaders: headers })
      return
    }
    const referer = readBrokerRefererMarker(marker)
    if (referer) headers.Referer = referer
    delete headers[BROKER_REFERER_HEADER]
    delete headers[key]
    callback({ requestHeaders: headers })
  })
  return target
}
let pageSession: Session | undefined
let shellSession: Session | undefined

export function getPageSession(): Session {
  pageSession ??= restoreBrokerReferer(denyDownloads(applyPermissionPolicy(session.fromPartition(PAGE_PARTITION))))
  return pageSession
}

export function getShellSession(): Session {
  shellSession ??= denyDownloads(applyPermissionPolicy(session.fromPartition(SHELL_PARTITION)))
  return shellSession
}
