import { screen } from 'electron';
import type { BrowserWindow } from 'electron';
import log from 'electron-log';
import { getRegisteredWindows, getWindowById } from './window';
import { getTabManagerForWindow, notifyTabAdopted, transferTabBetweenWindows } from './tabs';
import { resolveWindowMergeTarget } from '../utils/drop-target';

/**
 * P7：单标签窗口"整窗拖动 → 并回别的窗口"。
 *
 * 背景：只有一个标签时，标签卡就是窗口拖动区（`-webkit-app-region: drag`，与 Chrome
 * 一致：按住标签拖的是整个窗口）。这条路径完全不经过渲染层的指针状态机，所以
 * `win:drag-drop` 永远不会触发——窗口被拖到别的窗口标签栏上松手也**塞不回去**。
 *
 * 检测手段：Windows 在用户结束一次原生移动/缩放时给窗口发 `WM_EXITSIZEMOVE`。这是
 * 唯一既能覆盖"原生拖动"、又不需要轮询鼠标按键的信号（Electron 没有全局鼠标松开事件）。
 * 其它平台没有对应消息，直接不装钩子：那里单标签窗口仍可用标签拖拽的常规路径。
 */
const WM_EXITSIZEMOVE = 0x0232;

/** 给一个窗口装上"拖完检查是否该合并"的钩子（幂等：一个窗口只装一次）。 */
export function installWindowDragMerge(win: BrowserWindow): void {
  if (process.platform !== 'win32') return;
  try {
    // 回调里不能直接动窗口：此刻仍在窗口过程（WndProc）里，关窗/迁移会重入。
    win.hookWindowMessage(WM_EXITSIZEMOVE, () => { setImmediate(() => mergeSingleTabWindow(win)); });
  } catch (error) {
    log.warn('[Tabs] window-drag hook unavailable:', error instanceof Error ? error.message : String(error));
  }
}

/**
 * 原生窗口拖动结束后，若本窗口只剩一个标签、且指针同时压在本窗口和另一个窗口的
 * 标签栏带内（= 两条标签栏重叠），就把这个标签并过去并关掉空窗口。
 */
function mergeSingleTabWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const manager = getTabManagerForWindow(win.id);
  if (!manager) return;
  // 多标签窗口拖动整体窗口只是移动窗口，不合并——Chrome 亦然（那是"拖标签"才有的语义）。
  if (manager.getTabCount() !== 1) return;
  const tabId = manager.snapshotTabs()[0]?.tabId;
  if (!tabId) return;
  if (manager.isTabBusy(tabId)) {
    log.info(`[Tabs] window-drag merge skipped (busy) tab=${tabId} win=${win.id}`);
    return;
  }

  const point = screen.getCursorScreenPoint();
  const own = { id: win.id, bounds: win.getBounds() };
  const others = getRegisteredWindows()
    .filter((item) => item.id !== win.id)
    .map((item) => ({ id: item.id, bounds: item.getBounds() }));
  const target = resolveWindowMergeTarget(point, own, others);
  // 每次"单标签窗口拖完"打一行（改这条链路时唯一的真机证据，稳定后可降级）。
  log.info(`[Tabs] window-drag end win=${win.id} tab=${tabId} at=${point.x},${point.y} merge=${target?.id ?? 'none'}`);
  if (!target) return;

  const targetWin = getWindowById(target.id);
  if (!targetWin) return;
  if (!transferTabBetweenWindows(tabId, targetWin)) {
    log.warn(`[Tabs] window-drag merge failed tab=${tabId} from=${win.id} into=${target.id}`);
    return;
  }
  log.info(`[Tabs] window-drag merge tab=${tabId} from=${win.id} into=${target.id}`);
  notifyTabAdopted(tabId, targetWin, win);
  // 标签迁走后本窗口已空：按"拖空即关"的既有规则关掉，用户看到的是刚并进去的窗口。
  if (manager.getTabCount() === 0) win.close();
  try { targetWin.moveTop(); targetWin.focus(); } catch { /* window gone */ }
}
