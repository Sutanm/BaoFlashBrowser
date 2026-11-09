// 多窗口 P5：抽屉尺寸/停靠按 windowKey 分片，旧单键保持兼容。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();

vi.stubGlobal('window', {
  innerHeight: 800,
  innerWidth: 1200,
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  },
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
});
vi.stubGlobal('document', { querySelector: () => null });
vi.stubGlobal('HTMLElement', class HTMLElement {});

const devtoolStore = await import('../src/renderer/store/useDevToolStore');

describe('devtool drawer storage scope (P5)', () => {
  beforeEach(() => {
    storage.clear();
    devtoolStore.setDevToolStorageScope('');
    vi.useFakeTimers();
  });

  it('keeps the legacy unscoped key before a window key is known', () => {
    devtoolStore.useDevToolStore.getState().setHeight(300);
    vi.advanceTimersByTime(200);

    expect(storage.get('devtoolbox.height')).toBe('300');
    expect(devtoolStore.getDevToolStorageScope()).toBe('');
  });

  it('writes and reads per-window keys after the scope is set', () => {
    devtoolStore.setDevToolStorageScope('wk-a');
    devtoolStore.useDevToolStore.getState().setHeight(420);
    vi.advanceTimersByTime(200);

    expect(storage.get('wk-a:devtoolbox.height')).toBe('420');
    expect(storage.get('devtoolbox.height')).toBeUndefined();
  });

  it('reloads dock and size from the new window scope', () => {
    storage.set('wk-b:devtoolbox.height', '250');
    storage.set('wk-b:devtoolbox.width', '500');
    storage.set('wk-b:devtoolbox.dock', 'left');

    devtoolStore.setDevToolStorageScope('wk-b');

    const state = devtoolStore.useDevToolStore.getState();
    expect(state.height).toBe(250);
    expect(state.width).toBe(500);
    expect(state.dock).toBe('left');
    expect(state.lastEmbeddedDock).toBe('left');
  });
});
