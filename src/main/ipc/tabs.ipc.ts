import { ipcMain } from 'electron';
import { tabManager } from '../modules/tabs';

export function registerTabsIPC(): void {
  ipcMain.handle('tab:create', (_e: any, args: any) =>
    tabManager.create(args.tabId, args.url));

  ipcMain.handle('tab:close', (_e: any, args: any) =>
    tabManager.close(args.tabId));

  ipcMain.handle('tab:activate', (_e: any, args: any) =>
    tabManager.activate(args.tabId));

  ipcMain.handle('tab:navigate', (_e: any, args: any) =>
    tabManager.navigate(args.tabId, args.url));

  ipcMain.handle('tab:goBack', (_e: any, args: any) =>
    tabManager.goBack(args.tabId));

  ipcMain.handle('tab:goForward', (_e: any, args: any) =>
    tabManager.goForward(args.tabId));

  ipcMain.handle('tab:reload', (_e: any, args: any) =>
    tabManager.reload(args.tabId));

  ipcMain.handle('tab:stop', (_e: any, args: any) =>
    tabManager.stop(args.tabId));

  ipcMain.handle('tab:zoom', (_e: any, args: any) =>
    tabManager.setZoom(args.tabId, args.factor));

  ipcMain.handle('tab:mute', (_e: any, args: any) =>
    tabManager.setMuted(args.tabId, args.muted));

  ipcMain.handle('tab:devtools', (_e: any, args: any) =>
    tabManager.openDevTools(args.tabId));

  ipcMain.handle('tab:find', (_e: any, args: any) =>
    tabManager.findInPage(args.tabId, args.text, args.options));

  ipcMain.handle('tab:stopFind', (_e: any, args: any) =>
    tabManager.stopFindInPage(args.tabId, args.action));

  ipcMain.handle('tab:setBounds', (_e: any, args: any) =>
    tabManager.setBounds(Number(args.x) || 0, Number(args.y) || 0, Number(args.w) || 0, Number(args.h) || 0));
}
