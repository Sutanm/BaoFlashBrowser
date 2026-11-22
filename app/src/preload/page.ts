import { ipcRenderer, webFrame } from 'electron'

/**
 * Ruffle 页面预加载（架构 §3 引擎）。
 *
 * 只挂在 Ruffle 引擎的页面视图上。预加载运行在隔离世界，`webFrame.executeJavaScript`
 * 把 Ruffle 引导注入页面主世界 —— Ruffle 需要在主世界 polyfill `<embed>/<object>`，
 * 这样页面视图仍然保持 context isolation。
 *
 * 运行时源码走**同步 IPC** 取（而不是 `fetch('ruffle-resource://…')`）：站点 CSP 的
 * `connect-src` 会拦掉页面世界的 fetch，而 IPC 不受 CSP 约束。WASM 仍由 Ruffle 自己通过
 * `ruffle-resource://` 取，版本固定。
 */
/**
 * `publicPath` 必须是**合法 URL 基址**：Ruffle 用 `new URL(wasmName, publicPath)` 解析 WASM，
 * 而 `standard` scheme 要求 host 非空 —— `ruffle-resource://` 会直接抛
 * `Failed to construct 'URL': Invalid URL`（真实站点上表现为 Ruffle 错误面板）。
 * 因此带一个占位 host 和结尾斜杠：`ruffle-resource://assets/`。
 */
const RUFFLE_CONFIG = {
  publicPath: 'ruffle-resource://assets/',
  favorFlash: false,
  quality: 'best',
  forceScale: true
} as const

try {
  const source: unknown = ipcRenderer.sendSync('bao:ruffle-bundle')
  if (typeof source !== 'string' || !source) {
    console.error('[ruffle] 未取到本地运行时')
  } else {
    void webFrame.executeJavaScript(
      `window.RufflePlayer = { config: ${JSON.stringify(RUFFLE_CONFIG)} };\n${source}\n//# sourceURL=ruffle-resource://ruffle.js`
    ).then(
      () => console.info('[ruffle] 引导完成'),
      (error: unknown) => console.error('[ruffle] 引导失败', error)
    )
  }
} catch (error) {
  console.error('[ruffle] 引导失败', error)
}
