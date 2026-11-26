import { createApp } from 'vue'
import './tokens.css'
import NewTabPage from './NewTabPage.vue'
import { readInternalBootstrap } from '../shared/internal-bootstrap'
import { applyShellTheme, initialShellTheme } from './theme'
import type { NtpSnapshot } from '../shared/ntp'

/**
 * 新标签页入口（`bao://newtab`）。
 *
 * 首帧约定（2026-11-26 重做）：主进程在返回 HTML 时已经注入了主题变量与 `NtpSnapshot`
 * （见 `shared/internal-bootstrap.ts`），所以这里**先**把主题落到 `<html>`、**再**带着快照挂载。
 *
 * 没有骨架、没有 `opacity` 门控：第一帧画出来的就是真页面，不存在"交接"这一刻，也就不会跳。
 * `read()` 仍然保留——注入的只是首帧副本，运行时以主进程为准（跨窗口改主题、插件后发现等）。
 */
const bootstrap = readInternalBootstrap()
const snapshot = bootstrap?.snapshot as NtpSnapshot | undefined
applyShellTheme(bootstrap?.theme ?? initialShellTheme())
createApp(NewTabPage, { bootstrap: snapshot }).mount('#app')
