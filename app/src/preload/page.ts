import { contextBridge, ipcRenderer, webFrame } from 'electron'

/**
 * Ruffle 页面预加载（架构 §3 引擎）。
 *
 * 只挂在 Ruffle 引擎的页面视图上。预加载运行在隔离世界，`webFrame.executeJavaScript`
 * 把 Ruffle 引导注入页面主世界 —— Ruffle 需要在主世界 polyfill `<embed>/<object>`，
 * 这样页面视图仍然保持 context isolation。
 *
 * ## 网络（2026-11-23 审计后收紧）
 *
 * Ruffle 的 SWF/数据请求走 wasm-bindgen 生成的 `__wbg_fetch_*` import（内部是
 * `window.fetch(request)`）。真实老站点不返回 `Access-Control-Allow-Origin`，所以需要主进程
 * 按 `crossdomain.xml` 放行。
 *
 * **不替换页面的 `window.fetch`**：那是把主进程的网络能力交给普通网页脚本（审计 P1-1）。
 * 这里改成在注入前重写 wasm-bindgen 的**那一个** import，把 Ruffle 自己的 fetch 指向私有传输：
 * - 传输是 `executeInMainWorld` 代理进来的函数，只存于本轮注入的 IIFE 闭包；
 * - 承载它的临时全局在 IIFE 第一行就 `delete`，页面脚本读不到；
 * - 页面 `window.fetch` 保持原生，页面脚本行为与普通浏览器一致。
 *
 * 若 import 模式匹配失败（Ruffle 升级导致），**fail-closed**：注入未打补丁的 bundle，
 * 只失去跨域兼容（同源照常），绝不退化成特权通道。
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

/** wasm-bindgen 的 fetch import（`A` 是 window，`e` 是 Request）。 */
const FETCH_IMPORT = '__wbg_fetch_729fad2e5272298f:function(A,e){return A.fetch(e)}'
const FETCH_IMPORT_PATCHED = '__wbg_fetch_729fad2e5272298f:function(A,e){return __baoRuffleFetch(e)}'

const TEMP_GLOBAL_PREFIX = '__bao_'

function randomKey(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return `${TEMP_GLOBAL_PREFIX}${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

/** 生成注入脚本；`patched` 为 false 表示没匹配到 fetch import（fail-closed 注入原文）。 */
function buildInjection(source: string, transportKey: string): { script: string; patched: boolean } {
  const patchedSource = source.replace(FETCH_IMPORT, FETCH_IMPORT_PATCHED)
  const patched = patchedSource !== source
  const config = `window.RufflePlayer = { config: ${JSON.stringify(RUFFLE_CONFIG)} }`
  const body = patched ? patchedSource : source
  return {
    patched,
    script: `(function () {
  var __baoTransport = window['${transportKey}']
  try { delete window['${transportKey}'] } catch (error) {}
  var __baoRuffleFetch = function (request) {
    var url = ''
    try { url = typeof request === 'string' ? request : String((request && request.url) || '') } catch (error) { url = '' }
    if (!url || !__baoTransport) return fetch(request)
    return __baoTransport.request(url).then(function (result) {
      if (!result || !result.proxied) return fetch(request)
      var headers = new Headers()
      headers.set('content-type', result.contentType || 'application/octet-stream')
      return new Response(result.body, { status: result.status || 200, headers: headers })
    }, function () { return fetch(request) })
  }
  ${config}
  ${body}
  //# sourceURL=ruffle-resource://ruffle.js
})()`
  }
}

void (async () => {
  try {
    const source: unknown = ipcRenderer.sendSync('bao:ruffle-bundle')
    if (typeof source !== 'string' || !source) {
      console.error('[ruffle] 未取到本地运行时')
      return
    }

    const transportKey = randomKey()
    const injection = buildInjection(source, transportKey)
    if (!injection.patched) {
      console.error('[ruffle] 未能定位 wasm-bindgen 的 fetch import，跨域兼容停用（同源不受影响）')
    } else {
      // 把 preload 的私有 transport 代理进主世界；IIFE 第一行就把它从 window 上删掉。
      await contextBridge.executeInMainWorld({
        func: (key: string, transport: { request: (url: string) => Promise<unknown> }) => {
          ;(window as unknown as Record<string, unknown>)[key] = transport
        },
        args: [transportKey, { request: (url: string) => ipcRenderer.invoke('bao:net-request', url) }]
      })
    }

    await webFrame.executeJavaScript(injection.script)
    console.info('[ruffle] 引导完成')
  } catch (error) {
    console.error('[ruffle] 引导失败', error)
  }
})()
