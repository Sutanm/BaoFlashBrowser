import { ipcMain } from 'electron';
import log from 'electron-log';
import { tabManager } from '../modules/tabs';
import { ruffleJsContent } from '../modules/ruffle-bundle';

function handle(channel: string, fn: (args: any) => void) {
  ipcMain.handle(channel, (_e: any, args: any) => {
    try {
      return fn(args);
    } catch (err: any) {
      log.error(`[IPC] ${channel} failed:`, err?.message || err);
      throw err;
    }
  });
}

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

  handle('tab:create', (args) =>
    tabManager.create(args.tabId, args.url, args.ruffleConfig));

  handle('tab:close', (args) =>
    tabManager.close(args.tabId));

  handle('tab:activate', (args) =>
    tabManager.activate(args.tabId));

  handle('tab:navigate', (args) =>
    tabManager.navigate(args.tabId, args.url));

  handle('tab:goBack', (args) =>
    tabManager.goBack(args.tabId));

  handle('tab:goForward', (args) =>
    tabManager.goForward(args.tabId));

  handle('tab:reload', (args) =>
    tabManager.reload(args.tabId));

  handle('tab:stop', (args) =>
    tabManager.stop(args.tabId));

  handle('tab:zoom', (args) =>
    tabManager.setZoom(args.tabId, args.factor));

  handle('tab:mute', (args) =>
    tabManager.setMuted(args.tabId, args.muted));

  handle('tab:devtools', (args) =>
    tabManager.openDevTools(args.tabId));

  handle('tab:find', (args) =>
    tabManager.findInPage(args.tabId, args.text, args.options));

  handle('tab:stopFind', (args) =>
    tabManager.stopFindInPage(args.tabId, args.action));

  handle('tab:setBounds', (args) =>
    tabManager.setBounds(args.x ?? 0, args.y ?? 0, args.w ?? 0, args.h ?? 0));

  handle('tab:setRuffleMode', (args) =>
    tabManager.setRuffleMode(args.tabId, args.enabled, args.source));
}
