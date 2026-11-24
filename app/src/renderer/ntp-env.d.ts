import type { NtpBridge } from '../shared/ntp'

declare global {
  interface Window {
    /** 只在 `bao://newtab` 内部页里可用（见 `src/preload/internal.ts`）。 */
    baoNtp: NtpBridge
  }
}

export {}
