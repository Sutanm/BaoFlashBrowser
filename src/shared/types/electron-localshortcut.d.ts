declare module 'electron-localshortcut' {
  import { BrowserWindow } from 'electron';
  function register(
    win: BrowserWindow,
    accelerator: string,
    callback: () => void,
  ): void;
  function unregister(win: BrowserWindow, accelerator: string): void;
  function unregisterAll(win: BrowserWindow): void;
}
