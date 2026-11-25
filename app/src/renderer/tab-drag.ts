/**
 * 标签拖动落点的纯计算（渲染层）。
 *
 * 这里有两个**不同的坐标**，混用就是「横向拖拽落点偏一位」的成因：
 * - **插槽（slot）**：指针落在当前标签栏的哪个缝隙，按"被拖项还占着一格"的布局数出来，
 *   取值 `0..n`；
 * - **最终索引（final index）**：`move` IPC 的语义——把被拖项从列表里**移除之后**再插入
 *   的位置，取值 `0..n-1`。
 *
 * 向左拖时两者相同（被拖项在落点右边，移除它不影响落点之前的序号）；向右拖时插槽恒比
 * 最终索引大 1（被拖项自己那一格被数了进去）。所以插槽必须先换算再发 IPC。
 */

export interface TabBox {
  left: number
  width: number
}

/** 指针横坐标落在哪个插槽：越过某个标签的中线就算插到它后面。 */
export function dropSlotIndex(boxes: readonly TabBox[], clientX: number): number {
  let slot = 0
  for (const [position, box] of boxes.entries()) {
    if (clientX >= box.left + box.width / 2) slot = position + 1
  }
  return slot
}

/**
 * 插槽（含被拖项）→ `move` 的最终索引（移除被拖项后）。
 *
 * `fromIndex` 是被拖项在**当前**标签列表里的位置；取不到（`< 0`，例如拖动途中标签已被
 * 关闭）时按 0 处理，让主进程的 `unknown-tab` 校验去兜底，而不是在这里猜一个更远的位置。
 */
export function finalDropIndex(slot: number, fromIndex: number): number {
  const from = fromIndex < 0 ? 0 : Math.trunc(fromIndex)
  if (!Number.isFinite(slot)) return from
  const clamped = Math.max(0, Math.trunc(slot))
  return clamped > from ? clamped - 1 : clamped
}
