import { session } from 'electron'
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
 * （第一人称/拖拽类操作）。其余一律拒绝，且必须来自 http(s) 来源 —— `file:`/`data:`
 * 等本地文档不参与。旧产品同样只放行这两项，这里保持同一范围。
 */
const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'pointerLock'])

function allows(permission: string, url: string | undefined | null): boolean {
  return ALLOWED_PERMISSIONS.has(permission) && !!url && /^https?:/i.test(url)
}

function applyPermissionPolicy(target: Session): Session {
  target.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
    allows(permission, requestingOrigin || contents?.getURL()))
  // 请求侧不用 details 的联合类型：直接看发起请求的页面 URL 更稳，语义也一致。
  target.setPermissionRequestHandler((contents, permission, callback) => {
    callback(allows(permission, contents?.getURL()))
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
let pageSession: Session | undefined
let shellSession: Session | undefined

export function getPageSession(): Session {
  pageSession ??= denyDownloads(applyPermissionPolicy(session.fromPartition(PAGE_PARTITION)))
  return pageSession
}

export function getShellSession(): Session {
  shellSession ??= denyDownloads(applyPermissionPolicy(session.fromPartition(SHELL_PARTITION)))
  return shellSession
}
