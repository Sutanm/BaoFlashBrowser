/** Names the isolated renderer mode of the shell document. */
export const OVERLAY_QUERY = 'baoOverlay'
export type OverlayKind = 'panel' | 'toast' | 'quick'

export const overlayChannels = {
  command: 'overlay:command',
  event: 'overlay:event',
  /** 度量（临时）：读取/清空叠加层打开耗时。 */
  metrics: 'overlay:metrics',
  metricsReset: 'overlay:metrics-reset'
} as const

/** Bounds in window client coordinates (device-independent pixels). */
import type { OverlayBounds } from './overlay-geometry'

export type { OverlayBounds }

export interface OverlayToast {
  bounds: OverlayBounds
  text: string
}

export type OverlayEvent =
  | { type: 'panel-opened'; theme: 'light' | 'dark' }
  | { type: 'panel-closed'; restoreFocus: boolean }
  | { type: 'quick-opened'; theme: 'light' | 'dark' }
  | { type: 'quick-closed'; restoreFocus: boolean }
  | { type: 'toast-closed' }
  /** 飞窗被隐藏（视图 detach）：让它暂停动画/定时器，等下次打开再恢复。 */
  | { type: 'overlay-hidden' }
  | { type: 'toast'; text: string }
  | { type: 'failure'; text: string }

export type OverlayCommand =
  | { type: 'set-panel'; bounds: OverlayBounds | null }
  | { type: 'set-toast'; toast: OverlayToast | null }
  | { type: 'resize-panel'; height: number }
  | { type: 'close-panel'; restoreFocus: boolean }
  /** 齿轮快捷设置（M2）：飞窗永远在窗口内，主进程按内容区夹取。 */
  | { type: 'set-quick'; bounds: OverlayBounds | null }
  | { type: 'resize-quick'; height: number }
  | { type: 'close-quick'; restoreFocus: boolean }
  | { type: 'dismiss-toast' }
  | { type: 'report-failure'; text: string }
  /** 叠加层文档报告「本次内容已渲染」（度量用，非产品行为）。 */
  | { type: 'report-ready' }
  /** Shell only. 入口悬停时预热叠加层（auto 策略）。 */
  | { type: 'prewarm' }

export interface OverlayBridge {
  /** Shell only. Non-null opens/repositions, null closes without notification. */
  setPanel(bounds: OverlayBounds | null): Promise<boolean>
  /** Shell only. Non-null shows/updates, null hides without notification. */
  setToast(toast: OverlayToast | null): Promise<boolean>
  /** Panel only. Update measured height while preserving the shell anchor. */
  resizePanel(height: number): Promise<boolean>
  /** Panel only. Native notifies shell; optionally focus the shell/trigger. */
  closePanel(restoreFocus?: boolean): Promise<boolean>
  /** Shell only. 齿轮飞窗的开/合与尺寸（复用同一套 WCV 机制）。 */
  setQuick(bounds: OverlayBounds | null): Promise<boolean>
  /** Quick only. 内容变高（例如插件缺失提示行）后更新高度，仍按窗口夹取。 */
  resizeQuick(height: number): Promise<boolean>
  /** Quick only. 关闭并把焦点还给齿轮。 */
  closeQuick(restoreFocus?: boolean): Promise<boolean>
  /** Toast only. Native notifies shell to clear its message. */
  dismissToast(): Promise<boolean>
  /** Panel only. Relay a command failure to the shell, which owns toast text. */
  reportFailure(text: string): Promise<boolean>
  /** 叠加层报告内容已渲染（度量用）。 */
  reportReady(): Promise<boolean>
  /** Shell only. 悬停预热（auto 策略下由外壳在入口 pointerenter 时调用）。 */
  prewarm(): Promise<boolean>
  /** 读取/清空打开耗时样本（shell 侧度量用）。 */
  readMetrics(): Promise<{ samples: unknown[]; summary: Record<string, { n: number; p50: number; p95: number; p99: number }> }>
  resetMetrics(): Promise<boolean>
  subscribe(listener: (event: OverlayEvent) => void): () => void
}
