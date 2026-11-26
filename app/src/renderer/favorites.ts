import { createApp } from 'vue'
import './tokens.css'
import FavoritesPage from './FavoritesPage.vue'
import { readInternalBootstrap } from '../shared/internal-bootstrap'
import { applyShellTheme, initialShellTheme } from './theme'
import type { FavoritesSnapshot } from '../shared/favorites'

/**
 * 收藏夹管理页入口（`bao://favorites`）。
 *
 * 与设置页、新标签页同一套首帧约定：主进程把主题变量与 `FavoritesSnapshot` 注入 HTML，
 * 这里先落主题、再带着快照挂载——第一帧就是真的树与列表，没有"空列表 → 内容"的跳变。
 * `read()` 仍然保留：注入的只是首帧副本，运行时以主进程为准（别的窗口改了收藏、
 * 系统主题变更等）。
 */
const bootstrap = readInternalBootstrap()
const snapshot = bootstrap?.snapshot as FavoritesSnapshot | undefined
applyShellTheme(bootstrap?.theme ?? initialShellTheme())
createApp(FavoritesPage, { bootstrap: snapshot }).mount('#app')
