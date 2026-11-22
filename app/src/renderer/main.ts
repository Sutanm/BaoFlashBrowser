import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { OVERLAY_QUERY } from '../shared/overlay'
import './tokens.css'
import App from './App.vue'
import ShellOverlay from './ShellOverlay.vue'

const kind = new URLSearchParams(location.search).get(OVERLAY_QUERY)
if (kind === 'panel' || kind === 'toast') {
  document.documentElement.classList.add('shell-overlay')
  createApp(ShellOverlay, { kind }).use(createPinia()).mount('#app')
} else {
  createApp(App).use(createPinia()).mount('#app')
}
