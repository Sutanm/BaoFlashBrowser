// 多窗口 P1（SDD: docs/specs/multi-window-plan.md §6.1 / §7 P1）
//
// 这些测试先于实现写：window.ts 目前只有单例 mainWindow，全部断言预期失败。
// 目标语义：
//   - 显式注册表，按 index 稳定排序，首个窗口 isPrimary
//   - windowKey 跨重启可由 options 指定，否则生成稳定随机 key
//   - getMainWindow() 退化为 shim：最近聚焦 → 首个注册窗口
//   - 关闭单个窗口不标记 clean shutdown（teardown 已上移到 before-quit）
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  class Emitter {
    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

    on(event: string, fn: (...args: unknown[]) => void): this {
      const list = this.listeners.get(event) ?? [];
      list.push(fn);
      this.listeners.set(event, list);
      return this;
    }

    once(event: string, fn: (...args: unknown[]) => void): this {
      const wrapped = (...args: unknown[]): void => {
        this.off(event, wrapped);
        fn(...args);
      };
      return this.on(event, wrapped);
    }

    off(event: string, fn: (...args: unknown[]) => void): this {
      const list = this.listeners.get(event) ?? [];
      this.listeners.set(event, list.filter((item) => item !== fn));
      return this;
    }

    emit(event: string, ...args: unknown[]): boolean {
      for (const fn of [...(this.listeners.get(event) ?? [])]) fn(...args);
      return true;
    }
  }
  class FakeWebContents {
    readonly id: number;
    readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    destroyed = false;
    readonly executeJavaScript = vi.fn().mockResolvedValue(undefined);
    readonly send = vi.fn();
    private readonly url = '';

    constructor(id: number) {
      this.id = id;
    }

    on(event: string, fn: (...args: unknown[]) => void): this {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
      return this;
    }

    once(event: string, fn: (...args: unknown[]) => void): this {
      return this.on(event, fn);
    }

    emit(event: string, ...args: unknown[]): boolean {
      for (const fn of this.handlers.get(event) ?? []) fn(...args);
      return true;
    }

    getURL(): string {
      return this.url;
    }

    isDestroyed(): boolean {
      return this.destroyed;
    }
  }

  class FakeBrowserWindow extends Emitter {
    static nextWindowId = 1;
    static nextWebContentsId = 100;
    static readonly windows: FakeBrowserWindow[] = [];
    /** BrowserView webContents id → 宿主窗口，模拟 Electron 11 的 fromWebContents 行为。 */
    static readonly viewOwners = new Map<number, FakeBrowserWindow>();

    static fromWebContents(wc: { id: number } | null): FakeBrowserWindow | null {
      if (!wc) return null;
      const direct = FakeBrowserWindow.windows.find((win) => win.webContents.id === wc.id);
      if (direct) return direct;
      return FakeBrowserWindow.viewOwners.get(wc.id) ?? null;
    }

    static reset(): void {
      FakeBrowserWindow.windows.length = 0;
      FakeBrowserWindow.viewOwners.clear();
      FakeBrowserWindow.nextWindowId = 1;
      FakeBrowserWindow.nextWebContentsId = 100;
    }

    readonly id: number;
    readonly webContents: FakeWebContents;
    readonly options: Record<string, unknown>;
    readonly loadFile = vi.fn().mockResolvedValue(undefined);
    readonly loadURL = vi.fn().mockResolvedValue(undefined);
    readonly setMenu = vi.fn();
    readonly setIcon = vi.fn();
    readonly show = vi.fn();
    readonly reload = vi.fn();
    readonly focus = vi.fn();
    readonly restore = vi.fn();
    readonly getBounds = vi.fn(() => ({ x: 0, y: 0, width: 1280, height: 800 }));
    destroyed = false;
    private visible = false;

    constructor(options: Record<string, unknown>) {
      super();
      this.id = FakeBrowserWindow.nextWindowId;
      FakeBrowserWindow.nextWindowId += 1;
      this.options = options;
      this.webContents = new FakeWebContents(FakeBrowserWindow.nextWebContentsId);
      FakeBrowserWindow.nextWebContentsId += 1;
      FakeBrowserWindow.windows.push(this);
    }

    isDestroyed(): boolean {
      return this.destroyed;
    }

    isVisible(): boolean {
      return this.visible;
    }

    isMinimized(): boolean {
      return false;
    }
  }

  return {
    FakeBrowserWindow,
    markCleanShutdown: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: harness.FakeBrowserWindow,
}));
vi.mock('electron-log', () => ({ default: harness.log }));
vi.mock('../src/main/modules/session-recovery', () => ({
  markCleanShutdown: harness.markCleanShutdown,
}));

