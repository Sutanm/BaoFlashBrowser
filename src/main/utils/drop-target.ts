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
  | { kind: 'new-window' };

/** 最终意图：挪进别的窗口 / 拖出成新窗口 / 取消（拖回本窗口壳层）。 */
export type DropIntent =
  | { kind: 'move-to-window'; id: number }
  | { kind: 'tear-off' }
  | { kind: 'cancel' };

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
  // 不在任何窗口矩形内：一律按"窗口外"处理。
  //
  // 这里**不能**把负坐标判成无效：多显示器时主屏左侧/上方的副屏坐标天然是负的，
  // 曾经的 `x >= 0 && y >= 0` 守卫会让"把标签拖到左侧副屏"永远失败。拖到屏幕画面外
  // 同样算 tear-off（`win:tear-off-tab` 用 Math.max(0, ...) 钳制落点）。
  return { kind: 'new-window' };
}

/**
 * 把"落点窗口"翻译成"拖拽意图"。
 *
 * 关键点：`overOwnContent` 由渲染层判定——渲染层只在落点既不是标签卡也不是顶栏
 * 壳层时才走到这里，所以"落在本窗口内容区"就等于"用户想把标签拖出来"。最大化时
 * 窗口矩形铺满整个工作区，屏幕内不存在本窗口之外的落点，这条分支是最大化窗口
 * 唯一能拖出标签的路径。
 */
export function resolveDropIntent(
  target: DropTarget,
  ownerWindowId: number,
  overOwnContent: boolean,
): DropIntent {
  if (target.kind === 'new-window') return { kind: 'tear-off' };
  if (target.id !== ownerWindowId) return { kind: 'move-to-window', id: target.id };
  return overOwnContent ? { kind: 'tear-off' } : { kind: 'cancel' };
}

/**
 * 拖拽落地时要命中的"标签栏带"高度（窗口顶部这条）。
 *
 * 为什么跨窗/回吸只认这条带、不认整个窗口矩形：
 * - tear-off 出来的窗口跟手挂在指针下方（指针压在自己的标签栏里，对齐 Chrome），
 *   所以指针几乎永远落在**跟随窗口自己**的矩形内——必须先按 id 排除它；
 * - 源窗口只要不是极端窄小，指针落到"页面上"时坐标仍在源窗口矩形内，按矩形判定会
 *   把"拖出来"全部误判成"回吸"。
 * 按标签栏带判定才有"拖到别人的标签栏才算移过去"的语义，与 Chrome 一致。
 */
export const TABBAR_BAND_HEIGHT = 48;

/**
 * 命中指针下方的标签栏带。`excludeIds` 用于排除跟随中的拖拽窗口自己——
 * 指针就压在它的标签栏里，不排除会永远命中自己。
 * 传入的窗口顺序决定优先级（调用方按 z-order 近似排序）。
 */
export function resolveBandTarget(
  point: { x: number; y: number },
  windows: DropWindowRect[],
  excludeIds: number[] = [],
  bandHeight: number = TABBAR_BAND_HEIGHT,
): DropWindowRect | null {
  const excluded = new Set(excludeIds);
  for (const win of windows) {
    if (excluded.has(win.id)) continue;
    const band = { ...win.bounds, height: Math.min(bandHeight, win.bounds.height) };
    if (hits(band, point)) return win;
  }
  return null;
}

/**
 * 原生窗口拖动结束时的"合并落点"（单标签窗口专用）。
 *
 * 单标签窗口在 Chrome 里没有"拖标签"这回事——按住标签拖的是整个窗口。要让这样的
 * 窗口还能并回别的窗口，就得在**整窗拖动结束时**补一次落点判定：
 *
 * - 必须捏着本窗口的标签栏（指针在自己的标签栏带内）。窗口缩放（也是 WM_EXITSIZEMOVE）
 *   或从地址栏/工具栏拖动时指针不在那条带里，不参与判定，避免"挪一下窗口就被吞并"；
 * - 再要求指针落在别的窗口的标签栏带内，也就是**两条标签栏重叠**，与 Chrome 一致——
 *   单纯把窗口并排摆放不会触发。
 */
export function resolveWindowMergeTarget(
  point: { x: number; y: number },
  own: DropWindowRect,
  others: DropWindowRect[],
  bandHeight: number = TABBAR_BAND_HEIGHT,
): DropWindowRect | null {
  const ownBand = { ...own.bounds, height: Math.min(bandHeight, own.bounds.height) };
  if (!hits(ownBand, point)) return null;
  return resolveBandTarget(point, others, [own.id], bandHeight);
}

