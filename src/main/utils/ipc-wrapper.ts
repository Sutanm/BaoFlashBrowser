import { ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import log from 'electron-log';
import { z } from 'zod';

/**
 * 多窗口 IPC 路由（SDD: docs/specs/multi-window-plan.md §6.3 / §7 P2）。
 *
 * 这里刻意不 import `./modules/window`：ipc-wrapper 被几乎所有 IPC 模块引用，
 * 直接依赖 window.ts 会把 electron-store/session-recovery 拖进每个单测。
 * 组合根（index.ts）在注册任何 IPC 之前调用 `setIpcWindowResolver()`。
 */
export type IpcWindowResolver = (sender: Electron.WebContents) => BrowserWindow | null;

let resolveWindow: IpcWindowResolver = () => null;

export function setIpcWindowResolver(resolver: IpcWindowResolver): void {
  resolveWindow = resolver;
}

export interface IpcEventHandlerContext<T> {
  event: IpcMainInvokeEvent;
  /** sender 所属的注册窗口；隐藏窗口 / DevTools 窗口 / 未注册 sender 为 null。 */
  window: BrowserWindow | null;
  args: T;
}

// O05: IPC handle 包装器 — 统一错误处理、日志、参数解构
export function createHandler<T = void, R = unknown>(
  channel: string,
  fn: (args: T) => R | Promise<R>,
): void {
  ipcMain.handle(channel, async (_e, args: T) => {
    try {
      return await fn(args);
    } catch (err: unknown) {
      log.error(`[IPC] ${channel} failed:`, err instanceof Error ? err.message : String(err));
      throw err;
    }
  });
}

/** 带事件上下文的 handler：用于所有需要按 sender 定位窗口的通道。 */
export function createEventHandler<T = void, R = unknown>(
  channel: string,
  fn: (ctx: IpcEventHandlerContext<T>) => R | Promise<R>,
): void {
  ipcMain.handle(channel, async (event: IpcMainInvokeEvent, args: T) => {
    try {
      const window = resolveWindow(event.sender);
      return await fn({ event, window, args });
    } catch (err: unknown) {
      log.error(`[IPC] ${channel} failed:`, err instanceof Error ? err.message : String(err));
      throw err;
    }
  });
}

export function createValidatedHandler<S extends z.ZodTypeAny, R = unknown>(
  channel: string,
  schema: S,
  fn: (args: z.infer<S>) => R | Promise<R>,
): void {
  createHandler<unknown, R>(channel, async (args) => {
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      log.warn(`[IPC] ${channel} rejected invalid arguments:`, parsed.error.issues);
      throw new Error(`Invalid arguments for ${channel}`);
    }
    return fn(parsed.data);
  });
}

/** 带事件上下文 + 参数校验的 handler。 */
export function createValidatedEventHandler<S extends z.ZodTypeAny, R = unknown>(
  channel: string,
  schema: S,
  fn: (ctx: IpcEventHandlerContext<z.infer<S>>) => R | Promise<R>,
): void {
  createEventHandler<unknown, R>(channel, async (ctx) => {
    const parsed = schema.safeParse(ctx.args);
    if (!parsed.success) {
      log.warn(`[IPC] ${channel} rejected invalid arguments:`, parsed.error.issues);
      throw new Error(`Invalid arguments for ${channel}`);
    }
    return fn({ event: ctx.event, window: ctx.window, args: parsed.data });
  });
}

export function registerValidatedListener<S extends z.ZodTypeAny>(
  channel: string,
  schema: S,
  fn: (event: IpcMainEvent, args: z.infer<S>) => void,
): void {
  ipcMain.on(channel, (event, args: unknown) => {
    const parsed = schema.safeParse(args);
    if (!parsed.success) {
      log.warn(`[IPC] ${channel} rejected invalid arguments:`, parsed.error.issues);
      return;
    }
    try {
      fn(event, parsed.data);
    } catch (err: unknown) {
      log.error(`[IPC] ${channel} failed:`, err instanceof Error ? err.message : String(err));
    }
  });
}
