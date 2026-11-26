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
import { DEFAULT_SEARCH_ENGINE, looksLikeAddress, searchUrlFor } from '../shared/search'
import type { SearchEngine } from '../shared/search'

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
 * 输入里是否**明确写了** scheme（`javascript:` / `file:` / `bao:` …）。
 *
 * `host:port` 不算：`127.0.0.1:8080` 形如 scheme，但它就是要当地址用的特例——与
 * `parseAddress` 里那条 `host:port` 特判必须是同一个判据，否则两处会给出不同结论。
 */
function explicitScheme(text: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(text) && !/^[^/:]+:\d+(?:[/?#]|$)/.test(text)
}

/**
 * 地址栏 / 新标签页 realbox / 自动化 `tab.navigate` 的**唯一**输入解析点：
 * 像地址就导航，其余按默认搜索引擎搜索。
 *
 * 为什么搜索回退放在主进程：外壳工具栏、`bao://newtab` 的 realbox、自动化命令是三条
 * 入口，规则只能有一份。历史上渲染层各自解释输入的直接后果就是「新标签页的框写着
 * 『搜索或输入网址』，主进程却只会导航」——中文被 IDN 成 `xn--wxtr44c` 并真的去解析，
 * 得到 ERR_NAME_NOT_RESOLVED，用户看到的却是地址栏"用不了"。
 *
 * 返回 `undefined` 表示**既不是地址、也不该搜索**：目前只有 `javascript:` / `file:` /
 * `bao:` 这类非 http(s) scheme，以及带内联凭据的地址（`parseAddress` 拒绝它们）。
 * 把它们当关键词搜出去只会得到垃圾结果，保持原来的 `invalid-address` 提示更诚实。
 */
export function resolveNavigation(input: string, engine: SearchEngine = DEFAULT_SEARCH_ENGINE): string | undefined {
  const text = input.trim()
  if (!text) return
  // 明确写了 scheme：是地址就地址，不是就拒绝（不搜索）。
  if (explicitScheme(text)) return parseAddress(text)
  // 主机名形状：交给 parseAddress 做最后一道合法性判定（凭据、端口、IDN 归一）。
  if (looksLikeAddress(text)) return parseAddress(text)
  const searched = searchUrlFor(engine, text)
  return searched || undefined
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
