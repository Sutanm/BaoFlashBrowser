import { ipcMain, screen } from 'electron';
import type { BrowserWindow } from 'electron';
import { z } from 'zod';
import { createEventHandler, createValidatedEventHandler } from '../utils/ipc-wrapper';
import { getTabManagerForSender, getTabManagerForTabId, getTabManagerForWindow, getTabOwnerWindow, notifyTabAdopted, tabManager, transferTabBetweenWindows } from '../modules/tabs';
import { createWindow, getRegisteredWindows, getWindowById, whenRendererReady } from '../modules/window';
import { resolveBandTarget, resolveDropIntent, resolveDropTarget } from '../utils/drop-target';
import { followBoundsAt, raiseForFollow, settleDragWindow, startDragFollow, stopDragFollow } from '../modules/drag-session';
import { ruffleBundleInfo, ruffleJsContent } from '../modules/ruffle-bundle';
import log from 'electron-log';

/**
 * 标签 IPC（SDD: docs/specs/multi-window-plan.md §6.3 / §7 P2）。
 *
 * - `tab:create` / `tab:setBounds` / `tab:focusActive` 属于窗口作用域，按 sender
 *   解析实例；窗口 B 的渲染层不可能把标签建到窗口 A。
 * - 其余通道以 tabId 为准，并校验 tab 的归属窗口就是 sender 窗口。
 * - 未知 tabId 保持 no-op：崩溃恢复 / 关窗竞态下渲染层可能发出已消失的 tabId，
 *   这里抛错会打断恢复流程。
 */
function requireManagerForSender(window: BrowserWindow | null, channel: string): NonNullable<ReturnType<typeof getTabManagerForSender>> {
  if (!window) throw new Error(`IPC sender is not a registered window: ${channel}`);
  const manager = getTabManagerForSender(window.webContents);
  if (!manager) throw new Error(`no tab manager for the sender window: ${channel}`);
  return manager;
}

function requireOwnedManager(window: BrowserWindow | null, tabId: string): ReturnType<typeof getTabManagerForTabId> | null {
  const owner = getTabOwnerWindow(tabId);
  if (!owner) return null;
  if (!window || window.id !== owner.id) {
    log.warn(`[TabsIPC] cross-window tab access rejected tab=${tabId} sender=${window?.id ?? 'none'} owner=${owner.id}`);
    throw new Error('tab does not belong to this window');
  }
  return getTabManagerForTabId(tabId) ?? null;
}

/**
 * P7：把"标签已迁移"告知两端，**且只从这里告知**。
 *
 * 实现在 `modules/tabs.ts`（`notifyTabAdopted`）：单标签窗口整窗拖动合并也在用它，
 * 放到这里会让那条不经过 IPC 的路径绕一圈。
 */

