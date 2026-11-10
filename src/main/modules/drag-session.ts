/**
 * P7 拖拽会话：tear-off 出来的窗口跟随指针。
 *
 * 为什么由主进程轮询光标、而不是靠渲染层的 `pointermove`：
 * - 指针一旦进入新窗口或 BrowserView，事件就被它们接走，源窗口收不到；
 * - `screen.getCursorScreenPoint()` 与"谁在前台/谁在指针下"无关，是唯一可靠的真相源；
 * - 16ms 轮询只是一次系统调用 + 一次 `setBounds`，比 IPC 往返便宜。
 *
 * 三条抗抖约束（"窗口颤抖着变大"的根因都在这三条上）：
 * 1. **尺寸在会话开始时钉死**：每帧只读 `getBounds()` 来取宽度会让 DIP↔物理像素的
 *    往返取整误差逐帧累积（150% 缩放下尤其明显），窗口会一边抖一边越来越宽；
 * 2. **位置只在整数 DIP 上取值**：窗口矩形是整数 DIP，传小数会被截断；截断方向
 *    与物理像素取整方向不一致时，150% 缩放下会看到持续抖动；
 * 3. **指针没动 / 位置没变就不下发**：静止时零调用，避免无意义的重排与动画。
 */
import { screen } from 'electron';
import type { BrowserWindow } from 'electron';
import log from 'electron-log';
import { getWindowById } from './window';

const FOLLOW_INTERVAL_MS = 16;

/**
 * 指针落在**新窗口内部**的位置（即窗口原点 = 指针 - 本偏移）。
 *
 * 对齐 Chrome：抓下来那一刻，光标是压在新窗口的标签上的，而不是悬在窗口外面。
 * 取值落在标签栏里（栏高 45、标签高 36）：x=160 约等于首个标签的水平中线，
 * y=40 是标签栏靠下沿——和 Chrome 把标签"捏在手里"的位置一致。
 *
 * 落点判定不受影响：`resolveBandTarget` 按**屏幕坐标**命中别人的标签栏带，并且
 * 显式排除跟随窗口自己，所以"指针在自己窗口里"不等于"落点无效"。
 */
export const FOLLOW_POINTER_ANCHOR = { x: 160, y: 40 };

/** tear-off 窗口的固定尺寸：建窗、建初值、每帧跟随都用这一份，不许各算各的。 */
export const FOLLOW_SIZE = { width: 1100, height: 760 };

/**
 * 跟随期间至少留在屏幕内的宽度/高度。
 *
 * 拖拽时必须允许窗口压住任务栏、甚至探出屏幕边缘（Chrome 就是这样，只有落定后
 * 才受窗口管理器约束）；但完全移出屏幕会让用户找不回来，所以每条轴上都留这么多。
 */
const MIN_VISIBLE_DIP = 120;

/**
 * 指针位置 → 窗口左上角（已钳制到允许范围）。
 *
 * 跟随帧与 tear-off 建窗共用这一份计算：两处算法一旦不同，窗口就会先闪一下再跳。
 */
function followPosition(point: { x: number; y: number }, size: { width: number; height: number }): { x: number; y: number } {
  const display = screen.getDisplayNearestPoint(point);
  // 用整块屏幕（`bounds`）而不是工作区（`workArea`）：拖拽期间要能压住任务栏、
  // 也能探到屏幕外侧。之前用 workArea 且要求"整窗在内"，表现就是"最多顶到任务栏上沿"。
  const area = display.bounds;
  const x = snapToDevicePixels(
    clamp(point.x - FOLLOW_POINTER_ANCHOR.x, area.x - size.width + MIN_VISIBLE_DIP, area.x + area.width - MIN_VISIBLE_DIP),
    display.scaleFactor,
  );
  // 上边界是例外：标签栏必须留在屏幕内。指针恒压在标签栏里，一旦标签栏整条跑到屏幕
  // 上方，用户就再也抓不回这个窗口了（8 DIP 的余量刚好留出可点的那条边）。
  const y = snapToDevicePixels(
    clamp(point.y - FOLLOW_POINTER_ANCHOR.y, area.y - 8, area.y + area.height - MIN_VISIBLE_DIP),
    display.scaleFactor,
  );
  return { x, y };
}

/**
 * tear-off 建窗时的初始矩形。必须与第一帧跟随算出来的完全一致，
 * 否则窗口会先在错误位置闪一下再跳到指针下——`show` 与跟随启动之间隔着一次
 * renderer 握手，那段时间足够用户看见。
 */
export function followBoundsAt(point: { x: number; y: number }): { x: number; y: number; width: number; height: number } {
  return { ...followPosition(point, FOLLOW_SIZE), ...FOLLOW_SIZE };
}

interface FollowState {
  windowId: number;
  ownerWindowId: number;
  tabId: string;
  timer: NodeJS.Timeout;
  /** 会话内恒定，绝不在跟随过程中重新读取。 */
  width: number;
  height: number;
  lastPoint: { x: number; y: number } | null;
  lastPosition: { x: number; y: number } | null;
}

let follow: FollowState | null = null;

