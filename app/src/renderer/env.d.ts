import type { BrowserBridge } from '../shared/browser'
import type { RuntimeVersions } from '../shared/runtime'

declare global {
  interface Window {
    readonly baoRuntime: RuntimeVersions
    readonly baoBrowser: BrowserBridge
  }
}