async function loadWindowModule(): Promise<typeof import('../src/main/modules/window')> {
  vi.resetModules();
  return import('../src/main/modules/window');
}

describe('window registry (P1)', () => {
  beforeEach(() => {
    harness.FakeBrowserWindow.reset();
    harness.markCleanShutdown.mockClear();
  });

  it('registers the first window as primary with a stable generated key', async () => {
    const windows = await loadWindowModule();
    const win = windows.createWindow();

    expect(windows.getRegisteredWindows()).toEqual([win]);
    expect(windows.getWindowKey(win)).toMatch(/^[0-9a-f]{18}$/);
    expect(windows.getWindowContext(win)).toEqual({
      windowKey: windows.getWindowKey(win),
      index: 0,
      isPrimary: true,
    });
    expect(windows.getMainWindow()).toBe(win);
    expect(windows.getWindowById(win.id)).toBe(win);
  });

  it('assigns ordered indexes, distinct keys and a single primary window', async () => {
    const windows = await loadWindowModule();
    const first = windows.createWindow();
    const second = windows.createWindow();

    expect(windows.getRegisteredWindows()).toEqual([first, second]);
    expect(windows.getWindowKey(first)).not.toBe(windows.getWindowKey(second));
    expect(windows.getWindowContext(first)?.isPrimary).toBe(true);
    expect(windows.getWindowContext(second)).toMatchObject({ index: 1, isPrimary: false });
  });

  it('follows focus and falls back to the first registered window', async () => {
    const windows = await loadWindowModule();
    const first = windows.createWindow();
    const second = windows.createWindow();
    expect(windows.getFocusedRegisteredWindow()).toBe(first);

    second.emit('focus');
    expect(windows.getFocusedRegisteredWindow()).toBe(second);
    expect(windows.getMainWindow()).toBe(second);

    first.emit('focus');
    expect(windows.getMainWindow()).toBe(first);

    first.destroyed = true;
    // 失焦/销毁的窗口不得再被当作主窗口，回退到仍然存活的注册窗口。
    expect(windows.getMainWindow()).toBe(second);
  });

  it('removes a closed window from the registry without marking a clean shutdown', async () => {
    const windows = await loadWindowModule();
    const first = windows.createWindow();
    const second = windows.createWindow();

    first.destroyed = true;
    first.emit('closed');

    expect(windows.getRegisteredWindows()).toEqual([second]);
    expect(windows.getWindowById(first.id)).toBeNull();
    expect(windows.getMainWindow()).toBe(second);
    expect(harness.markCleanShutdown).not.toHaveBeenCalled();
  });

  it('resolves the owning window from shell and BrowserView webContents', async () => {
    const windows = await loadWindowModule();
    const win = windows.createWindow();
    const viewWebContents = { id: 9001 };
    harness.FakeBrowserWindow.viewOwners.set(viewWebContents.id, win);

    expect(windows.getWindowForWebContents(win.webContents as never)).toBe(win);
    expect(windows.getWindowForWebContents(viewWebContents as never)).toBe(win);

    const hiddenWindow = new harness.FakeBrowserWindow({});
    expect(windows.getWindowForWebContents(hiddenWindow.webContents as never)).toBeNull();
    expect(windows.getWindowForWebContents({ id: 123456 } as never)).toBeNull();
    expect(windows.getWindowForWebContents(null)).toBeNull();
  });

  it('uses restored bounds and window key when provided', async () => {
    const windows = await loadWindowModule();
    const win = windows.createWindow({
      bounds: { x: 120, y: 80, width: 1000, height: 700 },
      windowKey: 'restored-key',
      index: 2,
      isPrimary: false,
    });

    expect(win.options).toMatchObject({ x: 120, y: 80, width: 1000, height: 700 });
    expect(windows.getWindowKey(win)).toBe('restored-key');
    expect(windows.getWindowContext(win)).toMatchObject({ index: 2, isPrimary: false });
  });

  it('notifies creation listeners so index.ts can bind per-window host events', async () => {
    const windows = await loadWindowModule();
    const seen: Array<unknown> = [];
    const unsubscribe = windows.onWindowCreated((win) => seen.push(win));

    const first = windows.createWindow();
    unsubscribe();
    windows.createWindow();

    expect(seen).toEqual([first]);
  });
});
