import { app, ipcMain, protocol } from 'electron'
import type { Session } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

/**
 * Ruffle 本地资源（架构 §3 引擎：「Ruffle 使用版本固定的本地资源」）。
 *
 * 资源随仓库入库（`app/vendor/ruffle/`，版本与 SHA-256 见该目录 PROVENANCE）。
 * 页面通过 `ruffle-resource://<文件名>` 取 `ruffle.js` 与 WASM：自定义协议在
 * `app.whenReady()` 之前登记为特权 scheme，再按页面会话绑定处理器。
 */
export const RUFFLE_SCHEME = 'ruffle-resource'
const RUFFLE_DIR = join(app.getAppPath(), 'vendor', 'ruffle')
const SAFE_RESOURCE_NAME = /^[a-zA-Z0-9._-]+$/

export interface RuffleBundleInfo {
  readonly version: string
  readonly bytes: number
  readonly sha256: string
}

let bundleInfo: RuffleBundleInfo | undefined

function readPackageVersion(): string {
  try {
    const pkg: unknown = JSON.parse(readFileSync(join(RUFFLE_DIR, 'package.json'), 'utf8'))
    const version = (pkg as { version?: unknown }).version
    if (typeof version === 'string' && version) return version
  } catch {
    // 版本缺失不影响运行时；Ruffle 自身也会报版本。
  }
  return 'unknown'
}

/** 读取并缓存 `ruffle.js`，同时记录版本、字节数与 SHA-256（架构 §2 可追溯）。 */
export function ruffleBundleInfo(): RuffleBundleInfo {
  if (!bundleInfo) {
    const source = readFileSync(join(RUFFLE_DIR, 'ruffle.js'), 'utf8')
    bundleInfo = {
      version: readPackageVersion(),
      bytes: Buffer.byteLength(source),
      sha256: createHash('sha256').update(source).digest('hex')
    }
  }
  return bundleInfo
}

function mimeTypeFor(fileName: string): string {
  switch (extname(fileName).toLowerCase()) {
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.wasm':
      return 'application/wasm'
    case '.map':
      return 'application/json; charset=utf-8'
    case '.ttf':
      return 'font/ttf'
    case '.otf':
      return 'font/otf'
    default:
      return 'application/octet-stream'
  }
}

function resourceName(requestUrl: string): string | undefined {
  try {
    const url = new URL(requestUrl)
    // publicPath 是 `ruffle-resource://assets/`，文件名落在 pathname；同时接受 hostname
    // 形式（`ruffle-resource://<文件名>`），便于将来换布局。
    const fromPath = url.pathname.replace(/^\/+/, '')
    const candidate = decodeURIComponent(fromPath || url.hostname)
    if (!candidate || basename(candidate) !== candidate || !SAFE_RESOURCE_NAME.test(candidate)) return undefined
    return candidate
  } catch {
    return undefined
  }
}

/**
 * `standard` scheme 的 hostname 会被 URL 解析归一成小写，而 Ruffle 0.8 的 WASM 文件名带大写
 * 哈希（`ruffle_web_bg.QDRSAAAZ.wasm`）。Windows 文件系统大小写不敏感，碰巧能跑；Linux 上
 * 会 404，所以这里做一次不区分大小写的回退。
 */
function resolveResourcePath(fileName: string): string | undefined {
  const direct = join(RUFFLE_DIR, fileName)
  if (existsSync(direct)) return direct
  try {
    const match = readdirSync(RUFFLE_DIR).find((name) => name.toLowerCase() === fileName.toLowerCase())
    return match ? join(RUFFLE_DIR, match) : undefined
  } catch {
    return undefined
  }
}

/** 必须在 `app.whenReady()` 之前调用。 */
export function registerRuffleScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: RUFFLE_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }])
}

const bound = new WeakSet<Session>()

/** 把资源协议绑定到页面会话（每个会话只绑定一次）。 */
export function bindRuffleProtocol(pageSession: Session): void {
  if (bound.has(pageSession)) return
  bound.add(pageSession)
  pageSession.protocol.handle(RUFFLE_SCHEME, async (request) => {
    const fileName = resourceName(request.url)
    if (!fileName) {
      console.warn(`[ruffle] 拒绝非法资源地址：${request.url}`)
      return new Response('bad request', { status: 400 })
    }
    const resolved = resolveResourcePath(fileName)
    if (!resolved) {
      console.warn(`[ruffle] 资源缺失：${fileName}`)
      return new Response('not found', { status: 404 })
    }
    try {
      const body = readFileSync(resolved)
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: {
          'Content-Type': mimeTypeFor(fileName),
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Access-Control-Allow-Origin': '*'
        }
      })
    } catch {
      console.warn(`[ruffle] 资源读取失败：${fileName}`)
      return new Response('not found', { status: 404 })
    }
  })
}

/**
 * 页面 preload 需要的运行时源码。
 *
 * 用同步 IPC 而不是 `fetch('ruffle-resource://…')`：站点的 `connect-src` CSP 会拦页面
 * 世界的 fetch，而 preload 的 IPC 不受 CSP 约束（架构 §3 IPC：校验发送者身份）。
 *
 * 发送者校验用「视图登记表」而不是 URL：preload 在文档提交前执行，此时 `getURL()` 还是
 * 空的，按 URL 判断会把自己人挡掉。
 */
const pageViewIds = new Set<number>()

export function registerPageView(contentsId: number): void {
  pageViewIds.add(contentsId)
}

export function registerRuffleIpc(): void {
  ipcMain.on('bao:ruffle-bundle', (event) => {
    if (!pageViewIds.has(event.sender.id)) {
      console.warn(`[ruffle] 拒绝来源 ${event.sender.getURL() || '(空)'} 的运行时请求`)
      event.returnValue = ''
      return
    }
    event.returnValue = readFileSync(join(RUFFLE_DIR, 'ruffle.js'), 'utf8')
  })
}
