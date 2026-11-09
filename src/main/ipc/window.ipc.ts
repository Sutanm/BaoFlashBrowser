import { z } from 'zod';
import type { BrowserWindow } from 'electron';
import { createHandler, createEventHandler, createValidatedEventHandler } from '../utils/ipc-wrapper';
import { getSessionRecoveryStatus, resolveSessionRecovery } from '../modules/session-recovery';
import { createWindow, getWindowContext, getWindowKey } from '../modules/window';

/**
 * 窗口相关 IPC（SDD: docs/specs/multi-window-plan.md §6.3 / §7 P2）。
 *
 * 所有 `win:*` 通道都按 `event.sender` 路由：窗口 B 的按钮只能操作窗口 B，
 * 不允许再回退到"最近聚焦窗口"（旧实现的 provider 语义）。
 */
function requireWindow(window: BrowserWindow | null, channel: string): BrowserWindow {
  if (!window) throw new Error(`IPC sender is not a registered window: ${channel}`);
  return window;
}

const newWindowBounds = z.object({
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  width: z.number().finite().positive().optional(),
  height: z.number().finite().positive().optional(),
}).strict();

const newWindowPayload = z.object({
  url: z.string().min(1).max(8192).optional(),
  bounds: newWindowBounds.optional(),
}).strict().optional();

export function registerWindowIPC(): void {
  createEventHandler('win:minimize', ({ window }) => {
    requireWindow(window, 'win:minimize').minimize();
  });
  createEventHandler('win:maximize', ({ window }) => {
    requireWindow(window, 'win:maximize').maximize();
  });
  createEventHandler('win:unmaximize', ({ window }) => {
    requireWindow(window, 'win:unmaximize').unmaximize();
  });
  createEventHandler('win:close', ({ window }) => {
    requireWindow(window, 'win:close').close();
  });
  createValidatedEventHandler('win:setFullscreen', z.boolean(), ({ window, args }) => {
    requireWindow(window, 'win:setFullscreen').setFullScreen(args);
  });
  createEventHandler('win:toggleFullscreen', ({ window }) => {
    const win = requireWindow(window, 'win:toggleFullscreen');
    win.setFullScreen(!win.isFullScreen());
  });
  createEventHandler('win:isMaximized', ({ window }) => (
    requireWindow(window, 'win:isMaximized').isMaximized()
  ));
  createEventHandler('win:get-context', ({ window }) => {
    const win = requireWindow(window, 'win:get-context');
    const context = getWindowContext(win);
    if (!context) throw new Error('IPC sender is not a registered window: win:get-context');
    return {
      ...context,
      isMaximized: win.isMaximized(),
      bounds: win.getBounds(),
    };
  });
  createValidatedEventHandler('win:new-window', newWindowPayload, ({ args }) => {
    // url 暂存进窗口上下文，由 P6 的新窗口首标签消费；P2 只保证窗口与归属正确。
    const win = createWindow({
      bounds: args?.bounds,
      ...(args?.url ? { initialUrl: args.url } : {}),
    });
    return { windowKey: getWindowKey(win) };
  });

  createHandler('session:recovery-status', () => getSessionRecoveryStatus());
  createHandler('session:resolve-recovery', () => { resolveSessionRecovery(); });
}
