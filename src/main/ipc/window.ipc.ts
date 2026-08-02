import { BrowserWindow } from 'electron';
import { z } from 'zod';
import { createHandler, createValidatedHandler } from '../utils/ipc-wrapper';
import { getSessionRecoveryStatus, resolveSessionRecovery } from '../modules/session-recovery';

export function registerWindowIPC(getWindow: () => BrowserWindow | null): void {
  createHandler('win:minimize', () => { getWindow()?.minimize(); });
  createHandler('win:maximize', () => { getWindow()?.maximize(); });
  createHandler('win:unmaximize', () => { getWindow()?.unmaximize(); });
  createHandler('win:close', () => { getWindow()?.close(); });
  createValidatedHandler('win:setFullscreen', z.boolean(), (fullscreen) => {
    const win = getWindow();
    if (win) win.setFullScreen(fullscreen);
  });
  createHandler('win:toggleFullscreen', () => {
    const win = getWindow();
    if (win) win.setFullScreen(!win.isFullScreen());
  });
  createHandler('win:isMaximized', () => getWindow()?.isMaximized() ?? false);
  createHandler('session:recovery-status', () => getSessionRecoveryStatus());
  createHandler('session:resolve-recovery', () => { resolveSessionRecovery(); });
}
