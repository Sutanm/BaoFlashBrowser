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

function denyAllPermissions(target: Session): Session {
  target.setPermissionCheckHandler(() => false)
  target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  return target
}

/**
 * 下载默认拒绝（架构 §3 权限与会话「对弹窗、新窗口、导航及外部协议设显式策略」）。
 *
 * M1 还没有下载策略（§4 的下载在 M2 立项）。真实站点对照时发现 4399 会触发 SWF 下载，
 * 落盘位置由浏览器默认值决定 —— 对浏览器外壳来说这是意外副作用。先按白名单思路默认拒绝，
 * M2 接入下载能力时再把这里换成显式策略（身份、分区、暂停/恢复）。
 */
function denyDownloads(target: Session): Session {
  target.on('will-download', (event, item) => {
    console.warn(`[download] 已拒绝下载：${item.getURL()}`)
    event.preventDefault()
  })
  return target
}

/**
 * Ruffle 兼容层：SWF 的 CORS 放行（架构 §3 引擎、§4 webRequest 策略）。
 *
 * 两种引擎的网络模型不同：原生 PPAPI 插件进程自己发请求、不受 CORS 约束；Ruffle 用页面
 * `fetch()` 取 SWF，跨域 CDN（如 4399 的 `szhong.4399.com`）没给 `Access-Control-Allow-Origin`
 * 就会被浏览器拦掉，表现为 Ruffle 报 `Could not fetch` 并销毁实例。真实站点对照
 * （2026-11-22，https://www.4399.com/flash/254626_3.htm）复现了该差异。
 *
 * 只在**页面会话**上、只对 SWF 响应注入放行头，不碰带凭据的请求（`*` 与 credentials 互斥），
 * 也不改变响应体；PPAPI 路径不受影响。
 */
const SWF_URLS = ['*://*/*.swf', '*://*/*.swf?*']

function allowSwfCors(target: Session): Session {
  target.webRequest.onHeadersReceived({ urls: SWF_URLS }, (details, callback) => {
    const headers: Record<string, string[]> = {}
    for (const [name, value] of Object.entries(details.responseHeaders ?? {})) {
      if (name.toLowerCase() === 'access-control-allow-origin') continue
      headers[name] = value
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
  pageSession ??= denyDownloads(allowSwfCors(denyAllPermissions(session.fromPartition(PAGE_PARTITION))))
  return pageSession
}

export function getShellSession(): Session {
  shellSession ??= denyDownloads(denyAllPermissions(session.fromPartition(SHELL_PARTITION)))
  return shellSession
}