/** 把 DIP 坐标对齐到物理像素：避免 150% 缩放下每帧取整到相反方向造成抖动。 */
function snapToDevicePixels(value: number, scale: number): number {
  // 只用整数 DIP：Electron 11 的窗口矩形就是整数 DIP，传小数会被截断，
  // 截断方向与物理像素取整方向不一致时反而更抖。刻度为整数倍数时按物理网格
  // 对齐仍然成立（1x/2x），非整数刻度退回四舍五入。
  if (!Number.isInteger(scale)) return Math.round(value);
  return Math.round(Math.round(value * scale) / scale);
}

function clamp(value: number, min: number, max: number): number {
  // 窗口比工作区还宽时 max < min：此时贴左/上边，不能返回越界值。
  return Math.max(min, Math.min(value, Math.max(min, max)));
}

/**
 * 跟随窗口必须压住源窗口。
 *
 * `show()` 确实能把新窗口带到前台，但紧随其后源窗口会做两件事：切到相邻标签，
 * 以及 `tab:focusActive` → `webContents.focus()`。后者在 Windows 上会让宿主窗口
 * 重新激活并把整个窗口抬回最前——跟随窗口就被压到底下（最大化源窗口时完全看不见）。
 * 拖拽期间钉一个 topmost 是唯一确定的做法：它与 z-order 的其它参与者无关。
 */
export function raiseForFollow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  try { win.setAlwaysOnTop(true); } catch { /* window gone */ }
  try { win.moveTop(); } catch { /* 同上 */ }
}

/** 结束跟随：卸掉置顶。窗口可能马上就要关闭，一律吞异常。 */
function lowerAfterFollow(windowId: number): void {
  const win = getWindowById(windowId);
  if (!win) return;
  try { win.setAlwaysOnTop(false); } catch { /* 正在关闭 */ }
}

/**
 * 拖拽落定、窗口就地定格：卸置顶后重新抬到最前。
 * 只卸不抬的话，源窗口那一次 `focusActive()` 仍可能排在后面把它盖住。
 */
export function settleDragWindow(windowId: number): void {
  const win = getWindowById(windowId);
  if (!win) return;
  try { win.setAlwaysOnTop(false); } catch { /* window gone */ }
  try { win.moveTop(); } catch { /* 同上 */ }
  try { win.focus(); } catch { /* 同上 */ }
}

/** 把窗口钉到指针下方（同一套 DIP 坐标，`getBounds`/`getCursorScreenPoint` 一致）。 */
function placeAtPointer(win: BrowserWindow, state: FollowState): void {
  if (win.isDestroyed()) return;
  const point = screen.getCursorScreenPoint();
  // 指针没动：窗口位置不会变，别下发（静止时这是绝大多数帧）。
  if (state.lastPoint && state.lastPoint.x === point.x && state.lastPoint.y === point.y) return;
  state.lastPoint = point;

  const { x, y } = followPosition(point, state);
  if (state.lastPosition && state.lastPosition.x === x && state.lastPosition.y === y) return;
  state.lastPosition = { x, y };

  // 显式带尺寸：只改位置时 Electron 会读回当前 bounds 再写，那个读回值正是漂移源。
  win.setBounds({ x, y, width: state.width, height: state.height }, false);
}

/**
 * 开始跟随。`tabId` 只是为日志与后续落点判定留痕（真正的迁移在 tear-off 里已完成）。
 */
export function startDragFollow(win: BrowserWindow, ownerWindowId: number, tabId: string): void {
  stopDragFollow();
  if (win.isDestroyed()) return;
  raiseForFollow(win);
  const bounds = win.getBounds();
  const state: FollowState = {
    windowId: win.id,
    ownerWindowId,
    tabId,
    width: bounds.width,
    height: bounds.height,
    lastPoint: null,
    lastPosition: null,
    timer: setInterval(() => {
      if (win.isDestroyed()) {
        stopDragFollow();
        return;
      }
      // 窗口还没 show（`ready-to-show` 尚未触发）时不要动它：Windows 会对新显示的
      // 窗口做 DWM 缩放动画，动画期间反复 setBounds 会让"由小到大"的过程看起来在抖。
      if (!win.isVisible()) return;
      placeAtPointer(win, state);
    }, FOLLOW_INTERVAL_MS),
  };
  state.timer.unref?.();
  follow = state;
  placeAtPointer(win, state);
  log.info(`[Tabs] drag-follow start tab=${tabId} win=${win.id} owner=${ownerWindowId} size=${state.width}x${state.height}`);
}

/** 结束跟随并交回"这次拖拽是谁"的信息（落点判定需要 owner / followWin）。 */
export function stopDragFollow(): { windowId: number; ownerWindowId: number; tabId: string } | null {
  if (!follow) return null;
  clearInterval(follow.timer);
  const state = { windowId: follow.windowId, ownerWindowId: follow.ownerWindowId, tabId: follow.tabId };
  follow = null;
  lowerAfterFollow(state.windowId);
  log.info(`[Tabs] drag-follow stop tab=${state.tabId} win=${state.windowId}`);
  return state;
}

export function getDragFollowWindowId(): number | null {
  return follow?.windowId ?? null;
}
