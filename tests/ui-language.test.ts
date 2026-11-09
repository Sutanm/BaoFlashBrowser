import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  language: 'zh-CN',
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  send: vi.fn(),
  save: vi.fn(),
  // 多窗口 P2：语言只允许窗口外壳发起；这里模拟 sender → 所属窗口。
  windowsBySender: new Map<number, { id: number; webContents: { id: number } }>(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => state.handlers.set(name, handler) },
  webContents: { getAllWebContents: () => [{ isDestroyed: () => false, send: state.send }, { isDestroyed: () => true, send: vi.fn() }] },
}));
vi.mock('../src/main/modules/config', () => ({
  loadConfig: () => ({ uiLanguage: state.language }),
  saveConfig: (value: { uiLanguage: string }) => { state.save(value); state.language = value.uiLanguage; return true; },
}));
vi.mock('electron-log', () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { registerUiLanguageIPC } from '../src/main/modules/ui-language';
import { setIpcWindowResolver } from '../src/main/utils/ipc-wrapper';

beforeEach(() => {
  state.language = 'zh-CN';
  state.handlers.clear();
  state.send.mockClear();
  state.save.mockClear();
  const shell = { id: 1, webContents: { id: 1 } };
  state.windowsBySender.clear();
  state.windowsBySender.set(1, shell);
  state.windowsBySender.set(2, shell);
  setIpcWindowResolver((wc: { id: number }) => (state.windowsBySender.get(wc.id) as never) ?? null);
  registerUiLanguageIPC();
});

describe('native UI language synchronization', () => {
  it('allows the shell to persist and broadcast a supported language', async () => {
    await expect(state.handlers.get('ui:set-language')!({ sender: { id: 1 } }, 'en')).resolves.toBe('en');
    await expect(state.handlers.get('ui:get-language')!()).resolves.toBe('en');
    expect(state.send).toHaveBeenCalledExactlyOnceWith('ui:language-changed', 'en');
  });

  it('rejects BrowserView, hidden-window and malformed callers', async () => {
    // 2 号 sender 反查到的是外壳 1，但 sender 本身不是外壳 → 拒绝。
    for (const [sender, locale] of [[2, 'en'], [999, 'en'], [1, ['en']], [1, 'fr']] as const) {
      await expect(state.handlers.get('ui:set-language')!({ sender: { id: sender } }, locale)).rejects.toThrow('Invalid UI language request');
    }
    expect(state.save).not.toHaveBeenCalled();
    expect(state.send).not.toHaveBeenCalled();
  });

  it('does not reinstall assistants when the language is unchanged', async () => {
    await state.handlers.get('ui:set-language')!({ sender: { id: 1 } }, 'zh-CN');
    expect(state.send).not.toHaveBeenCalled();
  });
});
