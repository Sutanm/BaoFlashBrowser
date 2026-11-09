import { webContents } from 'electron';
import { loadConfig, saveConfig } from './config';
import { createEventHandler, createHandler } from '../utils/ipc-wrapper';

export function getUiLanguage(): 'en' | 'zh-CN' { return loadConfig().uiLanguage === 'en' ? 'en' : 'zh-CN'; }
export function uiText(zh: string, en: string): string { return getUiLanguage() === 'en' ? en : zh; }

/**
 * 多窗口 P2：语言只允许"注册窗口的外壳"发起。
 * 旧实现拿唯一主窗口的 webContents id 比较；多窗口下必须按 sender 反查窗口，
 * 既允许任一窗口外壳切换语言，也继续拒绝 BrowserView / 隐藏窗口。
 */
export function registerUiLanguageIPC(): void {
  createHandler('ui:get-language', () => getUiLanguage());
  createEventHandler<unknown, 'en' | 'zh-CN'>('ui:set-language', ({ event, window, args }) => {
    const locale = args;
    if (!window || window.webContents.id !== event.sender.id || (locale !== 'en' && locale !== 'zh-CN')) {
      throw new Error('Invalid UI language request');
    }
    if (getUiLanguage() !== locale) {
      saveConfig({ uiLanguage: locale });
      for (const contents of webContents.getAllWebContents()) if (!contents.isDestroyed()) contents.send('ui:language-changed', locale);
    }
    return locale;
  });
}
