import { shellThemes, windowPalette } from '../shared/shell-theme'

import type { ShellTheme } from '../shared/shell-theme'

export function applyShellTheme(mode: ShellTheme): void {  const theme = shellThemes[mode]
  const root = document.documentElement
  // 用独立标记判断「这份文档是否已经应用过」：`data-theme` 由 HTML/CSS 预置（例如设置页
  // 的 `<html data-theme="light">`），拿它当幂等键会让我们跳过首次的颜色变量写入。
  if (root.dataset.shellTheme === mode) return

  const aliases = {
    '--surface-window': windowPalette[mode].color,
    '--surface-toolbar': theme.colorNeutralBackground1,
    '--surface-page': theme.colorNeutralBackground2,
    '--surface-hover': theme.colorNeutralBackground1Hover,
    '--surface-pressed': theme.colorNeutralBackground1Pressed,
    '--text-primary': theme.colorNeutralForeground1,
    '--text-secondary': theme.colorNeutralForeground3,
    '--text-disabled': theme.colorNeutralForegroundDisabled,
    '--text-error': theme.colorPaletteRedForeground1,
    '--stroke-divider': theme.colorNeutralStroke2,
    '--stroke-control': theme.colorNeutralStroke1,
    '--stroke-focus-inner': theme.colorStrokeFocus1,
    '--stroke-focus-outer': theme.colorStrokeFocus2,
    /*
     * 列表行的"选中"底色取 Fluent 的中性选中面，不取品牌色。
     *
     * 品牌色（紫）留给强调元素：radio 圆点、开关、链接、焦点环。整行铺品牌色在深色下
     * 就是一块饱和紫，跟两侧中性灰的卡片不在一个体系里——那正是"配色不跟主题"的来源。
     */
    '--surface-selected': theme.colorNeutralBackground1Selected,
    '--size-caption': theme.fontSizeBase200,
    '--size-body': theme.fontSizeBase300,
    '--space-xs': theme.spacingHorizontalXS,
    '--space-s': theme.spacingHorizontalS,
    '--space-m': theme.spacingHorizontalM,
    '--radius-control': theme.borderRadiusLarge,
    '--radius-surface': theme.borderRadiusXLarge,
    '--radius-pill': theme.borderRadiusCircular
  }

  root.dataset.theme = mode
  root.dataset.shellTheme = mode
  for (const [name, value] of Object.entries(aliases)) root.style.setProperty(name, value)
}

/**
 * 叠加层文档的初始主题：宿主（OverlayHost）可能已经先一步应用过——共享模式下浮层文档是
 * 点击那一刻才建出来的，`panel-opened` 事件比异步组件挂载更早到。此时如果组件再用
 * `prefers-color-scheme` 猜一次，会把已经设好的暗色覆盖回浅色（实测暗色模式用例就是这么挂的）。
 */
export function initialShellTheme(): ShellTheme {
  const applied = document.documentElement.dataset.shellTheme
  if (applied === 'dark' || applied === 'light') return applied
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}
