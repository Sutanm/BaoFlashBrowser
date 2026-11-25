import { describe, expect, it } from 'vitest'
import { dropSlotIndex, finalDropIndex } from '../../src/renderer/tab-drag'

/**
 * 横向拖拽落点（回归：落点偏一位）。
 *
 * 三个 100px 宽的标签从 x=0 排开，中线分别是 50 / 150 / 250。
 * 标签栏（含被拖项）里的插槽是 0..3；`move` IPC 要的是移除被拖项后的 0..2。
 */
const boxes = [
  { left: 0, width: 100 },
  { left: 100, width: 100 },
  { left: 200, width: 100 }
]

describe('dropSlotIndex', () => {
  it('按各标签中线切分插槽', () => {
    expect(dropSlotIndex(boxes, 0)).toBe(0)
    expect(dropSlotIndex(boxes, 49)).toBe(0)
    expect(dropSlotIndex(boxes, 51)).toBe(1)
    expect(dropSlotIndex(boxes, 149)).toBe(1)
    expect(dropSlotIndex(boxes, 151)).toBe(2)
    expect(dropSlotIndex(boxes, 249)).toBe(2)
    expect(dropSlotIndex(boxes, 251)).toBe(3)
  })

  it('落在标签栏外或空列表时给出边界插槽', () => {
    expect(dropSlotIndex([], 500)).toBe(0)
    expect(dropSlotIndex(boxes, -20)).toBe(0)
    expect(dropSlotIndex(boxes, 10_000)).toBe(3)
  })
})

describe('finalDropIndex', () => {
  it('向右拖：插槽比最终索引大一位（被拖项自己那一格不参与）', () => {
    // [A,B,C] 拖 A：插槽 1/2/3 → 最终 0/1/2
    expect(finalDropIndex(1, 0)).toBe(0)
    expect(finalDropIndex(2, 0)).toBe(1)
    expect(finalDropIndex(3, 0)).toBe(2)
  })

  it('向左拖：插槽与最终索引相同', () => {
    // [A,B,C] 拖 C：插槽 0/1/2 → 最终 0/1/2
    expect(finalDropIndex(0, 2)).toBe(0)
    expect(finalDropIndex(1, 2)).toBe(1)
    expect(finalDropIndex(2, 2)).toBe(2)
  })

  it('相邻项中点两侧：左侧不变、右侧才越过', () => {
    // 拖中间的 B：C 中线左侧 → 最终 1（不动）；右侧 → 最终 2（与 C 交换）
    expect(finalDropIndex(dropSlotIndex(boxes, 240), 1)).toBe(1)
    expect(finalDropIndex(dropSlotIndex(boxes, 260), 1)).toBe(2)
    // 往左同理：A 中线右侧 → 最终 1（不动）；左侧 → 最终 0（与 A 交换）
    expect(finalDropIndex(dropSlotIndex(boxes, 60), 1)).toBe(1)
    expect(finalDropIndex(dropSlotIndex(boxes, 40), 1)).toBe(0)
  })

  it('自己那一格与两端都是不动点', () => {
    for (const from of [0, 1, 2]) {
      // 插槽 = from + 1 表示"刚越过自己那一格"，移除自己后就是原位。
      expect(finalDropIndex(from + 1, from)).toBe(from)
      expect(finalDropIndex(from, from)).toBe(from)
    }
  })

  it('非法/缺失位置不产生越界索引', () => {
    expect(finalDropIndex(2, -1)).toBe(1)
    expect(finalDropIndex(Number.NaN, 1)).toBe(1)
    expect(finalDropIndex(-3, 1)).toBe(0)
  })
})
