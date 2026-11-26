import { shellThemes, windowPalette } from './shell-theme'
import type { ShellTheme } from './shell-theme'

/**
 * Fluent 设计 token → 我们 CSS 变量名的**唯一映射**。
 *
 * 为什么放在 `shared/`：这段映射现在有两个消费者，而且必须给出**完全相同**的结果——
 * 1. 渲染层 `theme.ts`：主题切换时写到 `documentElement` 的行内变量上；
 * 2. 主进程 `internal-pages.ts`：内部页（`bao://newtab`、`bao://settings`）响应时把同一份
 *    变量内联进 HTML，让**第一帧**就有正确配色（渲染层的 `applyShellTheme` 要等脚本执行，
 *    而模块脚本是 defer 的，第一帧已经画完了）。
 *
 * 两个地方各写一份必然漂移（本仓库已经吃过一次：`newtab.html` 的首帧色副本漂成 Fluent 蓝）。
 */
export function shellCssVariables(mode: ShellTheme): Record<string, string> {
  const theme = shellThemes[mode]
  return {
    '--surface-window': windowPalette[mode].color,
    '--surface-toolbar': theme.colorNeutralBackground1,
    '--surface-page': theme.colorNeutralBackground2,
    '--surface-hover': theme.colorNeutralBackground1Hover,
    '--surface-pressed': theme.colorNeutralBackground1Pressed,
    /*
     * 列表行的"选中"底色取 Fluent 的中性选中面，不取品牌色。
     *
     * 品牌色（紫）留给强调元素：radio 圆点、开关、链接、焦点环。整行铺品牌色在深色下
     * 就是一块饱和紫，跟两侧中性灰的卡片不在一个体系里——那正是"配色不跟主题"的来源。
     */
    '--surface-selected': theme.colorNeutralBackground1Selected,
    '--text-primary': theme.colorNeutralForeground1,
    '--text-secondary': theme.colorNeutralForeground3,
    '--text-disabled': theme.colorNeutralForegroundDisabled,
    '--text-error': theme.colorPaletteRedForeground1,
    '--stroke-divider': theme.colorNeutralStroke2,
    '--stroke-control': theme.colorNeutralStroke1,
    '--stroke-focus-inner': theme.colorStrokeFocus1,
    '--stroke-focus-outer': theme.colorStrokeFocus2,
    '--size-caption': theme.fontSizeBase200,
    '--size-body': theme.fontSizeBase300,
    '--space-xs': theme.spacingHorizontalXS,
    '--space-s': theme.spacingHorizontalS,
    '--space-m': theme.spacingHorizontalM,
    '--radius-control': theme.borderRadiusLarge,
    '--radius-surface': theme.borderRadiusXLarge,
    '--radius-pill': theme.borderRadiusCircular
  }
}

/** 把映射摊成可内联的 CSS 文本（`--x:y;` 一行一个）。 */
export function shellCssText(mode: ShellTheme): string {
  const declarations = Object.entries(shellCssVariables(mode))
    .map(([name, value]) => `  ${name}: ${value};`)
    .join('\n')
  return `:root {\n  color-scheme: ${mode};\n${declarations}\n}`
}
