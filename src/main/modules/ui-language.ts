import { ipcMain, webContents, type BrowserWindow } from 'electron';
import { loadConfig, saveConfig } from './config';

export function getUiLanguage(): 'en' | 'zh-CN' { return loadConfig().uiLanguage === 'en' ? 'en' : 'zh-CN'; }
export function uiText(zh: string, en: string): string { return getUiLanguage() === 'en' ? en : zh; }
export function registerUiLanguageIPC(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('ui:get-language', () => getUiLanguage());
  ipcMain.handle('ui:set-language', (event, language: unknown) => {
    if (event.sender.id !== getWindow()?.webContents.id || (language !== 'en' && language !== 'zh-CN')) throw new Error('Invalid UI language request');
    const locale = language as 'en' | 'zh-CN';
    if (getUiLanguage() !== locale) {
      saveConfig({ uiLanguage: locale });
      for (const contents of webContents.getAllWebContents()) if (!contents.isDestroyed()) contents.send('ui:language-changed', locale);
    }
    return locale;
  });
}
