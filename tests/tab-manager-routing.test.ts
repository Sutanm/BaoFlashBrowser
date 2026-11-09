// 多窗口 P3（SDD: docs/specs/multi-window-plan.md §6.2 / §7 P3）
//
// 先于实现写：TabManager 目前是 module-level 单例，事件一律发 getMainWindow()。
// 目标语义：
//   - 一窗口一实例（构造注入 win + preloadPath）
//   - tabId / wcId 全局索引，跨实例唯一
//   - 推送只发所属窗口
//   - 兼容 facade `tabManager` 按 tabId / wcId / 聚焦窗口转发
//   - 窗口销毁时 disposeTabManager 清索引并销毁视图
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  let nextWcId = 1000;
  class FakeWebContents {
    readonly id: number;
    readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    readonly send = vi.fn();
    readonly setZoomFactor = vi.fn();
    readonly setAudioMuted = vi.fn();
    readonly loadURL = vi.fn().mockResolvedValue(undefined);
    readonly destroy = vi.fn();
    readonly session = {};
    url = '';
    destroyed = false;
    constructor() {
      this.id = nextWcId++;
    }
    on(event: string, fn: (...args: unknown[]) => void): this {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const fn of this.handlers.get(event) ?? []) fn(...args);
    }
    getURL(): string { return this.url; }
    isDestroyed(): boolean { return this.destroyed; }
    getOSProcessId(): number { return this.id; }
    canGoBack(): boolean { return false; }
    canGoForward(): boolean { return false; }
    executeJavaScript = vi.fn().mockResolvedValue('');
    isFocused(): boolean { return false; }
    focus = vi.fn();
    stop = vi.fn();
  }

  class FakeBrowserView {
    readonly webContents: FakeWebContents;
    readonly setBounds = vi.fn();
    readonly setAutoResize = vi.fn();
    constructor() {
      this.webContents = new FakeWebContents();
    }
  }

  class FakeWindow {
    readonly id: number;
    readonly webContents = new FakeWebContents();
    readonly views: FakeBrowserView[] = [];
    readonly send = this.webContents.send;
    destroyed = false;
    constructor(id: number) { this.id = id; }
    addBrowserView(view: FakeBrowserView): void { this.views.push(view); }
    removeBrowserView(view: FakeBrowserView): void {
      const index = this.views.indexOf(view);
      if (index >= 0) this.views.splice(index, 1);
    }
    isDestroyed(): boolean { return this.destroyed; }
  }

  return {
    FakeBrowserView,
    FakeWindow,
    windows: [] as FakeWindow[],
    focused: null as FakeWindow | null,
    setupCapture: vi.fn(),
    teardownCapture: vi.fn(),
    fillPasswords: vi.fn().mockResolvedValue({ success: false, filledFields: 0, filledCredentials: 0, usernames: [], reason: 'no-credential' }),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    reset(): void {
      nextWcId = 1000;
      state.windows.length = 0;
      state.focused = null;
      state.setupCapture.mockClear();
      state.teardownCapture.mockClear();
    },
  };
});

vi.mock('electron', () => ({
  BrowserView: state.FakeBrowserView,
  Menu: { buildFromTemplate: () => ({ popup: vi.fn() }) },
}));
vi.mock('electron-log', () => ({ default: state.log }));
vi.mock('../src/main/modules/window', () => ({
  getMainWindow: () => state.focused ?? state.windows[0] ?? null,
  getRegisteredWindows: () => state.windows.filter((win) => !win.isDestroyed()),
  getWindowForWebContents: (wc: { id: number } | null | undefined) => {
    if (!wc) return null;
    return state.windows.find((win) => win.webContents.id === wc.id
      || win.views.some((view) => view.webContents.id === wc.id)) ?? null;
  },
}));
vi.mock('../src/main/modules/session-manager', () => ({ setupSessionOnce: vi.fn() }));
vi.mock('../src/main/modules/ui-language', () => ({ uiText: (zh: string) => zh }));

const tabs = await import('../src/main/modules/tabs');

type FakeWindow = InstanceType<typeof state.FakeWindow>;
type FakeBrowserView = InstanceType<typeof state.FakeBrowserView>;

function makeWindow(id: number): FakeWindow {
  const win = new state.FakeWindow(id);
  state.windows.push(win);
  return win;
}

function viewOf(win: FakeWindow): FakeBrowserView {
  const view = win.views[0];
  if (!view) throw new Error('window has no BrowserView');
  return view;
}

