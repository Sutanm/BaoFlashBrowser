import { createApp } from 'vue'
import './tokens.css'
import SettingsPage from './SettingsPage.vue'
import { readInternalBootstrap } from '../shared/internal-bootstrap'
import { applyShellTheme, initialShellTheme } from './theme'
import type { SettingsSnapshot } from '../shared/settings'

/**
 * 内部设置页入口（`bao://settings`）。
 *
 * 与外壳是**两个文档**：这里不引入 Pinia、不连 `baoBrowser`，只通过 preload 暴露的
 * `baoSettings`（read / write / subscribe）与主进程通信。
 *
 * 首帧（2026-11-26）：主进程在 HTML 里注入了主题变量与 `SettingsSnapshot`，所以这里先落主题、
 * 再带着快照挂载——第一次渲染就有正确配色与真实值，不会出现"无 token 的白字一帧"。
 */
const bootstrap = readInternalBootstrap()
const snapshot = bootstrap?.snapshot as SettingsSnapshot | undefined
applyShellTheme(bootstrap?.theme ?? initialShellTheme())
createApp(SettingsPage, { bootstrap: snapshot }).mount('#app')
