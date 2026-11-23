import { randomBytes } from 'node:crypto'

/**
 * broker 请求头的私有标记令牌（架构 §3 引擎「站点兼容规则」）。
 *
 * Chromium 不接受在 `net.request` 的 header 里直接设 `Referer`（会以
 * `ERR_BLOCKED_BY_CLIENT` 拒绝），只能在 `webRequest.onBeforeSendHeaders` 里还原。
 * 但 `onBeforeSendHeaders` 是**整个页面会话**级别的：如果页面脚本自己写
 * `X-Bao-Referer`，也会被还原成 `Referer`，等于让页面伪造任意 Referer。
 *
 * 因此标记值由主进程生成、每次启动随机，页面脚本无从得知：
 * `X-Bao-Referer: <token>|<编码后的发起文档 URL>`，只有 token 匹配才会被还原。
 */
export const BROKER_REFERER_HEADER = 'X-Bao-Referer'

const TOKEN = randomBytes(16).toString('hex')

export function brokerRefererMarker(initiator: string): string {
  return `${TOKEN}|${encodeURIComponent(initiator)}`
}

/** 校验并解出发起文档 URL；令牌不符或格式错误返回 undefined。 */
export function readBrokerRefererMarker(value: string): string | undefined {
  const separator = value.indexOf('|')
  if (separator <= 0) return undefined
  if (value.slice(0, separator) !== TOKEN) return undefined
  try {
    return decodeURIComponent(value.slice(separator + 1))
  } catch {
    return undefined
  }
}
