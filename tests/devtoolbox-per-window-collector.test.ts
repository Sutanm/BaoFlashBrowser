// 多窗口 P4b：控制台采集必须按窗口分桶——两个抽屉不能互相看到对方的页面日志。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  class FakeContents {
    readonly handlers = new Map<string, (...args: unknown[]) => void>();
    readonly send = vi.fn();
    readonly destroy = vi.fn();
    constructor(readonly id: number) {}
    getType(): string { return 'browserView'; }
    getURL(): string { return 'https://game.example/'; }
    isDestroyed(): boolean { return false; }
    on(event: string, fn: (...args: unknown[]) => void): void { this.handlers.set(event, fn); }
    once(): void { /* destroyed hook unused in tests */ }
    emit(event: string, ...args: unknown[]): void { this.handlers.get(event)?.(...args); }
  }
  class FakeWindow {
    readonly webContents: { id: number; send: ReturnType<typeof vi.fn>; isDestroyed: () => boolean };
    constructor(readonly id: number, webContentsId: number) {
      this.webContents = { id: webContentsId, send: vi.fn(), isDestroyed: () => false };
    }
    isDestroyed(): boolean { return false; }
  }
  let nextContentsId = 1000;
  return {
    FakeContents,
    FakeWindow,
    nextContentsId: () => { nextContentsId += 1; return nextContentsId; },
    windowFor: new Map<number, FakeWindow>(),
    windows: new Map<number, FakeWindow>(),
    appOn: new Map<string, (...args: unknown[]) => void>(),
    broadcasts: [] as unknown[],
    reset(): void {
      state.windowFor.clear();
      state.windows.clear();
      state.broadcasts.length = 0;
    },
  };
});

vi.mock('electron', () => ({
  app: { on: (event: string, fn: (...args: unknown[]) => void) => state.appOn.set(event, fn) },
  webContents: { getAllWebContents: () => [] },
}));
vi.mock('electron-log', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    hooks: [] as unknown[],
    transports: { console: { level: 'info' } },
  },
}));
vi.mock('../src/main/modules/window', () => ({
  getWindowForWebContents: (wc: { id: number }) => state.windowFor.get(wc.id) ?? null,
  getWindowById: (id: number) => state.windows.get(id) ?? null,
  broadcastToRegisteredWindows: (channel: string, payload: unknown) => state.broadcasts.push({ channel, payload }),
}));
vi.mock('../src/main/modules/tabs', () => ({
  tabManager: { getTabIdForWebContents: (wcId: number) => (wcId === 2011 ? 'tab-b' : 'tab-a') },
}));
vi.mock('../src/main/modules/devtoolbox-frontend-server', () => ({
  installDevToolsFileGuard: vi.fn(),
  useLegacyHttp: () => true,
}));

const collector = await import('../src/main/modules/devtoolbox-collector');

type TestWindow = { id: number; webContents: { id: number; send: ReturnType<typeof vi.fn>; isDestroyed: () => boolean }; isDestroyed: () => boolean };

function makeWindow(id: number, webContentsId: number): TestWindow {
  const win = new state.FakeWindow(id, webContentsId) as unknown as TestWindow;
  state.windows.set(id, win);
  return win;
}

describe('DevTools collector per window (P4b)', () => {
  let winA: TestWindow;
  let winB: TestWindow;
  let wcA: InstanceType<typeof state.FakeContents>;
  let wcB: InstanceType<typeof state.FakeContents>;

  beforeEach(() => {
    state.reset();
    collector.clearDevToolEntries(1);
    collector.clearDevToolEntries(2);
    vi.useFakeTimers();
    collector.initDevToolbox();
    winA = makeWindow(1, 101);
    winB = makeWindow(2, 201);
    wcA = new state.FakeContents(state.nextContentsId());
    wcB = new state.FakeContents(state.nextContentsId());
    state.windowFor.set(wcA.id, winA as never);
    state.windowFor.set(wcB.id, winB as never);
    for (const wc of [wcA, wcB]) state.appOn.get('web-contents-created')!({}, wc);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps page console entries in the owning window bucket', () => {
    wcA.emit('console-message', {}, 2, 'from A', 1, 'a.js');
    wcB.emit('console-message', {}, 3, 'from B', 2, 'b.js');
    vi.advanceTimersByTime(200);

    const pageEntriesA = collector.getBufferedEntries(1).filter((entry) => entry.source === 'page');
    const pageEntriesB = collector.getBufferedEntries(2).filter((entry) => entry.source === 'page');
    expect(pageEntriesA.map((entry) => entry.text)).toEqual(['from A']);
    expect(pageEntriesB.map((entry) => entry.text)).toEqual(['from B']);
    expect(winA.webContents.send).toHaveBeenCalled();
    expect(winB.webContents.send).toHaveBeenCalled();
    expect(winA.webContents.send.mock.calls.every(([channel]) => channel === 'devtoolbox:entries')).toBe(true);
  });

  it('clears only the requested window bucket', () => {
    wcA.emit('console-message', {}, 1, 'A only', 1, 'a.js');
    wcB.emit('console-message', {}, 1, 'B only', 1, 'b.js');
    vi.advanceTimersByTime(200);

    collector.clearDevToolEntries(1);

    expect(collector.getBufferedEntries(1).filter((entry) => entry.source === 'page')).toEqual([]);
    expect(collector.getBufferedEntries(2).filter((entry) => entry.source === 'page').map((entry) => entry.text)).toEqual(['B only']);
  });

  it('attributes shell console to its own window without a tab id', () => {
    const shellA = new state.FakeContents(winA.webContents.id);
    state.windowFor.set(shellA.id, winA as never);
    state.appOn.get('web-contents-created')!({}, shellA);

    expect(collector.describeContents(shellA as never)).toEqual({ source: 'shell', winId: 1 });
  });
});
