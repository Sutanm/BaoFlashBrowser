/**
 * 跨源 `Referer` 裁剪（审计 P2）。
 *
 * 浏览器默认策略是 `strict-origin-when-cross-origin`：
 * - 同源：发完整 URL（含路径与查询）；
 * - 跨源：只发 **origin**（scheme + host + port），不带路径与查询；
 * - https → http：**完全不发** Referer。
 *
 * 之前 broker 还原 Referer 时直接把文档 URL 原样发送，等于把完整路径和参数漏给第三方目标。
 * 这里按上面的规则裁剪；纯函数、不依赖 Electron，便于单测。
 */
export function trimReferer(refererUrl: string, targetUrl: string): string | undefined {
  let referer: URL
  let target: URL
  try {
    referer = new URL(refererUrl)
    target = new URL(targetUrl)
  } catch {
    return undefined
  }
  if (referer.protocol !== 'http:' && referer.protocol !== 'https:') return undefined
  // https → http 属于降级，浏览器不带 Referer。
  if (referer.protocol === 'https:' && target.protocol !== 'https:') return undefined
  if (referer.origin === target.origin) return referer.href
  return `${referer.origin}/`
}
