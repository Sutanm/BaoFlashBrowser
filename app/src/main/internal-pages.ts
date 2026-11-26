import { readFileSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import { app, net, protocol } from 'electron'
import { injectInternalBootstrap } from '../shared/internal-bootstrap'
import { resolveDevRendererUrl } from './dev-renderer-url'
import type { InternalBootstrap } from '../shared/internal-bootstrap'
import type { Session } from 'electron'

/**
 * 内部页（`bao://newtab`、`bao://settings`）——架构 §3 尾注：设置入口要「对齐 Edge/Chrome 的设置页」；
 * 新标签页要对齐 Chrome 的 NTP：有稳定 URL，才能被单例页（设置/历史/书签）就地覆盖。
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
export const NEWTAB_HOST = 'newtab'
/**
 * 收藏夹管理页的 host（`bao://favorites/`）。
 *
 * 对齐 `chrome://bookmarks`：Chromium 把书签管理器当成**独立 WebUI**
 * （`chrome/browser/ui/webui/bookmarks/bookmarks_ui.cc`），不是工具栏上的气泡——
 * 它要摆「文件夹树 + 条目列表 + 工具栏」三块，气泡装不下，这一点与本项目
 * `overlay-geometry.ts` 里飞窗卡片只有 264 宽是同一个结论。
 */
export const FAVORITES_HOST = 'favorites'
/** 规范的设置页地址（尾斜杠保留：`webContents.getURL()` 也返回这个形式）。 */
export const SETTINGS_URL = 'bao://settings/'
/** 规范的新标签页地址（与 Chrome 的 `chrome://newtab/` 同构）。 */
export const NEWTAB_URL = 'bao://newtab/'
/** 规范的收藏夹管理页地址。 */
export const FAVORITES_URL = 'bao://favorites/'

/** 内部页种类：三种内部页共用同一个会话（不同 origin 由 host 区分）。 */
export type InternalKind = 'newtab' | 'settings' | 'favorites'

/** 每种内部页的规范地址（导航/恢复时用）。 */
export const internalUrls: Record<InternalKind, string> = {
  newtab: NEWTAB_URL,
  settings: SETTINGS_URL,
  favorites: FAVORITES_URL
}

/**
 * 每种内部页的标签标题。
 *
 * 一处定义、两处消费（建标签时的 `initialTitle` 与就地切换后的标题）：写两遍的话，
 * 从 NTP 就地变成收藏夹管理页时标签会先显示「新标签页」，而设置页那条路径早已修过同一个坑
 * （见 `browser-window.ts` 的 `placeholderTitle()` 注释）。
 */
export const internalTitles: Record<InternalKind, string> = {
  newtab: '新标签页',
  settings: '设置',
  favorites: '收藏夹'
}

/** 每种内部页的文档入口（`out/renderer` 下的文件名）。 */
const ENTRY_FILES: Record<InternalKind, string> = {
  newtab: 'newtab.html',
  settings: 'settings.html',
  favorites: 'favorites.html'
}

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
 * 开发态（`electron-vite dev`）的渲染层地址。
 *
 * 外壳用的是这个地址，但内部页之前**始终**读 `out/renderer`：没有产物时设置页打不开，
 * 有旧产物时又会显示上一次构建的页面（审计 P2）。这里让内部页在开发态也走开发服务器。
 */
function devRendererUrl(): URL | undefined {
  return resolveDevRendererUrl(process.env.ELECTRON_RENDERER_URL, app.isPackaged)
}

/** 开发态代理：把 `bao://<host>/<path>` 转给 Vite dev server，保持查询串。 */
async function proxyToDevServer(
  dev: URL,
  url: URL,
  entry: string,
  kind: InternalKind,
  bootstrap: BootstrapProvider
): Promise<Response> {
  const target = new URL(url.pathname === '/' ? `/${entry}` : url.pathname, dev)
  target.search = url.search
  const response = await net.fetch(target.href)
  const headers = {
    'Content-Type': response.headers.get('content-type') ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
    // 开发态同样下发生产 CSP 与 nosniff：否则「开发能跑、打包被拦」只会在发布时暴露。
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'X-Content-Type-Options': 'nosniff'
  }
  /**
   * 首帧注入在开发态也要做：不然会出现「dev 闪、打包不闪」，验收永远对不上。
   * 只有入口 HTML 才注入（子资源交给 Vite 原样返回）。
   */
  if (bootstrap && url.pathname === '/' && extname(entry).toLowerCase() === '.html') {
    try {
      const html = await response.text()
      return new Response(injectInternalBootstrap(html, bootstrap(kind)), { status: response.status, headers })
    } catch {
      // 注入失败就退回原始响应：首帧会退化成"脚本接管后才上色"，但页面还能打开。
    }
  }
  return new Response(response.body, { status: response.status, headers })
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

/**
 * 把主机名归一成内部页种类。
 *
 * `bao:` 不是 special scheme，URL 解析**不会**把主机名转小写
 * （实测 `new URL('BAO://SETTINGS/').hostname === 'SETTINGS'`），所以这里自己归一，
 * 否则地址栏输入大写内部地址会识别不出来。
 */
function hostKind(hostname: string): InternalKind | undefined {
  const host = hostname.toLowerCase()
  if (host === NEWTAB_HOST) return 'newtab'
  if (host === SETTINGS_HOST) return 'settings'
  if (host === FAVORITES_HOST) return 'favorites'
  return undefined
}

/** 解析内部页地址；端口是非法输入（`bao://settings:8080/` 不是内部页）。 */
export function internalKindOf(url: string): InternalKind | undefined {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== `${INTERNAL_SCHEME}:` || parsed.port) return undefined
    return hostKind(parsed.hostname)
  } catch {
    return undefined
  }
}

