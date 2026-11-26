/**
 * 窗口控制器入口处的**字面量身份**判断：地址、文档、标题。
 *
 * 为什么单独成模块：这四件事都是「外部给的字符串不可信」的判断，而且历史上有过真实事故
 * （占位标题让标签栏闪地址、`sameDocument` 把不同端口当同一文档）。它们现在只在
 * `browser-window.ts` 的闭包里被用到，但改错一次就要靠 30 个 smoke 文件才发现——所以抽成
 * 纯函数，用毫秒级用例钉住边界。这里不 import electron。
 *
 * 刻意**没有**搬走的东西：`safe()`、`fail()`、`currentTheme()`、`popupSize()`。
 * 它们要么只有 2–11 行、要么被上百处调用（`safe`），搬出去只会制造 import 噪音，
 * 不产生任何可测性收益。拆分的判据是「能不能被独立验证」，不是行数。
 */

/** 可被当作网页地址（http/https，且不带内联凭据）。 */
export function isWebAddress(value: string): boolean {
  const url = URL.parse(value)
  return !!url && (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password
}

/**
 * 判断标题是不是 Chromium 的「占位标题」（文档还没给出 `<title>` 时它等于 URL）。
 *
 * 内部页最容易撞上：标签一建好就有地址，标题先是 `bao://settings`（注意不带结尾斜杠），
 * 标签栏会闪一下地址。占位判定用「忽略结尾斜杠后相等」+「本身就是 bao: 地址」两条。
 */
export function placeholderTitle(title: string, address: string): boolean {
  if (!title) return true
  if (/^bao:\/\//i.test(title)) return true
  const normalize = (value: string): string => value.replace(/\/+$/, '')
  return normalize(title) === normalize(address)
}

/**
 * 把地址栏输入变成可加载的 URL。
 *
 * 规则：去掉首尾空白、含内部空白一律拒绝；已经有 scheme（且不是 `host:port` 那种）就原样用，
 * 否则补 `https://`；最后必须通过 `isWebAddress`。`host:port` 特判是必要的——
 * `127.0.0.1:8080` 形如 `scheme:`，不特判会被当成 scheme 而拒绝。
 */
export function parseAddress(input: string): string | undefined {
  const address = input.trim()
  if (!address || /\s/.test(address)) return
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(address)
  const hasPort = /^[^/:]+:\d+(?:[/?#]|$)/.test(address)
  const value = hasScheme && !hasPort ? address : `https://${address}`
  if (isWebAddress(value)) return new URL(value).href
}

/**
 * 两个地址是不是**同一个文档**（外壳页识别用）。
 *
 * 只比协议、主机与路径（忽略结尾斜杠）：查询串和 hash 不参与，因为外壳页会被带上参数。
 * 端口必须精确比较——`example.com:443` 与 `:8443` 不是同一个文档。这也是 2026-11-25
 * 审计里修掉的那类漏洞，别退回成「按注册域比较」。
 */
export function sameDocument(actual: string, expected: string): boolean {
  try {
    const left = new URL(actual)
    const right = new URL(expected)
    return left.protocol === right.protocol && left.host === right.host &&
      left.pathname.replace(/\/$/, '') === right.pathname.replace(/\/$/, '')
  } catch {
    return false
  }
}
