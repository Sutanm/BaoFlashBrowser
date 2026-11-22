import { contextBridge, ipcRenderer, webFrame } from 'electron'

/**
 * Ruffle 页面预加载（架构 §3 引擎）。
 *
 * 只挂在 Ruffle 引擎的页面视图上。预加载运行在隔离世界，`webFrame.executeJavaScript`
 * 把 Ruffle 引导注入页面主世界 —— Ruffle 需要在主世界 polyfill `<embed>/<object>`，
 * 这样页面视图仍然保持 context isolation。
 *
 * 网络（架构 §3 引擎「站点兼容规则」）：Ruffle 的 `fetch` 受页面 CORS 约束，而真实老站点
 * 不返回 `Access-Control-Allow-Origin`。这里把主世界的 `window.fetch` 换成经 broker 的版本：
 * 由主进程按目标站 `crossdomain.xml` 判定是否放行，放行时由主进程 `net.fetch` 取字节并
 * 以同源响应交给 Ruffle；未放行的请求**原样退回**浏览器 fetch（CORS 规则照常）。
 *
 * 运行时源码走**同步 IPC**（而不是页面 fetch）：站点 CSP 的 `connect-src` 会拦页面世界的
 * fetch，而 IPC 不受 CSP 约束。
 */
const RUFFLE_CONFIG = {
  publicPath: 'ruffle-resource://assets/',
  favorFlash: false,
  quality: 'best',
  forceScale: true
} as const

/** 装 fetch 垫片。在主世界编译，`__baoNet` 由 executeInMainWorld 的 args 代理注入。 */
const INSTALL_BROKER_FETCH = `(() => {
  const net = window.__baoNet
  if (!net || typeof net.request !== 'function') return 'no-transport'
  const original = window.fetch
  if (!original || original.__baoBroker) return 'already'
  const patched = async function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input)
      if (!/^https?:/i.test(url)) return original.call(this, input, init)
      const result = await net.request(url)
      if (!result || !result.proxied) {
        console.debug('[broker] 未放行', url, result && result.reason, result && result.error)
        return original.call(this, input, init)
      }
      const headers = new Headers()
      headers.set('content-type', result.contentType || 'application/octet-stream')
      return new Response(result.body, { status: result.status || 200, headers })
    } catch {
      return original.call(this, input, init)
    }
  }
  patched.__baoBroker = true
  window.fetch = patched
  return 'installed'
})()`

void (async () => {
  try {
    const source: unknown = ipcRenderer.sendSync('bao:ruffle-bundle')
    if (typeof source !== 'string' || !source) {
      console.error('[ruffle] 未取到本地运行时')
      return
    }

    // 1) 把 preload 的私有 transport 代理进主世界（页面 JS 只能看到 window.__baoNet 的
    //    代理函数；来源判定在主进程，用浏览器认证过的文档 URL，伪造不了）。
    await contextBridge.executeInMainWorld({
      func: (transport: { request: (url: string) => Promise<unknown> }) => {
        ;(window as unknown as { __baoNet: unknown }).__baoNet = { request: transport.request }
      },
      args: [{ request: (url: string) => ipcRenderer.invoke('bao:net-request', url) }]
    })

    // 2) 先装 fetch 垫片，再注入 Ruffle —— 保证 Ruffle 的所有请求都经过 broker。
    const installed = await webFrame.executeJavaScript(INSTALL_BROKER_FETCH)
    if (installed !== 'installed' && installed !== 'already') {
      console.warn(`[ruffle] fetch 垫片未安装：${String(installed)}`)
    }

    await webFrame.executeJavaScript(
      `window.RufflePlayer = { config: ${JSON.stringify(RUFFLE_CONFIG)} };\n${source}\n//# sourceURL=ruffle-resource://ruffle.js`
    )
    console.info('[ruffle] 引导完成')
  } catch (error) {
    console.error('[ruffle] 引导失败', error)
  }
})()
