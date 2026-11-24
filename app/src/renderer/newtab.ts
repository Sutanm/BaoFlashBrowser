import { createApp } from 'vue'
import './tokens.css'
import NewTabPage from './NewTabPage.vue'

/**
 * 新标签页入口（`bao://newtab`）。
 *
 * 与设置页同构：独立文档、不引入 Pinia、不连 `baoBrowser`。当前还没有 IPC——
 * 页面要等到接入 realbox / 设置入口时才挂窄桥（`baoNtp`），届时仍拿不到外壳桥。
 */
createApp(NewTabPage).mount('#app')