describe('TabManager multi-instance routing (P3)', () => {
  let winA: FakeWindow;
  let winB: FakeWindow;

  beforeEach(() => {
    state.reset();
    tabs.resetTabManagersForTest();
    winA = makeWindow(11);
    winB = makeWindow(22);
    state.focused = winA;
  });

  it('creates one manager per window with global tab and wc indexes', () => {
    const managerA = tabs.createTabManager(winA as never, '/preload.js');
    const managerB = tabs.createTabManager(winB as never, '/preload.js');

    managerA.create('tab-a1', 'https://a.example/');
    managerB.create('tab-b1', 'https://b.example/');

    expect(tabs.findTabManagerByTabId('tab-a1')).toBe(managerA);
    expect(tabs.findTabManagerByTabId('tab-b1')).toBe(managerB);
    expect(tabs.getTabManagerForWindow(winA.id)).toBe(managerA);
    expect(tabs.getTabManagerForWindow(winB.id)).toBe(managerB);
    expect(tabs.getTabManagerForSender(viewOf(winA).webContents as never)).toBe(managerA);
    expect(tabs.getTabManagerForSender(winB.webContents as never)).toBe(managerB);
    expect(tabs.getTabOwnerWindow('tab-a1')).toBe(winA);
    expect(tabs.findTabManagerByTabId('tab-missing')).toBeUndefined();
  });

  it('sends tab events to the owning window only', () => {
    const managerA = tabs.createTabManager(winA as never, '/preload.js');
    const managerB = tabs.createTabManager(winB as never, '/preload.js');
    managerA.create('tab-a1', 'https://a.example/');
    managerB.create('tab-b1', 'https://b.example/');

    viewOf(winA).webContents.emit('page-title-updated', {}, 'A title');
    viewOf(winB).webContents.emit('page-title-updated', {}, 'B title');

    expect(winA.send).toHaveBeenCalledWith('tab:updated', { tabId: 'tab-a1', title: 'A title' });
    expect(winA.send).not.toHaveBeenCalledWith('tab:updated', { tabId: 'tab-b1', title: 'B title' });
    expect(winB.send).toHaveBeenCalledWith('tab:updated', { tabId: 'tab-b1', title: 'B title' });
    expect(winB.send).not.toHaveBeenCalledWith('tab:updated', { tabId: 'tab-a1', title: 'A title' });
  });

  it('unregisters tab and webContents indexes when a tab closes', () => {
    const managerA = tabs.createTabManager(winA as never, '/preload.js');
    managerA.create('tab-a1', 'https://a.example/');
    const wc = viewOf(winA).webContents;

    managerA.close('tab-a1');

    expect(tabs.findTabManagerByTabId('tab-a1')).toBeUndefined();
    expect(tabs.findTabManagerByWebContents(wc.id)).toBeUndefined();
    expect(tabs.findTabManagerByTabId('tab-a1')).not.toBe(managerA);
  });

  it('keeps ownership resolvable for a crashed (view-less) tab', () => {
    const managerA = tabs.createTabManager(winA as never, '/preload.js');
    managerA.create('tab-a1', 'https://a.example/');

    // 非活动标签挂起 = 销毁 BrowserView 但保留 tab 条目（崩溃同构）。
    managerA.suspend('tab-a1');

    expect(tabs.findTabManagerByTabId('tab-a1')).toBe(managerA);
    expect(tabs.getTabOwnerWindow('tab-a1')).toBe(winA);
  });

  it('disposes a manager on window close and forgets its indexes', () => {
    const managerA = tabs.createTabManager(winA as never, '/preload.js');
    const managerB = tabs.createTabManager(winB as never, '/preload.js');
    managerA.create('tab-a1', 'https://a.example/');
    managerB.create('tab-b1', 'https://b.example/');
    const viewA = viewOf(winA);

    tabs.disposeTabManager(winA as never);

    expect(tabs.getTabManagerForWindow(winA.id)).toBeUndefined();
    expect(tabs.findTabManagerByTabId('tab-a1')).toBeUndefined();
    expect(tabs.findTabManagerByWebContents(viewA.webContents.id)).toBeUndefined();
    expect(viewA.webContents.destroy).toHaveBeenCalled();
    expect(tabs.findTabManagerByTabId('tab-b1')).toBe(managerB);
  });

  it('routes facade tab-scoped calls to the owning manager', () => {
    const managerA = tabs.createTabManager(winA as never, '/preload.js');
    const managerB = tabs.createTabManager(winB as never, '/preload.js');
    managerA.create('tab-a1', 'https://a.example/');
    managerB.create('tab-b1', 'https://b.example/');

    tabs.tabManager.close('tab-b1');

    expect(tabs.findTabManagerByTabId('tab-b1')).toBeUndefined();
    expect(tabs.findTabManagerByTabId('tab-a1')).toBe(managerA);
  });

  it('aggregates memory diagnostics and broadcasts password refreshes', () => {
    tabs.configureOptionalTabServices({
      passwords: {
        setupCapture: state.setupCapture,
        teardownCapture: state.teardownCapture,
        fillPasswords: state.fillPasswords,
        getFillCredentialForUrl: () => null,
        isAutoFillEnabled: () => false,
      } as never,
    });
    const managerA = tabs.createTabManager(winA as never, '/preload.js');
    const managerB = tabs.createTabManager(winB as never, '/preload.js');
    managerA.create('tab-a1', 'https://a.example/');
    managerB.create('tab-b1', 'https://b.example/');

    expect(tabs.tabManager.getMemoryDiagnostics().map((item) => item.tabId).sort()).toEqual(['tab-a1', 'tab-b1']);

    tabs.tabManager.refreshPasswordCapture(true);
    expect(state.setupCapture).toHaveBeenCalledTimes(2);
  });

  it('falls back to the focused window for window-scoped facade calls', () => {
    const managerA = tabs.createTabManager(winA as never, '/preload.js');
    const managerB = tabs.createTabManager(winB as never, '/preload.js');
    managerA.create('tab-a1', 'https://a.example/');
    managerB.create('tab-b1', 'https://b.example/');
    managerA.activate('tab-a1');
    managerB.activate('tab-b1');

    state.focused = winB;
    expect(tabs.tabManager.getActiveId()).toBe('tab-b1');
    state.focused = winA;
    expect(tabs.tabManager.getActiveId()).toBe('tab-a1');
  });

  it('is idempotent per window (no duplicate manager for the same window)', () => {
    const first = tabs.createTabManager(winA as never, '/preload.js');
    const second = tabs.createTabManager(winA as never, '/preload.js');
    expect(second).toBe(first);
    expect(tabs.getTabManagerForWindow(winA.id)).toBe(first);
  });
});
