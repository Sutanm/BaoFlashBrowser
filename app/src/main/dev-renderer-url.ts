/**
 * 开发态渲染层地址的**准入判定**（纯函数，不 import electron，可在单测里覆盖）。
 *
 * 为什么单独拆出来：这个地址的内容会以 `bao://` 的权限被外壳/内部页加载。打包后若环境变量
 * 残留、或指向任意外部主机，等于把内部页变成「代理任意站点」——2026-11-26 审计把它列为
 * 特定启动环境下的静态风险。判据只有两条，都必须成立：
 *
 * 1. **不是打包产物**（`app.isPackaged === false`）；
 * 2. 目标必须是**回环地址**（`127.0.0.1` / `localhost` / `::1`）。
 *
 * 生产构建里这个函数恒返回 `undefined`，内部页只读 `out/renderer`。
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export function resolveDevRendererUrl(
  raw: string | undefined,
  packaged: boolean
): URL | undefined {
  if (packaged) return undefined
  if (!raw) return undefined
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  const host = url.hostname.toLowerCase()
  if (!LOOPBACK_HOSTS.has(host) && !LOOPBACK_HOSTS.has(`[${host}]`)) return undefined
  return url
}
