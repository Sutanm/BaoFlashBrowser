import { BrowserWindow } from 'electron';
import { createHandler } from '../utils/ipc-wrapper';

export function registerWindowIPC(getWindow: () => BrowserWindow | null): void {
  createHandler('win:minimize', () => { getWindow()?.minimize(); });
  createHandler('win:maximize', () => { getWindow()?.maximize(); });
  createHandler('win:unmaximize', () => { getWindow()?.unmaximize(); });
  createHandler('win:close', () => { getWindow()?.close(); });
  createHandler('win:setFullscreen', (_args: any) => {
    const win = getWindow();
    if (win) win.setFullScreen(_args.fullscreen);
  });
  createHandler('win:toggleFullscreen', () => {
    const win = getWindow();
    if (win) win.setFullScreen(!win.isFullScreen());
  });
  createHandler('win:isMaximized', () => getWindow()?.isMaximized() ?? false);
}
