import { webDarkTheme, webLightTheme } from '@fluentui/tokens'

export const shellThemes = { light: webLightTheme, dark: webDarkTheme } as const

export type ShellTheme = keyof typeof shellThemes

export const windowPalette = {
  light: {
    color: webLightTheme.colorNeutralBackground4,
    symbolColor: webLightTheme.colorNeutralForeground1
  },
  dark: {
    color: webDarkTheme.colorNeutralBackground2,
    symbolColor: webDarkTheme.colorNeutralForeground1
  }
} as const