export function isInternalUrl(url: string): boolean {
  return internalKindOf(url) !== undefined
}

export function isSettingsUrl(url: string): boolean {
  return internalKindOf(url) === 'settings'
}

export function isNewTabUrl(url: string): boolean {
  return internalKindOf(url) === 'newtab'
}

export function isFavoritesUrl(url: string): boolean {
  return internalKindOf(url) === 'favorites'
}

/**
 * 把地址栏输入解析成内部页地址。只接受 `bao://settings…` 与 `bao://newtab…`，
 * 其它 `bao://` 一律拒绝（不是"回落到别的页"，是明确非法地址）。
 */
export function parseInternalAddress(input: string): { kind: InternalKind; url: string } | undefined {
  const text = input.trim()
  if (!/^bao:\/\//i.test(text)) return
  const kind = internalKindOf(text)
  return kind ? { kind, url: internalUrls[kind] } : undefined
}

/** 设置页专用的地址解析（地址栏 `bao://settings` 仍映射到规范地址）。 */
export function parseSettingsAddress(input: string): string | undefined {
  const parsed = parseInternalAddress(input)
  return parsed?.kind === 'settings' ? parsed.url : undefined
}

/** 把 `bao://<host>/<path>` 映射到 `out/renderer` 下的文件；越界一律 400。 */
function resolveFile(url: URL, entry: string): string | undefined {
  const root = rendererRoot()
  const relative = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  const candidate = normalize(join(root, relative || entry))
  if (candidate !== root && !candidate.startsWith(root + sep)) return
  if (relative.startsWith('..') || relative.includes(`..${sep}`)) return
  return candidate
}

let bound = false
/**
 * 首帧引导数据的提供者：按**内部页种类**给对应的快照（设置页要 `SettingsSnapshot`、
 * 新标签页要 `NtpSnapshot`），每次 `bindInternalProtocol` 调用都替换成最新窗口的。
 */
type BootstrapProvider = (kind: InternalKind) => InternalBootstrap
let bootstrapProvider: BootstrapProvider

/**
 * 绑定协议到**内部会话**（幂等）。调用方：应用启动时对 `getInternalSession()` 调一次。
 *
 * `bootstrap` 提供内部页首帧要用的主题与数据（见 `shared/internal-bootstrap.ts`）：
 * 每次调用都会替换它（协议只绑一次，但窗口可以开多个，最新窗口的快照最贴近用户当前状态）。
 * 它是**首帧副本**，不是权威：页面挂载后仍然用 `baoSettings.read()` / `baoNtp.read()` 校正。
 */
export function bindInternalProtocol(
  target: Session,
  bootstrap?: BootstrapProvider
): void {
  if (bootstrap) bootstrapProvider = bootstrap
  if (bound) return
  bound = true
  target.protocol.handle(INTERNAL_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('bad request', { status: 400 })
    }
    const kind = hostKind(url.hostname)
    if (!kind) return new Response('not found', { status: 404 })
    const entry = ENTRY_FILES[kind]
    const dev = devRendererUrl()
    if (dev) {
      try {
        return await proxyToDevServer(dev, url, entry, kind, bootstrapProvider)
      } catch {
        return new Response('dev server unavailable', { status: 502 })
      }
    }
    const file = resolveFile(url, entry)
    if (!file) return new Response('bad request', { status: 400 })
    try {
      const isHtml = extname(file).toLowerCase() === '.html'
      const body = isHtml
        ? Buffer.from(applyBootstrap(readFileSync(file, 'utf8'), kind, bootstrapProvider), 'utf8')
        : readFileSync(file)
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

/** 入口 HTML 才注入首帧数据；注入失败退回原文（页面仍能打开，只是首帧没有配色）。 */
function applyBootstrap(html: string, kind: InternalKind, bootstrap: BootstrapProvider): string {
  if (!bootstrap) return html
  try {
    return injectInternalBootstrap(html, bootstrap(kind))
  } catch (error) {
    console.warn('[internal] 首帧注入失败，退回原始 HTML：', error)
    return html
  }
}
