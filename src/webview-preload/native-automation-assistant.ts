import { ipcRenderer } from 'electron';
import installAssistantUI from '../main/modules/userscripts/bundled-scripts/automation-frame-assistant.user.js?native';
import { createAutomationAssistantApi } from './automation-assistant-api';
import { localizeAutomationMessage } from '../shared/automation/localized-message';

/** Runs the bundled UI directly in preload, independently of userscript installation/grants. */
export function installNativeAutomationAssistant(): void {
  if (!process.isMainFrame || !/^(https?|file):$/iu.test(location.protocol)) return;
  let locale = 'zh-CN';
  let languageChanged = false;
  let dispose: (() => void) | undefined;
  const api = createAutomationAssistantApi(async (operation, payload) => {
    try {
      const result = await ipcRenderer.invoke(`automation-assistant:${operation}`, payload);
      if (operation === 'status' && result && locale === 'en') {
        for (const key of ['currentStep', 'message']) if (typeof result[key] === 'string') result[key] = localizeAutomationMessage(result[key], locale);
        if (Array.isArray(result.logs)) result.logs = result.logs.map((entry: { message: string; system?: boolean }) => ({ ...entry, message: entry.system ? localizeAutomationMessage(entry.message, locale) : entry.message }));
      }
      return result;
    } catch (error) { throw new Error(localizeAutomationMessage(error instanceof Error ? error.message : String(error), locale)); }
  }, 'native');
  let show: (() => void) | undefined;
  const values = new Map<string, unknown>();
  const gm = {
    baoAutomation: api,
    getValue: (key: string, fallback: unknown) => values.get(key) ?? fallback,
    setValue: (key: string, value: unknown) => { values.set(key, value); },
    registerMenuCommand: (_title: string, callback: () => void) => { show = callback; },
  };
  const install = (): void => {
    if (document.getElementById('bao-automation-frame-assistant')) return;
    // This is compile-time bundled application code, never installed/edited script text.
    // Keep GM scoped to the function; no privileged API is published to the page.
    dispose = installAssistantUI(gm, locale);
  };
  const ready = document.readyState === 'loading' ? new Promise<void>((resolve) => document.addEventListener('DOMContentLoaded', () => resolve(), { once: true })) : Promise.resolve();
  void Promise.all([ready, ipcRenderer.invoke('ui:get-language').catch(() => 'zh-CN')]).then(([, language]) => { if (!languageChanged) locale = language === 'en' ? 'en' : 'zh-CN'; install(); });
  ipcRenderer.on('ui:language-changed', (_event, language: string) => {
    if (language === locale) return;
    languageChanged = true;
    locale = language === 'en' ? 'en' : 'zh-CN';
    dispose?.(); dispose = undefined;
    void api.endCoordinatePick().catch(() => undefined);
    install();
  });
  ipcRenderer.on('automation-assistant:show', () => { install(); show?.(); });
}