export function registerTabsIPC(): void {
  ipcMain.on('password:form-detected', (event, payload: unknown) => {
    // payload.fill === false：这次信号只用于重新武装捕获（用户点了页面），
    // 不触发自动填充，避免把用户刚改的账号密码冲掉。
    const fill = (payload as { fill?: unknown } | null | undefined)?.fill !== false;
    tabManager.notifyPasswordFormDetected(event.sender.id, { fill });
  });

  // Sync handler: preload uses sendSync to get ruffle config at document-start
  ipcMain.on('get-ruffle-mode', (e) => {
    const ruffle = tabManager.getRuffleForWC(e.sender.id);
    e.returnValue = {
      enabled: ruffle?.enabled ?? false,
      source: ruffle?.source || 'bundled',
      js: (ruffle?.enabled && ruffle?.source !== 'cdn') ? ruffleJsContent() : '',
      bundle: (ruffle?.enabled && ruffle?.source !== 'cdn') ? ruffleBundleInfo() : null,
    };
  });

  const ruffleDiagnostic = z.object({
    phase: z.enum([
      'config', 'bundled-eval-ok', 'bundled-eval-error', 'cdn-loading', 'cdn-loaded', 'cdn-error',
      'runtime-ready', 'runtime-error', 'component-error',
    ]),
    detail: z.string().max(2000).optional(),
  }).strict();
  ipcMain.on('ruffle:diagnostic', (event, raw: unknown) => {
    const parsed = ruffleDiagnostic.safeParse(raw);
    const mode = tabManager.getRuffleForWC(event.sender.id);
    if (!parsed.success || !mode?.enabled) return;
    const suffix = parsed.data.detail ? ` — ${parsed.data.detail}` : '';
    log.info(`[Ruffle] wc=${event.sender.id} source=${mode.source || 'bundled'} phase=${parsed.data.phase}${suffix}`);
    event.sender.hostWebContents?.send('ruffle:diagnostic', {
      tabId: mode.tabId,
      source: mode.source || 'bundled',
      phase: parsed.data.phase,
      detail: parsed.data.detail,
    });
  });

  const tabId = z.string().min(1).max(128);
  const url = z.string().min(1).max(8192).refine((value) => {
    if (value === 'about:newtab' || value === 'about:blank' || value === 'about:userscripts' || value === 'about:automation') return true;
    try { return ['http:', 'https:', 'file:'].includes(new URL(value).protocol); } catch { return false; }
  }, 'Unsupported navigation URL');
  const tabOnly = z.object({ tabId }).strict();

  createValidatedEventHandler('tab:create', z.object({
    tabId,
    url,
    ruffleConfig: z.object({ enabled: z.boolean(), source: z.enum(['bundled', 'cdn']) }).optional(),
  }).strict(), ({ window, args }) => {
    requireManagerForSender(window, 'tab:create').create(args.tabId, args.url, args.ruffleConfig);
  });

  createValidatedEventHandler('tab:close', tabOnly, ({ window, args }) => {
    const manager = requireOwnedManager(window, args.tabId);
    manager?.close(args.tabId);
  });

  createValidatedEventHandler('tab:suspend', tabOnly, ({ window, args }) => {
    const manager = requireOwnedManager(window, args.tabId);
    manager?.suspend(args.tabId);
  });

  createValidatedEventHandler('tab:activate', tabOnly, ({ window, args }) => {
    const manager = requireOwnedManager(window, args.tabId);
    manager?.activate(args.tabId);
  });

  // Hand keyboard focus to the active BrowserView (no-op payload) so the shell
  // stops swallowing keystrokes after an address-bar submit or link click.
  createEventHandler<undefined, boolean>('tab:focusActive', ({ window }) => (
    requireManagerForSender(window, 'tab:focusActive').focusActive()
  ));

  createValidatedEventHandler('tab:navigate', z.object({ tabId, url }).strict(), ({ window, args }) => {
    const manager = requireOwnedManager(window, args.tabId);
    manager?.navigate(args.tabId, args.url);
  });

  createValidatedEventHandler('tab:goBack', tabOnly, ({ window, args }) => {
    const manager = requireOwnedManager(window, args.tabId);
    manager?.goBack(args.tabId);
  });

  createValidatedEventHandler('tab:goForward', tabOnly, ({ window, args }) => {
    const manager = requireOwnedManager(window, args.tabId);
    manager?.goForward(args.tabId);
  });

  createValidatedEventHandler('tab:reload', tabOnly, ({ window, args }) => {
    const manager = requireOwnedManager(window, args.tabId);
    manager?.reload(args.tabId);
  });

  createValidatedEventHandler('tab:stop', tabOnly, ({ window, args }) => {
    const manager = requireOwnedManager(window, args.tabId);
    manager?.stop(args.tabId);
  });

  createValidatedEventHandler('tab:zoom', z.object({ tabId, factor: z.number().min(0.25).max(5) }).strict(), ({ window, args }) => {
    const manager = requireOwnedManager(window, args.tabId);
    manager?.setZoom(args.tabId, args.factor);
  });

  createValidatedEventHandler('tab:mute', z.object({ tabId, muted: z.boolean() }).strict(), ({ window, args }) => {
    const manager = requireOwnedManager(window, args.tabId);
    manager?.setMuted(args.tabId, args.muted);
  });

  createValidatedEventHandler('tab:devtools', tabOnly, ({ window, args }) => {
    const manager = requireOwnedManager(window, args.tabId);
    manager?.openDevTools(args.tabId);
  });

  createValidatedEventHandler('tab:find', z.object({ tabId, text: z.string().max(10000), options: z.record(z.unknown()).optional() }).strict(), ({ window, args }) => {
    const manager = requireOwnedManager(window, args.tabId);
    manager?.findInPage(args.tabId, args.text, args.options);
  });

  createValidatedEventHandler('tab:stopFind', z.object({ tabId, action: z.enum(['clearSelection', 'keepSelection', 'activateSelection']) }).strict(), ({ window, args }) => {
    const manager = requireOwnedManager(window, args.tabId);
    manager?.stopFindInPage(args.tabId, args.action);
  });

  createValidatedEventHandler('tab:setBounds', z.object({
    x: z.number().int().min(-10000).max(50000), y: z.number().int().min(-10000).max(50000),
    w: z.number().int().min(0).max(50000), h: z.number().int().min(0).max(50000),
  }).strict(), ({ window, args }) => {
    requireManagerForSender(window, 'tab:setBounds').setBounds(args.x ?? 0, args.y ?? 0, args.w ?? 0, args.h ?? 0);
  });

  createValidatedEventHandler('tab:setRuffleMode', z.object({ tabId, enabled: z.boolean(), source: z.enum(['bundled', 'cdn']) }).strict(), ({ window, args }) => {
    const manager = requireOwnedManager(window, args.tabId);
    manager?.setRuffleMode(args.tabId, args.enabled, args.source);
  });

  /**
   * P7：把标签拖到另一个窗口。落点由主进程读 `screen.getCursorScreenPoint()`，
   * 渲染层不需要关心窗口坐标；落在本窗口交回渲染层做重排。
   */
  createEventHandler<undefined, void>('tab:setViewVisibility', ({ window, args }) => {
    const manager = requireManagerForSender(window, 'tab:setViewVisibility');
    const visible = (args as { visible?: unknown } | undefined)?.visible;
    manager.setActiveViewVisible(visible !== false);
  });

  /**
   * P7：把标签拖出成新窗口（tear-off）。等新窗口 renderer 握手后再迁移，避免 adopted 事件丢失。
   */
  /**
   * P7：本窗口标签的权威快照。
   *
   * 渲染层的标签列表是事件驱动的，adopted/detached 任一丢失都会留下空壳窗口或幽灵
   * 标签。这条通道让渲染层能主动对账（tear-off 新窗口挂载后延迟拉一次最典型）。
   */
  createEventHandler('tab:list', ({ window }) => (
    window ? getTabManagerForSender(window.webContents)?.snapshotTabs() ?? [] : []
  ));

  /**
   * P7：把标签拖出成新窗口（tear-off）。
   *
   * 流程按 Chrome 重排：**迁移完成即开始跟随指针**，不再等松手才建窗口。
   * 源窗口这里**不关闭**——用户可能立刻把标签拖回来（回吸），关掉就无处可放；
   * 收尾统一由 `win:drag-drop` 判空处理。
   */
  createValidatedEventHandler('win:tear-off-tab', tabOnly, async ({ window, args }) => {
    const owner = getTabOwnerWindow(args.tabId);
    if (!owner || !window || owner.id !== window.id) throw new Error('tab does not belong to this window');
    if (getTabManagerForTabId(args.tabId)?.isTabBusy(args.tabId)) return { moved: false, reason: 'busy' };
    const point = screen.getCursorScreenPoint();
    // 拖拽期间源窗口会切到相邻标签；先压住视图，否则视图一出现就吃掉 pointermove/up。
    const ownerManager = getTabManagerForWindow(owner.id);
    ownerManager?.setViewHold(true);
    // 初始矩形与第一帧跟随完全一致（指针压在新窗口的标签上），避免窗口先闪一下再跳。
    // showInactive：拖拽期间不抢前台——源窗口握着鼠标捕获，被抢焦点就可能丢 pointerup。
    const newWin = createWindow({ adopting: true, showInactive: true, bounds: followBoundsAt(point) });
    // 建窗即置顶：`ready-to-show` 到握手完成之间，源窗口的 focusActive() 会把宿主角
    // 色抢回前台；等 startDragFollow 再置顶就来不及，用户会看到窗口冒出又沉下去。
    raiseForFollow(newWin);
    const ready = await whenRendererReady(newWin);
    if (!ready || newWin.isDestroyed()) {
      ownerManager?.setViewHold(false);
      try { if (!newWin.isDestroyed()) newWin.close(); } catch { /* ignore */ }
      return { moved: false, reason: 'renderer-timeout' };
    }
    if (!transferTabBetweenWindows(args.tabId, newWin)) {
      log.warn(`[Tabs] tear-off transfer failed tab=${args.tabId} newWin=${newWin.id}`);
      ownerManager?.setViewHold(false);
      try { if (!newWin.isDestroyed()) newWin.close(); } catch { /* ignore */ }
      return { moved: false, reason: 'transfer-failed' };
    }
    // 快照跟着 adopted 一起推：渲染层用主进程的权威列表重建，不靠 url 猜状态。
    log.info(`[Tabs] tear-off ok tab=${args.tabId} newWin=${newWin.id}`);
    notifyTabAdopted(args.tabId, newWin, window);
    startDragFollow(newWin, owner.id, args.tabId);
    return { moved: true, windowId: newWin.id };
  });

  /**
   * P7：拖拽落定（松手 / Esc 取消）。落点只认"指针下方的标签栏带"，
   * 命中别的窗口（含源窗口 = 回吸）就把标签迁过去并销毁临时窗口，否则就地定格。
   */
  createValidatedEventHandler('win:drag-drop', z.object({
    tabId,
    /** Esc/pointercancel：强制回吸到源窗口，不看指针位置。 */
    cancel: z.boolean().optional(),
  }).strict(), ({ args }) => {
    const session = stopDragFollow();
    if (!session || session.tabId !== args.tabId) return { placed: false, reason: 'no-session' };
    const point = screen.getCursorScreenPoint();
    const followWin = getWindowById(session.windowId);
    const ownerManager = getTabManagerForWindow(session.ownerWindowId);
    const candidates = getRegisteredWindows()
      .filter((win) => win.id !== session.windowId)
      .map((win) => ({ id: win.id, bounds: win.getBounds() }));
    const band = args.cancel ? null : resolveBandTarget(point, candidates);
    // 取消 → 固定回源窗口；否则只看指针下方的标签栏带（排除跟随窗口自己）。
    const targetWindowId = args.cancel ? session.ownerWindowId : band?.id ?? null;

    const closeFollowWindow = (): void => {
      if (!followWin || followWin.isDestroyed()) return;
      try { followWin.close(); } catch { /* ignore */ }
    };
    const closeIfEmpty = (windowId: number): void => {
      const win = getWindowById(windowId);
      if (!win) return;
      const manager = getTabManagerForWindow(windowId);
      if (manager && manager.getTabCount() === 0) win.close();
    };

    if (targetWindowId !== null) {
      const targetWin = getWindowById(targetWindowId);
      if (targetWin && transferTabBetweenWindows(args.tabId, targetWin)) {
        log.info(`[Tabs] drag-drop merge tab=${args.tabId} from=${session.windowId} into=${targetWindowId} cancel=${Boolean(args.cancel)}`);
        notifyTabAdopted(args.tabId, targetWin, followWin);
        closeFollowWindow();
        // 跟随窗口一关，用户应当看到刚把标签放进去的那个窗口，而不是被别的窗口挡着。
        try { targetWin.moveTop(); targetWin.focus(); } catch { /* window gone */ }
        ownerManager?.setViewHold(false);
        closeIfEmpty(session.ownerWindowId);
        return { placed: true, merged: true, windowId: targetWindowId };
      }
    }

    log.info(`[Tabs] drag-drop place tab=${args.tabId} win=${session.windowId} at=${point.x},${point.y}`);
    ownerManager?.setViewHold(false);
    // 就地定格：卸置顶 + 重新抬到最前。拖拽期间的 topmost 已由 stopDragFollow 撤掉，
    // 但源窗口那次 focusActive() 仍可能排在后面把它盖住，这里显式抬一次。
    settleDragWindow(session.windowId);
    // 跟随窗口是不抢焦点显示的（见 `createWindow` 的 showInactive），落定后把键盘焦点
    // 交给里面那个页面，否则用户还得先点一下网页才能操作 Flash。推迟一个 tick：
    // `focus()` 的 `SetForegroundWindow` 不保证同步生效，`focusActive` 又要先看到窗口在
    // 前台才肯下手（它有条"后台窗口不抢焦点"的守卫）。
    const placedWindowId = session.windowId;
    setTimeout(() => { getTabManagerForWindow(placedWindowId)?.focusActive(); }, 0);
    closeIfEmpty(session.ownerWindowId);
    return { placed: true };
  });

  /**
   * P7：标签拖拽落点分派。
   *
   * - 落到别的窗口 → 迁移过去；
   * - 窗口外（含多显示器负坐标）→ `new-window`，由渲染层接着调 `win:tear-off-tab`；
   * - 落在**本窗口内容区**（`zone: 'content'`，渲染层已排除标签卡与顶栏壳层）→ 同样
   *   按 tear-off 处理。最大化时窗口矩形铺满工作区，"窗口外"根本不存在，这条分支
   *   是最大化场景唯一能拖出标签的路径；
   * - 落在本窗口其它位置（拖回顶栏/壳层）→ `same-window`，视为取消。
   */
  createValidatedEventHandler('win:move-tab', z.object({
    tabId,
    zone: z.enum(['content', 'outside']).optional(),
  }).strict(), ({ window, args }) => {
    const owner = getTabOwnerWindow(args.tabId);
    if (!owner || !window || owner.id !== window.id) {
      throw new Error('tab does not belong to this window');
    }
    if (getTabManagerForTabId(args.tabId)?.isTabBusy(args.tabId)) return { moved: false, reason: 'busy' };
    const point = screen.getCursorScreenPoint();
    const target = resolveDropTarget(
      point,
      getRegisteredWindows().map((win) => ({ id: win.id, bounds: win.getBounds() })),
    );
    const intent = resolveDropIntent(target, owner.id, args.zone === 'content');
    if (intent.kind === 'cancel') return { moved: false, reason: 'same-window' };
    if (intent.kind === 'tear-off') return { moved: false, reason: 'new-window' };

    const targetWin = getWindowById(intent.id);
    if (!targetWin) return { moved: false, reason: 'no-target' };
    if (!transferTabBetweenWindows(args.tabId, targetWin)) return { moved: false, reason: 'transfer-failed' };

    notifyTabAdopted(args.tabId, targetWin, window);
    // 旧窗口被拖空 → 自动关闭（Chrome 行为）；close 走正常生命周期，不标记 clean shutdown。
    const sourceManager = getTabManagerForWindow(owner.id);
    if (sourceManager && sourceManager.getTabCount() === 0) owner.close();
    return { moved: true, targetWindowId: intent.id };
  });
}
