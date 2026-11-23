import { createPinia } from 'pinia'
import { createApp } from 'vue'
import { OVERLAY_QUERY } from '../shared/overlay'
import './tokens.css'
import App from './App.vue'
import ShellOverlay from './ShellOverlay.vue'
import QuickSettings from './QuickSettings.vue'

const kind = new URLSearchParams(location.search).get(OVERLAY_QUERY)
if (kind === 'panel' || kind === 'toast' || kind === 'quick') {
  document.documentElement.classList.add('shell-overlay')
  const component = kind === 'quick' ? QuickSettings : ShellOverlay
  createApp(component, { kind }).use(createPinia()).mount('#app')
} else {
  createApp(App).use(createPinia()).mount('#app')
}
