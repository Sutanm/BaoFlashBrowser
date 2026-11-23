import type { SettingsBridge } from '../shared/settings'

declare global {
  interface Window {
    /** 只在 `bao://settings` 内部页里存在（见 `src/preload/internal.ts`）。 */
    baoSettings: SettingsBridge
  }
}

export {}
