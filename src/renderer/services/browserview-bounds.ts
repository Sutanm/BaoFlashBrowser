export interface BrowserViewAreaRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Keep the page viewport width stable while a left sidebar is visible.
 * The BrowserView starts after the sidebar and extends beyond the right edge,
 * where the native window clips it without triggering responsive reflow.
 */
export function computeBrowserViewBounds(
  area: BrowserViewAreaRect,
  sidebarWidth: number,
): BrowserViewBounds {
  return {
    x: Math.round(area.x),
    y: Math.round(area.y),
    width: Math.max(1, Math.round(area.width + Math.max(0, sidebarWidth))),
    height: Math.max(1, Math.round(area.height)),
  };
}
