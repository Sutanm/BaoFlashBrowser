import { readFileSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import { protocol } from 'electron'
import type { Session } from 'electron'

/**
 * 内部页（`bao://settings`）——架构 §3 尾注：设置入口要「对齐 Edge/Chrome 的设置页」。
 *
 * 为什么用自定义特权 scheme 而不是 `file://`（实测依据，2026-11-23）：
 * - `file://` 文档的 origin 恒为 `file://`，与"任意本地文件页面"同源，而且页面会话
 *   也能直接 `loadURL(file://…)`；
 * - `bao://settings` 有独立 origin、`isSecureContext: true`，且**只在我们绑定 handler
 *   的那个会话里能加载**（页面会话 `loadURL` 返回 `ERR_FAILED (-2)`，`fetch` 全拒绝）。
 *
 * 两句必须记住的约束：
 * 1. `registerSchemesAsPrivileged` 必须在 `app.ready` 之前调用，之后调用直接抛错。
 * 2. handler 只绑内部会话，而**内部会话永远不能承载 http(s) 文档**——实测绑定了 handler
 *    的会话里加载的网页可以 `fetch('bao://settings/…')` 拿到 200，等于开了新特权面。
 */

export const INTERNAL_SCHEME = 'bao'
export const SETTINGS_HOST = 'settings'
/** 规范的设置页地址（尾斜杠保留：`webContents.getURL()` 也返回这个形式）。 */
export const SETTINGS_URL = 'bao://settings/'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
}

/**
 * 内部页的 CSP：只允许自己的脚本与样式，禁止外部请求、内联脚本、frame。
 * 用**响应头**下发（实测生效：内联脚本被拦，页面仍正常渲染）。
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "form-action 'none'"
].join('; ')

/** 渲染层产物目录（开发与打包同构：`__dirname` 都是 `out/main`）。 */
function rendererRoot(): string {
  return normalize(join(__dirname, '..', 'renderer'))
}

/**
 * 必须在 `app.whenReady()` 之前调用，且必须与其它 scheme **合并成一次**调用
 * （多次调用会覆盖，2026-11-23 实测）。所以这里只导出描述符。
 */
export function internalSchemePrivileges(): Parameters<typeof protocol.registerSchemesAsPrivileged>[0] {
  return [{
    scheme: INTERNAL_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      // 内部页要用 fetch 取自己的资源；`corsEnabled` 刻意不开——它会让同一会话里的
      // 其它文档也能读 `bao://` 资源，而内部会话本来就不该承载网页。
      supportFetchAPI: true
    }
  }]
}

export function isSettingsUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    // `bao:` 不是 special scheme，URL 解析**不会**把主机名转小写
    // （实测 `new URL('BAO://SETTINGS/').hostname === 'SETTINGS'`），所以这里自己归一，
    // 否则地址栏输入大写内部地址会识别不出来。
    return parsed.protocol === `${INTERNAL_SCHEME}:` && parsed.hostname.toLowerCase() === SETTINGS_HOST
  } catch {
    return false
  }
}

/**
 * 把地址栏输入解析成设置页地址。只接受 `bao://settings` 与 `bao://settings/...`，
 * 其它 `bao://` 一律拒绝（不是"回落到别的页"，是明确非法地址）。
 */
export function parseSettingsAddress(input: string): string | undefined {
  const text = input.trim()
  if (!/^bao:\/\//i.test(text)) return
  if (isSettingsUrl(text)) {
    const url = new URL(text)
    if (url.port) return
    return SETTINGS_URL
  }
}

/** 把 `bao://settings/<path>` 映射到 `out/renderer` 下的文件；越界一律 400。 */
function resolveFile(url: URL): string | undefined {
  const root = rendererRoot()
  const relative = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  const candidate = normalize(join(root, relative || 'settings.html'))
  if (candidate !== root && !candidate.startsWith(root + sep)) return
  if (relative.startsWith('..') || relative.includes(`..${sep}`)) return
  return candidate
}

let bound = false

/**
 * 绑定协议到**内部会话**（幂等）。调用方：应用启动时对 `getInternalSession()` 调一次。
 */
export function bindInternalProtocol(target: Session): void {
  if (bound) return
  bound = true
  target.protocol.handle(INTERNAL_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('bad request', { status: 400 })
    }
    if (url.hostname !== SETTINGS_HOST) return new Response('not found', { status: 404 })
    const file = resolveFile(url)
    if (!file) return new Response('bad request', { status: 400 })
    try {
      const body = readFileSync(file)
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: {
          'Content-Type': MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
          // 设置页要能读到最新值：不让 Chromium 缓存内部页资源。
          'Cache-Control': 'no-store',
          'Content-Security-Policy': CONTENT_SECURITY_POLICY,
          'X-Content-Type-Options': 'nosniff'
        }
      })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}
