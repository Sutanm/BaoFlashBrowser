// 多窗口 P4a（SDD: docs/specs/multi-window-plan.md §6.6）
// 快捷键必须发给事件来源窗口；zoom 的 globalShortcut 兜底按窗口 focus 注册。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  class Emitter {
    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    on(event: string, fn: (...args: unknown[]) => void): this {
      const list = this.listeners.get(event) ?? [];
      list.push(fn);
      this.listeners.set(event, list);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const fn of [...(this.listeners.get(event) ?? [])]) fn(...args);
    }
  }
  class FakeWindow extends Emitter {
    readonly id: number;
    readonly webContents = { id: 0, send: vi.fn() };
    focused = false;
    constructor(id: number) { super(); this.id = id; this.webContents.id = id + 100; }
    isDestroyed(): boolean { return false; }
    isFocused(): boolean { return this.focused; }
  }
  return {
    FakeWindow,
    register: vi.fn(),
    unregister: vi.fn(),
    isRegistered: vi.fn(() => false),
    owners: new Map<number, FakeWindow>(),
    windows: [] as FakeWindow[],
    focused: null as FakeWindow | null,
  };
});

vi.mock('electron', () => ({
  globalShortcut: {
    register: state.register,
    unregister: state.unregister,
    isRegistered: state.isRegistered,
  },
  app: { on: vi.fn() },
}));
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../src/main/modules/window', () => ({
  getWindowForWebContents: (wc: { id: number }) => state.owners.get(wc.id) ?? null,
  getFocusedRegisteredWindow: () => state.focused,
  getRegisteredWindows: () => state.windows.filter((win) => !win.isDestroyed()),
}));

const { handleWebviewBeforeInputEvent, registerZoomShortcutsForWindow } = await import('../src/main/ipc/shortcut.ipc');

function key(key: string, extra: Record<string, unknown> = {}) {
  return { type: 'keyDown', key, control: false, shift: false, alt: false, meta: false, ...extra };
}

function press(keyboard: Record<string, unknown>, wc: { id: number }) {
  const event = { preventDefault: vi.fn() };
  handleWebviewBeforeInputEvent(event as never, keyboard as never, wc as never);
  return event;
}

describe('shortcut routing (P4a)', () => {
  beforeEach(() => {
    state.owners.clear();
    state.windows = [];
    state.focused = null;
    state.register.mockClear();
    state.unregister.mockClear();
  });

  it('sends the action to the window that produced the input', () => {
    const winA = new state.FakeWindow(1);
    const winB = new state.FakeWindow(2);
    state.owners.set(winA.webContents.id, winA);
    state.owners.set(winB.webContents.id, winB);

    press(key('t', { control: true }), winB.webContents);

    expect(winB.webContents.send).toHaveBeenCalledWith('shortcut', 'new-tab');
    expect(winA.webContents.send).not.toHaveBeenCalled();
  });

  it('still prevents default but sends nothing for unregistered senders', () => {
    const event = press(key('t', { control: true }), { id: 999 });
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('routes ctrl+wheel zoom to the source window', () => {
    const winA = new state.FakeWindow(1);
    state.owners.set(winA.webContents.id, winA);

    press({ type: 'mouseWheel', key: '', control: true, shift: false, alt: false, deltaY: -5 }, winA.webContents);

    expect(winA.webContents.send).toHaveBeenCalledWith('shortcut', 'zoom-in');
  });

  it('registers the global zoom fallback only while a window is focused, once per window', () => {
    const winA = new state.FakeWindow(1);
    const winB = new state.FakeWindow(2);
    registerZoomShortcutsForWindow(winA as never);
    registerZoomShortcutsForWindow(winA as never);
    registerZoomShortcutsForWindow(winB as never);

    winA.focused = true;
    winA.emit('focus');
    expect(state.register.mock.calls.filter(([accel]) => accel === 'CommandOrControl+=').length).toBe(1);
    expect(state.register).toHaveBeenCalledTimes(6);

    winA.focused = false;
    winA.emit('blur');
    expect(state.unregister).toHaveBeenCalledWith('CommandOrControl+=');

    winB.focused = true;
    winB.emit('focus');
    expect(state.register).toHaveBeenCalledTimes(12);
  });
});
