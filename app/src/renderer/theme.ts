import { shellCssVariables } from '../shared/shell-tokens'

import type { ShellTheme } from '../shared/shell-theme'

/**
 * 应用一套主题的 CSS 变量。
 *
 * 变量映射本身在 `shared/shell-tokens.ts`——主进程注入内部页首帧时用的是**同一份**；
 * 两边各写一份必然漂移（`newtab.html` 的首帧色副本就漂成过 Fluent 蓝）。
 */
export function applyShellTheme(mode: ShellTheme): void {
  const root = document.documentElement
  // 用独立标记判断「这份文档是否已经应用过」：`data-theme` 由主进程注入（内部页首帧），
  // 拿它当幂等键会让我们跳过首次的颜色变量写入。
  if (root.dataset.shellTheme === mode) return

  root.dataset.theme = mode
  root.dataset.shellTheme = mode
  for (const [name, value] of Object.entries(shellCssVariables(mode))) root.style.setProperty(name, value)
}

/**
 * 叠加层文档的初始主题：宿主（OverlayHost）可能已经先一步应用过——共享模式下浮层文档是
 * 点击那一刻才建出来的，`panel-opened` 事件比异步组件挂载更早到。此时如果组件再用
 * `prefers-color-scheme` 猜一次，会把已经设好的暗色覆盖回浅色（实测暗色模式用例就是这么挂的）。
 *
 * 顺序：已经应用过的 `data-shell-theme` → 主进程注入的 `data-theme` → 系统偏好。
 */
export function initialShellTheme(): ShellTheme {
  const applied = document.documentElement.dataset.shellTheme
  if (applied === 'dark' || applied === 'light') return applied
  const injected = document.documentElement.dataset.theme
  if (injected === 'dark' || injected === 'light') return injected
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
