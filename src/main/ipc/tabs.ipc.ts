import { ipcMain, screen } from 'electron';
import type { BrowserWindow } from 'electron';
import { z } from 'zod';
import { createEventHandler, createValidatedEventHandler } from '../utils/ipc-wrapper';
import { getTabManagerForSender, getTabManagerForTabId, getTabManagerForWindow, getTabOwnerWindow, tabManager, transferTabBetweenWindows } from '../modules/tabs';
import { createWindow, getRegisteredWindows, getWindowById, whenRendererReady } from '../modules/window';
import { resolveDropTarget } from '../utils/drop-target';
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

export function registerTabsIPC(): void {
  ipcMain.on('password:form-detected', (event) => {
    tabManager.notifyPasswordFormDetected(event.sender.id);
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
  createValidatedEventHandler('win:tear-off-tab', tabOnly, async ({ window, args }) => {
    const owner = getTabOwnerWindow(args.tabId);
    if (!owner || !window || owner.id !== window.id) throw new Error('tab does not belong to this window');
    if (getTabManagerForTabId(args.tabId)?.isTabBusy(args.tabId)) return { moved: false, reason: 'busy' };
    const point = screen.getCursorScreenPoint();
    const newWin = createWindow({ bounds: { x: Math.max(0, point.x - 160), y: Math.max(0, point.y - 40), width: 1100, height: 760 } });
    const ready = await whenRendererReady(newWin);
    if (!ready || newWin.isDestroyed()) {
      try { if (!newWin.isDestroyed()) newWin.close(); } catch { /* ignore */ }
      return { moved: false, reason: 'renderer-timeout' };
    }
    if (!transferTabBetweenWindows(args.tabId, newWin)) return { moved: false, reason: 'transfer-failed' };
    const adoptedUrl = getTabManagerForTabId(args.tabId)?.getTabUrl(args.tabId) ?? undefined;
    window.webContents.send('tab:detached', { tabId: args.tabId });
    newWin.webContents.send('tab:adopted', { tabId: args.tabId, url: adoptedUrl });
    const sourceManager = getTabManagerForWindow(owner.id);
    if (sourceManager && sourceManager.getTabCount() === 0) owner.close();
    return { moved: true };
  });

  createValidatedEventHandler('win:move-tab', tabOnly, ({ window, args }) => {
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
    if (target.kind !== 'window') return { moved: false, reason: target.kind };
    if (target.id === owner.id) return { moved: false, reason: 'same-window' };
    const targetWin = getWindowById(target.id);
    if (!targetWin) return { moved: false, reason: 'no-target' };
    if (!transferTabBetweenWindows(args.tabId, targetWin)) return { moved: false, reason: 'transfer-failed' };

    window.webContents.send('tab:detached', { tabId: args.tabId });
    targetWin.webContents.send('tab:adopted', { tabId: args.tabId, url: getTabManagerForTabId(args.tabId)?.getTabUrl(args.tabId) ?? undefined });
    // 旧窗口被拖空 → 自动关闭（Chrome 行为）；close 走正常生命周期，不标记 clean shutdown。
    const sourceManager = getTabManagerForWindow(owner.id);
    if (sourceManager && sourceManager.getTabCount() === 0) owner.close();
    return { moved: true, targetWindowId: target.id };
  });
}
