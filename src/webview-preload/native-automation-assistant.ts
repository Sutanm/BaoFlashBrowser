import { ipcRenderer } from 'electron';
import installAssistantUI from '../main/modules/userscripts/bundled-scripts/automation-frame-assistant.user.js?native';
import { createAutomationAssistantApi } from './automation-assistant-api';

/** Runs the bundled UI directly in preload, independently of userscript installation/grants. */
export function installNativeAutomationAssistant(): void {
  if (!process.isMainFrame || !/^(https?|file):$/iu.test(location.protocol)) return;
  const api = createAutomationAssistantApi((operation, payload) => ipcRenderer.invoke(`automation-assistant:${operation}`, payload), 'native');
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
    installAssistantUI(gm);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
  ipcRenderer.on('automation-assistant:show', () => { install(); show?.(); });
}
