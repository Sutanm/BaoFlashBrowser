/**
 * 叠加层几何（纯函数，无 Electron 依赖）。
 *
 * 这里是**唯一**决定「飞窗/面板贴在哪、能长多高、卡片在视图里的哪一块」的地方：
 * 主进程用它夹取与命中判定，外壳用它算初始 bounds，单元层直接测。抽出来的原因很实际——
 * 2026-11-23 到 11-24 连续两次因为几何改错（先是被通用夹取整体上移、后来误改成贴窗口右缘），
 * 而这两处当时都只被端到端截图覆盖。
 *
 * 2026-11-26：飞窗卡片去掉 1px 描边，改成**真投影**。投影必须画在视图内部（视图外的像素会被
 * 裁掉），所以视图 = 卡片 + 一圈透明边距。透明边距落在视图命中区里会吃掉鼠标，主进程要把边距
 * 里的鼠标**转发给当前页面**（`shell-overlays.ts` 的 `forwardGutterMouse`）。
 *
 * **边距不是四边一样的**，照抄 Chromium（`ui/gfx/shadow_value.cc` 的 `GetInsets()`）：
 *   `左右 = blur/2`、`上 = blur/2 - offset.y`、`下 = blur/2 + offset.y`
 * （elevation 12 的气泡是 左/右 24、上 12、下 36；默认那档是 6/4/8）。
 * 我们的卡片投影是收紧过的两层：`0 1px 3px` 与 `0 3px 8px`，按同一公式
 *   左右需要 blur/2 = 4、底部需要 blur/2 + 偏移 = 7
 * 所以留 `OVERLAY_GUTTER_X = 6`（左右）、`OVERLAY_GUTTER_BOTTOM = 10`（底部）。
 * 顶边不留：卡片顶边要贴住锚点按钮，那圈投影落在工具栏上也看不见。
 *
 * 2026-11-26 第二轮（贴 Edge 的克制感）：早前用 `0 8px 20px` + 12/20 边距，边缘摊成一片
 * 灰雾（"丁达尔效应"）。收紧成 1–3px 偏移、3–8px 模糊后，左右只剩一层柔和边、底部略重。
 */

export const OVERLAY_INSET = 12
export const OVERLAY_TOP_INSET = 4
/** 卡片左右两侧的透明留白（画收紧后的投影用）。 */
export const OVERLAY_GUTTER_X = 6
/** 卡片底部的透明留白：比左右大，因为投影整体向下偏移。 */
export const OVERLAY_GUTTER_BOTTOM = 10
/** 引擎面板的**卡片**宽度（视图宽度 = 卡片 + 两侧 gutter）。 */
export const ENGINE_PANEL_CARD_WIDTH = 264
export const ENGINE_PANEL_INITIAL_HEIGHT = 208
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
export function clampBelow(
  bounds: OverlayBounds,
  width: number,
  height: number,
  inset = OVERLAY_GUTTER_BOTTOM
): OverlayBounds {
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
  /**
   * 锚点按钮的左边缘：只在**右边放不下**时用到（收藏夹横条上的文件夹按钮普遍靠左，
   * 右对齐会把 320 宽的飞窗推到窗口左缘，看起来跟按钮没关系）。
   */
  anchorLeft?: number
}

/**
 * 飞窗的初始 bounds（**视图**边界，不是卡片）：
 * 卡片右缘与按钮右缘对齐、卡片顶边贴住按钮下沿；视图在左右各外扩 `OVERLAY_GUTTER_X`、
 * 底部外扩 `OVERLAY_GUTTER_BOTTOM`（投影向下偏移，底部要更多空间）。
 *
 * 右边放不下时（`anchorRight - 卡片宽 - 边距 < 0`）改成**左对齐**：卡片左缘贴住按钮左缘。
 * 否则会被夹到 0，飞窗凭空跑到窗口最左边——横条上的文件夹按钮就是这种位置（Chromium 的
 * `MenuAnchorPosition` 同样会在右边放不下时换到另一侧）。
 */
export function flyoutBounds(anchor: FlyoutAnchor, cardWidth: number, cardHeight: number): OverlayBounds {
  const rightAligned = Math.round(anchor.anchorRight) - cardWidth - OVERLAY_GUTTER_X
  const x = rightAligned < 0 && anchor.anchorLeft !== undefined
    ? Math.max(0, Math.round(anchor.anchorLeft) - OVERLAY_GUTTER_X)
    : Math.max(0, rightAligned)
  return {
    x,
    y: Math.round(anchor.anchorBottom),
    width: cardWidth + 2 * OVERLAY_GUTTER_X,
    height: cardHeight + OVERLAY_GUTTER_BOTTOM
  }
}

/** 引擎面板：同一条锚定规则（它只是卡片更窄）。 */
export function panelBounds(anchor: FlyoutAnchor, cardHeight: number): OverlayBounds {
  return flyoutBounds(anchor, ENGINE_PANEL_CARD_WIDTH, cardHeight)
}

/**
 * 视图里属于**卡片**的那块（其余是透明投影边距）。
 *
 * 主进程用它做命中判定：落在卡片外的鼠标事件要转发给页面，不能凭空吞掉
 * （Electron 的 `View.setBorderRadius` 不会改变命中区，见 2026-11-26 的调研）。
 */
export function cardRect(bounds: OverlayBounds): OverlayBounds {
  return {
    x: bounds.x + OVERLAY_GUTTER_X,
    y: bounds.y,
    width: Math.max(0, bounds.width - 2 * OVERLAY_GUTTER_X),
    height: Math.max(0, bounds.height - OVERLAY_GUTTER_BOTTOM)
  }
}

/** 某个视图坐标是否落在卡片里（`x/y` 相对视图左上角）。 */
export function insideCard(bounds: OverlayBounds, x: number, y: number): boolean {
  return x >= OVERLAY_GUTTER_X && x < bounds.width - OVERLAY_GUTTER_X &&
    y >= 0 && y < bounds.height - OVERLAY_GUTTER_BOTTOM
}
