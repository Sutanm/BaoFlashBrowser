/**
 * P7：拖拽落点判定（纯函数）。
 *
 * 落点来自主进程 `screen.getCursorScreenPoint()`，窗口矩形来自注册表。
 * 只负责"落在哪个窗口 / 窗口外"，不碰 Electron，便于单测。
 */
export interface DropWindowRect {
  id: number;
  bounds: { x: number; y: number; width: number; height: number };
}

export type DropTarget =
  | { kind: 'window'; id: number }
  | { kind: 'new-window' }
  | { kind: 'none' };

function hits(rect: DropWindowRect['bounds'], point: { x: number; y: number }): boolean {
  return point.x >= rect.x && point.x < rect.x + rect.width
    && point.y >= rect.y && point.y < rect.y + rect.height;
}

export function resolveDropTarget(
  point: { x: number; y: number },
  windows: DropWindowRect[],
): DropTarget {
  for (const win of windows) {
    if (hits(win.bounds, point)) return { kind: 'window', id: win.id };
  }
  // 屏幕内但不在任何窗口上：拖出成新窗口。屏幕外（负坐标/超大）同样按"窗口外"处理。
  return point.x >= 0 && point.y >= 0 ? { kind: 'new-window' } : { kind: 'none' };
}
