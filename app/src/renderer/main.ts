import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { OVERLAY_QUERY } from '../shared/overlay'
import './tokens.css'
import App from './App.vue'
import OverlayHost from './OverlayHost.vue'
import ShellOverlay from './ShellOverlay.vue'

const kind = new URLSearchParams(location.search).get(OVERLAY_QUERY)
if (kind === 'overlay') {
  // 飞窗宿主：panel 与 quick 共用一个文档（见 shell-overlays.ts 的合并说明）。
  document.documentElement.classList.add('shell-overlay')
  createApp(OverlayHost).use(createPinia()).mount('#app')
} else if (kind === 'toast') {
  document.documentElement.classList.add('shell-overlay')
  createApp(ShellOverlay, { kind }).use(createPinia()).mount('#app')
} else {
  createApp(App).use(createPinia()).mount('#app')
}
