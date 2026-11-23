import { shellThemes, windowPalette } from '../shared/shell-theme'

import type { ShellTheme } from '../shared/shell-theme'

export function applyShellTheme(mode: ShellTheme): void {
  const theme = shellThemes[mode]
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
    '--brand-stroke': theme.colorBrandStroke1,
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
