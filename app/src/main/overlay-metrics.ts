/**
 * 叠加层打开耗时埋点（临时，用于决定「悬停预热」是否值得）。
 *
 * 只记录**主进程侧**能确定的时刻，避免跨进程 `performance.now()` 相减：
 * - `ipc`：主进程收到打开命令 → 开始处理（通常 <1 ms，用来确认命令没排队）；
 * - `visible`：bounds 应用 + `setVisible(true)` 完成（Chromium 从下一帧开始合成，是**代理指标**）；
 * - `content`：渲染层报告「本次内容已渲染」（收到 IPC 的时间，含一次往返）。
 *
 * `state` 记录点击飞窗那一刻叠加层视图处于哪种状态：
 * - `cold`：还没有视图（要建渲染进程）；
 * - `warming`：视图在创建中（预热未完成）；
 * - `warm`：视图已就绪（只差 setBounds + 显示）。
 */
export interface OverlayOpenSample {
  kind: 'panel' | 'quick' | 'toast'
  state: 'cold' | 'warming' | 'warm'
  input: 'pointer' | 'keyboard' | 'unknown'
  ipc: number
  visible: number
  content?: number
  at: number
}

const MAX_SAMPLES = 500
const samples: OverlayOpenSample[] = []
const pending = new Map<number, { sample: OverlayOpenSample; t0: number }>()
let sequence = 0

export function beginOpen(kind: OverlayOpenSample['kind'], state: OverlayOpenSample['state']): number {
  sequence += 1
  const sample: OverlayOpenSample = { kind, state, input: 'unknown', ipc: 0, visible: 0, at: Date.now() }
  pending.set(sequence, { sample, t0: Date.now() })
  return sequence
}

export function markVisible(id: number): void {
  const entry = pending.get(id)
  if (!entry) return
  entry.sample.visible = Date.now() - entry.t0
}

export function markContent(id: number): void {
  const entry = pending.get(id)
  if (!entry) return
  entry.sample.content = Date.now() - entry.t0
  entry.sample.ipc = 0
  samples.push(entry.sample)
  if (samples.length > MAX_SAMPLES) samples.shift()
  pending.delete(id)
}

export function markInput(id: number, input: OverlayOpenSample['input']): void {
  const entry = pending.get(id)
  if (entry) entry.sample.input = input
}

export function readSamples(): OverlayOpenSample[] {
  return [...samples]
}

export function resetSamples(): void {
  samples.length = 0
  pending.clear()
}

/** 汇总：按 state 分组给出 P50/P95/P99（毫秒，整型）。 */
export function summarize(list: OverlayOpenSample[] = samples): Record<string, { n: number; p50: number; p95: number; p99: number }> {
  const pick = (values: number[], ratio: number): number => {
    if (values.length === 0) return 0
    const sorted = [...values].sort((a, b) => a - b)
    return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))])
  }
  const groups: Record<string, number[]> = {}
  for (const sample of list) {
    const key = `${sample.kind}/${sample.state}`
    ;(groups[key] ??= []).push(sample.visible)
  }
  const result: Record<string, { n: number; p50: number; p95: number; p99: number }> = {}
  for (const [key, values] of Object.entries(groups)) {
    result[key] = { n: values.length, p50: pick(values, 0.5), p95: pick(values, 0.95), p99: pick(values, 0.99) }
  }
  return result
}
