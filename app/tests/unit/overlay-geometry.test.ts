import { describe, expect, it } from 'vitest'
import {
  ENGINE_PANEL_CARD_WIDTH,
  OVERLAY_GUTTER,
  OVERLAY_INSET,
  cardRect,
  clampBelow,
  insideCard,
  clampBounds,
  flyoutBounds,
  panelBounds
} from '../../src/shared/overlay-geometry'

/**
 * 叠加层几何：这两轮真实踩过的坑都在这里——
 * ① 通用夹取会把「挂在按钮下」的飞窗整体上移；
 * ② 视图比面板大留出投影空间时，投影落在留白上变成一条「光影」。
 * 所以几何必须是纯函数 + 有回归网，而不是只在截图里看一眼。
 */

describe('clampBounds（自由浮层）', () => {
  it('完全在窗口内时原样返回', () => {
    expect(clampBounds({ x: 10, y: 20, width: 200, height: 100 }, 800, 600))
      .toEqual({ x: 10, y: 20, width: 200, height: 100 })
  })

  it('越界时整体推回窗口内', () => {
    expect(clampBounds({ x: 700, y: 550, width: 200, height: 100 }, 800, 600))
      .toEqual({ x: 600, y: 500, width: 200, height: 100 })
  })

  it('负坐标收到 0', () => {
    expect(clampBounds({ x: -30, y: -10, width: 200, height: 100 }, 800, 600))
      .toEqual({ x: 0, y: 0, width: 200, height: 100 })
  })

  it('比窗口还大时尺寸收到窗口尺寸', () => {
    expect(clampBounds({ x: 0, y: 0, width: 1200, height: 900 }, 800, 600))
      .toEqual({ x: 0, y: 0, width: 800, height: 600 })
  })

  it('取整（设备像素下不能出现半像素）', () => {
    const result = clampBounds({ x: 10.6, y: 20.4, width: 200.2, height: 100.7 }, 800, 600)
    expect(Number.isInteger(result.x)).toBe(true)
    expect(Number.isInteger(result.y)).toBe(true)
    expect(Number.isInteger(result.width)).toBe(true)
    expect(Number.isInteger(result.height)).toBe(true)
  })
})

describe('clampBelow（挂在按钮下的飞窗）', () => {
  const bounds = { x: 700, y: 84, width: 320, height: 320 }

  it('空间够时不动', () => {
    expect(clampBelow(bounds, 1100, 760)).toEqual(bounds)
  })

  it('顶边保持不动，只压高度（不能整体上移）', () => {
    // 窗口只有 360 高、飞窗从 84 开始：可用高度 = 360 - 84 - 默认 inset（投影留白 12）
    const result = clampBelow(bounds, 520, 360)
    expect(result.y).toBe(84)
    expect(result.height).toBe(360 - 84 - OVERLAY_GUTTER)
  })

  it('剩余空间不足时按剩余高度算', () => {
    const result = clampBelow({ x: 0, y: 340, width: 320, height: 320 }, 520, 360)
    expect(result.y).toBe(340)
    expect(result.height).toBe(360 - 340 - OVERLAY_GUTTER)
  })

  it('可用高度为负时高度归零（而不是变成负数或把顶边推上去）', () => {
    const result = clampBelow({ x: 0, y: 355, width: 320, height: 320 }, 520, 360)
    expect(result.y).toBe(355)
    expect(result.height).toBe(0)
  })

  it('y 超出窗口底部时收到窗口底部（此时高度为 0）', () => {
    const result = clampBelow({ x: 0, y: 900, width: 320, height: 320 }, 520, 360)
    expect(result.y).toBe(360)
    expect(result.height).toBe(0)
  })

  it('水平方向仍然夹取（窄窗口时推回可见区）', () => {
    const result = clampBelow({ x: 500, y: 84, width: 320, height: 200 }, 520, 760)
    expect(result.x).toBe(200)
  })

  it('inset 可调（默认留一圈投影边距给窗口底边）', () => {
    const tall = { ...bounds, height: 600 }
    expect(clampBelow(tall, 1100, 500, 0).height).toBe(500 - 84)
    expect(clampBelow(tall, 1100, 500, 16).height).toBe(500 - 84 - 16)
  })
})

describe('flyoutBounds（齿轮飞窗初始位置）', () => {
  const anchor = { anchorRight: 1092, anchorBottom: 78, viewportWidth: 1100 }

  it('卡片右缘与按钮右缘对齐、卡片顶边落在按钮下沿', () => {
    const bounds = flyoutBounds(anchor, 320, 320)
    expect(bounds.x + bounds.width - OVERLAY_GUTTER).toBe(anchor.anchorRight)
    expect(bounds.y).toBe(anchor.anchorBottom)
  })

  it('视图 = 卡片 + 一圈投影边距（左右与底部，顶边不留）', () => {
    const bounds = flyoutBounds(anchor, 320, 320)
    expect(bounds.width).toBe(320 + 2 * OVERLAY_GUTTER)
    expect(bounds.height).toBe(320 + OVERLAY_GUTTER)
  })

  it('窗口太窄时贴左边缘（不能变成负的 x）', () => {
    const bounds = flyoutBounds({ anchorRight: 200, anchorBottom: 78, viewportWidth: 320 }, 320, 320)
    expect(bounds.x).toBe(0)
  })
})

describe('panelBounds（引擎面板初始位置）', () => {
  const anchor = { anchorRight: 1092, anchorBottom: 78, viewportWidth: 1100 }

  it('与飞窗同一条锚定规则，只是卡片更窄', () => {
    const bounds = panelBounds(anchor, 208)
    expect(bounds.x + bounds.width - OVERLAY_GUTTER).toBe(anchor.anchorRight)
    expect(bounds.y).toBe(anchor.anchorBottom)
    expect(bounds.width).toBe(ENGINE_PANEL_CARD_WIDTH + 2 * OVERLAY_GUTTER)
  })

  it('窄窗口下同样不越出左边缘', () => {
    expect(panelBounds({ anchorRight: 100, anchorBottom: 78, viewportWidth: 320 }, 232).x).toBe(0)
  })
})

describe('cardRect / insideCard（透明投影边距的命中判定）', () => {
  const view = flyoutBounds({ anchorRight: 1092, anchorBottom: 78, viewportWidth: 1100 }, 320, 320)

  it('卡片 = 视图去掉左/右/下边距（顶边不留）', () => {
    expect(cardRect(view)).toEqual({
      x: view.x + OVERLAY_GUTTER,
      y: view.y,
      width: 320,
      height: 320
    })
  })

  it('卡片里算卡片，边距里算外部（外部要转发给页面，不能吞掉点击）', () => {
    expect(insideCard(view, OVERLAY_GUTTER, 0)).toBe(true)
    expect(insideCard(view, OVERLAY_GUTTER + 10, 10)).toBe(true)
    expect(insideCard(view, OVERLAY_GUTTER - 1, 10)).toBe(false)
    expect(insideCard(view, view.width - OVERLAY_GUTTER - 1, 10)).toBe(true)
    expect(insideCard(view, view.width - OVERLAY_GUTTER, 10)).toBe(false)
    expect(insideCard(view, 100, view.height - OVERLAY_GUTTER)).toBe(false)
    expect(insideCard(view, 100, view.height - OVERLAY_GUTTER - 1)).toBe(true)
  })
})