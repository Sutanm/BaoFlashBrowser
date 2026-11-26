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
  /**
   * Shell only. 常驻档（`overlay.prewarm=always`）：主进程要求**现在**就把浮层文档建出来。
   *
   * 为什么是推送而不是让外壳自己读设置：共享模式下建文档要由外壳 `window.open` 完成，
   * 但"该不该建"取决于主进程独占的信息（设置项、自动化/后台模式、策略覆盖）。
   * 两边各读一次就会对不上——`overlay.prewarm=never` 长期被忽略就是这么来的。
   */
  | { type: 'overlay-prewarm' }
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
  /** Shell only. 叠加层文档报告「本次内容已渲染」（度量用，非产品行为）。 */
  | { type: 'report-ready' }
  /** Shell only. 是否处于共享进程模式（浮层由外壳 window.open 产生）。 */
  | { type: 'shared-mode' }
  /**
   * 叠加层专属。浮层文档里出现的长任务（`longtask` / LoAF 上报）。
   *
   * 归因只能在这里做：LoAF 的 `windowAttribution` 按**帧树**关系分档（self/descendant/
   * ancestor/same-page/other），而浮层是另一个顶层窗口，外壳侧 observer 永远拿不到它的脚本。
   * 观测必须装在浮层自己的 realm 里（2026-11-26 审计）。
   */
  | { type: 'report-longtask'; duration: number; source: string }
  /**
   * 叠加层专属。文档挂载完、订阅已注册后**拉一次**当前该显示的内容。
   *
   * 事件是推送：共享模式下浮层文档可能在「点击那一刻」才被 `window.open` 出来，`*-opened`
   * 早于订阅就丢了（实测视图亮着、内容还是默认的 panel）。推送漏了，就让它自己来拿。
   */
  | { type: 'pull-overlay' }

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
  /** Shell only. 共享进程模式探测。 */
  sharedMode(): Promise<boolean>
  /** 叠加层专用。订阅注册完成后拉取当前内容（补发漏掉的 `*-opened`）。 */
  pullOverlay(): Promise<boolean>
  /** 叠加层专用。上报一次长任务（开发期门槛 + 诊断落盘）。 */
  reportLongTask(duration: number, source: string): Promise<boolean>
  /** 读取/清空打开耗时样本（shell 侧度量用）。 */
  readMetrics(): Promise<{ samples: unknown[]; summary: Record<string, { n: number; p50: number; p95: number; p99: number }> }>
  resetMetrics(): Promise<boolean>
  subscribe(listener: (event: OverlayEvent) => void): () => void
}
