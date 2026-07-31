import { ipcMain } from 'electron';
import log from 'electron-log';

// O05: IPC handle 包装器 — 统一错误处理、日志、参数解构
export function createHandler<T = any, R = any>(
  channel: string,
  fn: (args: T) => R,
): void {
  ipcMain.handle(channel, (_e, args: T) => {
    try {
      return fn(args);
    } catch (err: any) {
      log.error(`[IPC] ${channel} failed:`, err?.message || err);
      throw err;
    }
  });
}
