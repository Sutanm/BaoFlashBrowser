import { createPinia } from 'pinia'
import { createApp } from 'vue'
import type { OverlayBridge } from '../shared/overlay'
import { OVERLAY_QUERY } from '../shared/overlay'
import './tokens.css'
import App from './App.vue'
import OverlayHost from './OverlayHost.vue'

/**
 * 共享进程模式（`BAO_OVERLAY_SHARED=1`）：浮层文档由外壳 `window.open` 产生，不加载 preload，
 * 因此 `window.baoOverlay` 不存在。同源同进程下可以直接借用 opener 的桥（contextBridge 暴露的
 * 对象可以跨窗口调用，事件也能收到，见 docs/discussions/2026-11-25-overlay-shared-process-demo.md）。
 *
 * 这段必须留在打包产物里：写成 index.html 的内联脚本不会执行——CSP `default-src 'self'`
 * 没有 `unsafe-inline`，内联脚本被静默拦掉（实测 window.baoOverlay 为 undefined）。
 */
function adoptOpenerBridge(): void {
  const opener = window.opener as (Window & Record<string, unknown>) | null
  if (!opener) return
  // 浮层文档需要的关键桥：`baoOverlay`（收飞窗事件）、`baoBrowser`（读外壳状态：主题/引擎/标签）。
  // 两者都是同源同进程的直接引用，调用会落在外壳渲染进程里，主进程看到的发送者也仍是外壳窗口。
  const self = window as unknown as Record<string, unknown>
  for (const name of ['baoOverlay', 'baoBrowser'] as const) {
    if (!self[name] && opener[name]) self[name] = opener[name]
  }
}

const kind = new URLSearchParams(location.search).get(OVERLAY_QUERY)
if (kind === 'overlay') {
  // 叠加层宿主：panel / quick / toast 共用一个文档（见 shell-overlays.ts 的合并说明）。
  adoptOpenerBridge()
  document.documentElement.classList.add('shell-overlay')
  createApp(OverlayHost).use(createPinia()).mount('#app')
} else {
  createApp(App).use(createPinia()).mount('#app')
}
