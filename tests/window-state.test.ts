// 多窗口 P5：窗口几何/顺序持久化的纯逻辑与 store 读写。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const storeState = vi.hoisted(() => ({ stores: new Map<string, Map<string, unknown>>() }));
vi.mock('electron-store', () => ({
  default: class MockStore {
    private readonly data: Map<string, unknown>;
    constructor(options: { name?: string; defaults?: Record<string, unknown> }) {
      const name = options.name ?? 'config';
      let data = storeState.stores.get(name);
      if (!data) {
        data = new Map(Object.entries(options.defaults ?? {}));
        storeState.stores.set(name, data);
      }
      this.data = data;
    }
    get(key: string): unknown { return this.data.get(key); }
    set(key: string, value: unknown): void { this.data.set(key, value); }
  },
}));
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const windowState = await import('../src/main/modules/window-state');

const BOUNDS = { x: 10, y: 20, width: 1000, height: 700 };

describe('window state persistence (P5)', () => {
  beforeEach(() => {
    for (const data of storeState.stores.values()) data.clear();
  });

  it('drops malformed records and keeps a bounded, uniquely keyed list', () => {
    const sanitized = windowState.sanitizeWindowStates([
      { key: 'key-a', bounds: BOUNDS, maximized: false, index: 0 },
      { key: 'key-a', bounds: BOUNDS, maximized: true, index: 1 },
      { key: '', bounds: BOUNDS, maximized: false, index: 2 },
      { key: 'key-b', bounds: { x: 0, y: 0, width: 10, height: 10 }, maximized: false, index: 3 },
      { key: 'key-c', bounds: BOUNDS, maximized: 'yes', index: 4 },
      'not-an-object',
    ]);

    expect(sanitized.map((item) => item.key)).toEqual(['key-a']);
    expect(sanitized[0]).toMatchObject({ key: 'key-a', bounds: BOUNDS, maximized: false, index: 0 });
  });

  it('orders restored windows by index and renumbers them densely', () => {
    const states = windowState.windowStatesFromWindows([
      { key: 'key-b', bounds: BOUNDS, maximized: true, index: 5 },
      { key: 'key-a', bounds: BOUNDS, maximized: false, index: 2 },
      { key: 'key-c', bounds: BOUNDS, maximized: false, index: 9 },
    ]);

    expect(states.map((item) => item.key)).toEqual(['key-a', 'key-b', 'key-c']);
    expect(states.map((item) => item.index)).toEqual([0, 1, 2]);
  });

  it('round-trips through the electron-store schema', () => {
    windowState.saveWindowStates([{ key: 'key-a', bounds: BOUNDS, maximized: true, index: 0 }]);

    expect(windowState.loadWindowStates()).toEqual([
      { key: 'key-a', bounds: BOUNDS, maximized: true, index: 0 },
    ]);
  });

  it('returns an empty list for a missing/corrupt store value', () => {
    expect(windowState.loadWindowStates()).toEqual([]);
    storeState.stores.get('window-state')!.set('windows', 'garbage');
    expect(windowState.loadWindowStates()).toEqual([]);
  });
});
