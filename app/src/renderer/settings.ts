import { createApp } from 'vue'
import './tokens.css'
import SettingsPage from './SettingsPage.vue'

/**
 * 内部设置页入口（`bao://settings`）。
 *
 * 与外壳是**两个文档**：这里不引入 Pinia、不连 `baoBrowser`，只通过 preload 暴露的
 * `baoSettings`（read / write / subscribe）与主进程通信。
 */
createApp(SettingsPage).mount('#app')
