import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ language: 'zh-CN', handlers: new Map<string, (...args: any[]) => any>(), send: vi.fn(), save: vi.fn() }));
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => state.handlers.set(name, handler) },
  webContents: { getAllWebContents: () => [{ isDestroyed: () => false, send: state.send }, { isDestroyed: () => true, send: vi.fn() }] },
}));
vi.mock('../src/main/modules/config', () => ({ loadConfig: () => ({ uiLanguage: state.language }), saveConfig: (value: { uiLanguage: string }) => { state.save(value); state.language = value.uiLanguage; return true; } }));
import { registerUiLanguageIPC } from '../src/main/modules/ui-language';

beforeEach(() => {
  state.language = 'zh-CN'; state.handlers.clear(); state.send.mockClear(); state.save.mockClear();
  registerUiLanguageIPC(() => ({ webContents: { id: 1 } }) as never);
});
describe('native UI language synchronization', () => {
  it('allows the shell to persist and broadcast a supported language', () => {
    expect(state.handlers.get('ui:set-language')!({ sender: { id: 1 } }, 'en')).toBe('en');
    expect(state.handlers.get('ui:get-language')!()).toBe('en');
    expect(state.send).toHaveBeenCalledExactlyOnceWith('ui:language-changed', 'en');
  });
  it('rejects BrowserView callers and non-string or unsupported language values', () => {
    for (const [sender, locale] of [[2, 'en'], [1, ['en']], [1, 'fr']]) expect(() => state.handlers.get('ui:set-language')!({ sender: { id: sender } }, locale)).toThrow('Invalid UI language request');
    expect(state.save).not.toHaveBeenCalled();
    expect(state.send).not.toHaveBeenCalled();
  });
  it('does not reinstall assistants when the language is unchanged', () => {
    state.handlers.get('ui:set-language')!({ sender: { id: 1 } }, 'zh-CN');
    expect(state.send).not.toHaveBeenCalled();
  });
});
