import { ipcMain, type IpcMainEvent } from 'electron';
import log from 'electron-log';
import { z } from 'zod';

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
