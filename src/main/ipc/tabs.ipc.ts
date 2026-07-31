import { ipcMain } from 'electron';
import { createHandler } from '../utils/ipc-wrapper';
import { tabManager } from '../modules/tabs';
import { ruffleJsContent } from '../modules/ruffle-bundle';

export function registerTabsIPC(): void {
  // Sync handler: preload uses sendSync to get ruffle config at document-start
  ipcMain.on('get-ruffle-mode', (e) => {
    const ruffle = tabManager.getRuffleForWC(e.sender.id);
    e.returnValue = {
      enabled: ruffle?.enabled ?? false,
      source: ruffle?.source || 'bundled',
      js: (ruffle?.enabled && ruffle?.source !== 'cdn') ? ruffleJsContent() : '',
    };
  });

  createHandler('tab:create', (args: any) =>
    tabManager.create(args.tabId, args.url, args.ruffleConfig));

  createHandler('tab:close', (args: any) =>
    tabManager.close(args.tabId));

  createHandler('tab:activate', (args: any) =>
    tabManager.activate(args.tabId));

  createHandler('tab:navigate', (args: any) =>
    tabManager.navigate(args.tabId, args.url));

  createHandler('tab:goBack', (args: any) =>
    tabManager.goBack(args.tabId));

  createHandler('tab:goForward', (args: any) =>
    tabManager.goForward(args.tabId));

  createHandler('tab:reload', (args: any) =>
    tabManager.reload(args.tabId));

  createHandler('tab:stop', (args: any) =>
    tabManager.stop(args.tabId));

  createHandler('tab:zoom', (args: any) =>
    tabManager.setZoom(args.tabId, args.factor));

  createHandler('tab:mute', (args: any) =>
    tabManager.setMuted(args.tabId, args.muted));

  createHandler('tab:devtools', (args: any) =>
    tabManager.openDevTools(args.tabId));

  createHandler('tab:find', (args: any) =>
    tabManager.findInPage(args.tabId, args.text, args.options));

  createHandler('tab:stopFind', (args: any) =>
    tabManager.stopFindInPage(args.tabId, args.action));

  createHandler('tab:setBounds', (args: any) =>
    tabManager.setBounds(args.x ?? 0, args.y ?? 0, args.w ?? 0, args.h ?? 0));

  createHandler('tab:setRuffleMode', (args: any) =>
    tabManager.setRuffleMode(args.tabId, args.enabled, args.source));
}
