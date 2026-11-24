/**
 * 叠加层几何（纯函数，无 Electron 依赖）。
 *
 * 这里是**唯一**决定「飞窗/面板贴在哪、能长多高」的地方：主进程用它夹取，
 * 外壳用它算初始 bounds，单元层直接测。抽出来的原因很实际——2026-11-23 到 11-24
 * 连续两次因为几何改错（先是被通用夹取整体上移、后来误改成贴窗口右缘），
 * 而这两处当时都只被端到端截图覆盖。
 */

export const OVERLAY_INSET = 12
export const OVERLAY_TOP_INSET = 4
export const ENGINE_PANEL_WIDTH = 264 + 2 * OVERLAY_INSET
export const ENGINE_PANEL_INITIAL_HEIGHT = 208 + 2 * OVERLAY_INSET
export const TOAST_WIDTH = 320 + 2 * OVERLAY_INSET
export const TOAST_HEIGHT = 90 + 2 * OVERLAY_INSET

export interface OverlayBounds {
  x: number
  y: number
  width: number
  height: number
}

/** 通用夹取：整体放进窗口内容区（toast 这类自由定位的浮层用它）。 */
export function clampBounds(bounds: OverlayBounds, width: number, height: number): OverlayBounds {
  const w = Math.min(width, Math.ceil(bounds.width))
  const h = Math.min(height, Math.ceil(bounds.height))
  return {
    x: Math.max(0, Math.min(width - w, Math.round(bounds.x))),
    y: Math.max(0, Math.min(height - h, Math.round(bounds.y))),
    width: w,
    height: h
  }
}

/**
 * 锚定在工具栏下方、挂在按钮下的飞窗（引擎面板 / 齿轮快捷设置）的夹取规则：
 *
 * **保持顶边不动**，只把高度压到窗口底部以内。用 `clampBounds` 会先夹位置再夹尺寸，
 * 结果飞窗会从按钮下沿跳到窗口上沿附近（实测 y 从 62 被夹成 25）。
 * 超出部分由面板自己滚动。
 */
export function clampBelow(bounds: OverlayBounds, width: number, height: number, inset = 8): OverlayBounds {
  const w = Math.min(width, Math.ceil(bounds.width))
  const y = Math.max(0, Math.min(height, Math.round(bounds.y)))
  const h = Math.max(0, Math.min(Math.ceil(bounds.height), height - y - inset))
  return {
    x: Math.max(0, Math.min(width - w, Math.round(bounds.x))),
    y,
    width: w,
    height: h
  }
}

export interface FlyoutAnchor {
  /** 锚点按钮的右边缘（CSS 像素，相对窗口内容区）。 */
  anchorRight: number
  /** 锚点按钮的下边缘：飞窗顶边**紧贴按钮**（不是工具栏下沿，那会多出按钮与工具栏底边之间的 6px 缝）。 */
  anchorBottom: number
  /** 窗口内容区宽度（用来在窄窗口下把飞窗推回可见区）。 */
  viewportWidth: number
}

/**
 * 齿轮飞窗的初始 bounds：**右边与按钮右缘对齐、顶边落在工具栏下沿**，
 * 视图尺寸 = 面板尺寸（不给投影留白，否则会露出「光影」）。
 */
export function flyoutBounds(anchor: FlyoutAnchor, width: number, height: number): OverlayBounds {
  return {
    x: Math.max(0, Math.round(anchor.anchorRight) - width),
    y: Math.round(anchor.anchorBottom),
    width,
    height
  }
}

/**
 * 引擎面板的初始 bounds：同一条锚定规则，额外让出 `OVERLAY_INSET`
 * （面板比飞窗窄，视觉上要离开按钮右缘一点）。
 */
export function panelBounds(anchor: FlyoutAnchor, height: number): OverlayBounds {
  return {
    x: Math.max(0, Math.round(anchor.anchorRight) - ENGINE_PANEL_WIDTH + OVERLAY_INSET),
    y: Math.round(anchor.anchorBottom),
    width: ENGINE_PANEL_WIDTH,
    height
  }
}
