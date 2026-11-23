import type { BrowserBridge } from '../shared/browser'
import type { OverlayBridge } from '../shared/overlay'
import type { RuntimeVersions } from '../shared/runtime'

declare global {
  interface Window {
    readonly baoRuntime: RuntimeVersions
    readonly baoBrowser: BrowserBridge
    readonly baoOverlay: OverlayBridge
    readonly baoWindowControl: { toggleMaximize(): Promise<boolean> }
  }
}
