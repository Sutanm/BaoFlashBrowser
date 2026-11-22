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
 * Ruffle 兼容层：跨源请求的 CORS 放行（架构 §3 引擎、§4 webRequest 策略）。
 *
 * 两种引擎的网络模型不同：原生 PPAPI 插件进程自己发请求、不受 CORS 约束；Ruffle 用页面
 * `fetch()` 取资源，跨域 CDN 没给 `Access-Control-Allow-Origin` 就会被浏览器拦掉。
 * 真实站点对照（2026-11-22）复现了两类：4399 的 SWF 在 `szhong.4399.com`、
 * 淘米客户端的数据地址 `newmisc.taomee.com/misc.js`。
 *
 * 范围取舍：站点不可穷举，逐站维护白名单不现实，因此**对页面会话的全部 http(s) 响应**
 * 补齐放行头 —— 与「每站实测」相比，这是可维护性与安全面的显式交换：
 * - 只补**缺失**的 `Access-Control-Allow-Origin`，服务端已有的头（含带凭据的精确源）保持不动；
 * - 只写 `*`，不写 `Access-Control-Allow-Credentials`（两者互斥），因此带凭据的跨源读取仍然不通；
 * - 只作用于页面会话，外壳（本地 `file:`）不受影响。
 * 后续做站点规则时，可以把这里收窄成「按站点/按请求类型」的策略。
 */
const HTTP_URLS = ['http://*/*', 'https://*/*']

function relaxCors(target: Session): Session {
  target.webRequest.onHeadersReceived({ urls: HTTP_URLS }, (details, callback) => {
    const headers: Record<string, string[]> = {}
    let hasOrigin = false
    for (const [name, value] of Object.entries(details.responseHeaders ?? {})) {
      if (name.toLowerCase() === 'access-control-allow-origin') hasOrigin = true
      headers[name] = value
    }
    if (hasOrigin) {
      callback({ responseHeaders: headers })
      return
    }
    headers['Access-Control-Allow-Origin'] = ['*']
    headers['Access-Control-Allow-Headers'] = ['*']
    headers['Access-Control-Allow-Methods'] = ['GET, POST, HEAD, OPTIONS']
    callback({ responseHeaders: headers })
  })
  return target
}

let pageSession: Session | undefined
let shellSession: Session | undefined

export function getPageSession(): Session {
  pageSession ??= denyDownloads(relaxCors(applyPermissionPolicy(session.fromPartition(PAGE_PARTITION))))
  return pageSession
}

export function getShellSession(): Session {
  shellSession ??= denyDownloads(applyPermissionPolicy(session.fromPartition(SHELL_PARTITION)))
  return shellSession
}
