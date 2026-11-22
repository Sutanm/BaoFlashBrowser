/** Names the isolated renderer mode of the shell document. */
export const OVERLAY_QUERY = 'baoOverlay'
export type OverlayKind = 'panel' | 'toast'

export const overlayChannels = {
  command: 'overlay:command',
  event: 'overlay:event'
} as const

/** Bounds in window client coordinates (device-independent pixels). */
export interface OverlayBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface OverlayToast {
  bounds: OverlayBounds
  text: string
}

export type OverlayEvent =
  | { type: 'panel-opened' }
  | { type: 'panel-closed'; restoreFocus: boolean }
  | { type: 'toast-closed' }
  | { type: 'toast'; text: string }
  | { type: 'failure'; text: string }

export type OverlayCommand =
  | { type: 'set-panel'; bounds: OverlayBounds | null }
  | { type: 'set-toast'; toast: OverlayToast | null }
  | { type: 'resize-panel'; height: number }
  | { type: 'close-panel'; restoreFocus: boolean }
  | { type: 'dismiss-toast' }
  | { type: 'report-failure'; text: string }

export interface OverlayBridge {
  /** Shell only. Non-null opens/repositions, null closes without notification. */
  setPanel(bounds: OverlayBounds | null): Promise<boolean>
  /** Shell only. Non-null shows/updates, null hides without notification. */
  setToast(toast: OverlayToast | null): Promise<boolean>
  /** Panel only. Update measured height while preserving the shell anchor. */
  resizePanel(height: number): Promise<boolean>
  /** Panel only. Native notifies shell; optionally focus the shell/trigger. */
  closePanel(restoreFocus?: boolean): Promise<boolean>
  /** Toast only. Native notifies shell to clear its message. */
  dismissToast(): Promise<boolean>
  /** Panel only. Relay a command failure to the shell, which owns toast text. */
  reportFailure(text: string): Promise<boolean>
  subscribe(listener: (event: OverlayEvent) => void): () => void
}
