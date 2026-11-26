/**
 * 「这个标签的页面上有没有 Flash 内容」的判定（ADR-0004 §2 硬门禁）。
 *
 * 为什么必须是纯模块：它是**唯一**的 Flash 内容判据，休眠扫描用它，A1 的 Capability
 * 校验层（`capability-contract.ts` 的 `flash-content`）也必须用同一份。判据出现第二份实现，
 * 就等于「有人能绕过休眠门禁」。以前它长在 `browser-window.ts` 的闭包里，只能靠真 Electron
 * 的 smoke 验证；抽出来以后，跨帧、fail-closed、阴性不缓存这三条都能用毫秒级用例钉住。
 *
 * 为什么不用引擎判定（历史教训）：本产品默认引擎就是 `ppapi`（插件可用时每个标签都是它），
 * 所以「引擎是 ppapi」≠「装着 Flash」。实测拿它当判据会把**所有**标签都保护起来，休眠直接
 * 失效（trace 全是 `flash-content`，普通页也不睡）。
 *
 * 三个必须记住的坑（2026-11-26 审计复现）：
 * 1. **不能缓存阴性结果**：页面可以在首次探测之后才插入播放器（懒加载、SPA 换页、iframe 里的
 *    客户端 SWF），按 URL 缓存阴性会让它照样被睡。所以只在**决策那一刻**探，且只有阳性结果
 *    被粘住（键含绑定代际，视图一换就自动失效）。
 * 2. **必须遍历所有帧**：`document.querySelector` 看不到 iframe 里的播放器，而本产品的站点
 *    客户端 SWF 经常挂在跨源 iframe 里。
 * 3. 判不出（帧已 detach / 执行失败 / 取不到主帧）一律按「有」处理（fail-closed）。
 */

/** 命中判据：任何引擎形态都覆盖——ppapi 留 `<embed>/<object>`，Ruffle 换成 `<ruffle-*>`。 */
export const FLASH_PROBE =
  'Boolean(document.querySelector("embed,object,ruffle-player,ruffle-embed,[type*=shockwave],[type*=flash]"))'

/** 探测需要的帧能力。`WebFrameMain` 结构上满足它，单测用假帧即可。 */
export interface FlashProbeFrame {
  detached: boolean
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
}

/**
 * - `hit`：某一帧找到了 Flash → 阳性，可缓存；
 * - `clear`：所有帧都回答了「没有」→ **不可缓存**（见文件头坑 1）；
 * - `unknown`：判不出（帧在执行时消失）→ 按「有」处理，也不缓存。
 */
export type FlashProbeOutcome = 'hit' | 'clear' | 'unknown'

/**
 * 阳性缓存。键是 `tabId`，值是**绑定代际**：视图重建、休眠唤醒、引擎切换后
 * `binding` 会变，旧阳性自然失效，不需要谁记得清缓存。
 */
export class FlashPresenceCache {
  private readonly seen = new Map<number, number>()

  isKnown(tabId: number, binding: number): boolean {
    return this.seen.get(tabId) === binding
  }

  mark(tabId: number, binding: number): void {
    this.seen.set(tabId, binding)
  }

  /** 标签关闭或休眠时清掉——休眠后视图重建，代际本来就会变，这里只是不留下垃圾。 */
  forget(tabId: number): void {
    this.seen.delete(tabId)
  }

  get size(): number {
    return this.seen.size
  }

  clear(): void {
    this.seen.clear()
  }
}

/** 逐帧探测。任一帧报错立即收手（此时已经「判不出」，继续跑没有意义）。 */
export async function probeFlashContent(frames: Iterable<FlashProbeFrame>): Promise<FlashProbeOutcome> {
  for (const frame of frames) {
    // 已 detach 的帧执行必然抛错，先跳过：那是"这一帧没了"，不是"判不出"。
    if (frame.detached) continue
    let hit: unknown
    try {
      hit = await frame.executeJavaScript(FLASH_PROBE, true)
    } catch {
      // 帧正在销毁/导航：判不出就当「有」（fail-closed），下一轮重探。
      return 'unknown'
    }
    if (hit === true) return 'hit'
  }
  return 'clear'
}

export interface FlashProbeRequest {
  tabId: number
  /** 当前绑定代际（`Tab.binding`）。 */
  binding: number
  cache: FlashPresenceCache
  /**
   * 取该标签的帧列表。**在调用方**处理「主帧取不到」：直接返回 `undefined`（或抛错），
   * 这里按「有 Flash」处理。之所以不传 `WebContents`，是为了让纯层不知道 Electron 存在。
   */
  frames: () => Iterable<FlashProbeFrame> | undefined
}

/**
 * 判定并维护缓存。返回值语义：`true` = 不得销毁该标签的 WebContents（ADR-0004）。
 *
 * 注意阳性是**粘住**的：同一个绑定代际下重复调用不再执行脚本。这在 30 秒一轮的扫描里是必要的
 * （否则每轮都要对所有后台标签跑一次 executeJavaScript），而阴性每轮都重探。
 */
export async function detectFlashContent(request: FlashProbeRequest): Promise<boolean> {
  if (request.cache.isKnown(request.tabId, request.binding)) return true

  let frames: Iterable<FlashProbeFrame> | undefined
  try {
    frames = request.frames()
  } catch {
    return true
  }
  if (!frames) return true

  const outcome = await probeFlashContent(frames)
  if (outcome === 'hit') request.cache.mark(request.tabId, request.binding)
  return outcome !== 'clear'
}
