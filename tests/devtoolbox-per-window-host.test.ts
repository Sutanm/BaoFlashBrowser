// 多窗口 P4b（SDD: docs/specs/multi-window-plan.md §6.6 / §7 P4b）
// 内嵌 DevTools 前端容器必须按窗口隔离：两个窗口同时开抽屉互不拆台。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  class FakeView {
    readonly webContents = {
      id: 0,
      send: vi.fn(),
      loadURL: vi.fn().mockResolvedValue(undefined),
      isDestroyed: () => false,
      destroy: vi.fn(),
    };
    readonly setBounds = vi.fn();
    constructor() { FakeView.nextId += 1; this.webContents.id = 500 + FakeView.nextId; }
    static nextId = 0;
  }
  class FakeWindow {
    readonly webContents = { id: 0, send: vi.fn() };
    readonly views: FakeView[] = [];
    readonly addBrowserView = vi.fn((view: FakeView) => { this.views.push(view); });
    readonly removeBrowserView = vi.fn((view: FakeView) => {
      const index = this.views.indexOf(view);
      if (index >= 0) this.views.splice(index, 1);
    });
    private readonly onceHandlers = new Map<string, () => void>();
    constructor(readonly id: number, webContentsId: number) { this.webContents.id = webContentsId; }
    once(event: string, fn: () => void): void { this.onceHandlers.set(event, fn); }
    isDestroyed(): boolean { return false; }
  }
  return {
    FakeView,
    FakeWindow,
    windows: new Map<number, FakeWindow>(),
    bridges: new Map<number, { beginFrontendSession: ReturnType<typeof vi.fn>; attach: ReturnType<typeof vi.fn>; shutdown: ReturnType<typeof vi.fn> }>(),
    reset(): void {
      state.windows.clear();
      state.bridges.clear();
      FakeView.nextId = 0;
    },
  };
});

vi.mock('electron', () => ({
  BrowserView: state.FakeView,
  BrowserWindow: state.FakeWindow,
}));
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../src/main/modules/window', () => ({
  getWindowById: (id: number) => state.windows.get(id) ?? null,
}));
vi.mock('../src/main/modules/devtoolbox-target-resolve', () => ({
  getDevToolsTargetUrl: async (_target: string, _tabId: string | null | undefined, winId: number) => ({
    url: `file:///front.html?win=${winId}`,
    reason: 'ok',
    mode: 'ws',
  }),
}));
vi.mock('../src/main/modules/devtoolbox-targets', () => ({ resolveDebugPort: () => 9333 }));
vi.mock('../src/main/modules/devtoolbox-bridge', () => ({
  getDevToolsBridge: (winId: number) => {
    let bridge = state.bridges.get(winId);
    if (!bridge) {
      bridge = {
        beginFrontendSession: vi.fn(),
        attach: vi.fn().mockResolvedValue({ sessionId: `s-${winId}` }),
        shutdown: vi.fn(),
      };
      state.bridges.set(winId, bridge);
    }
    return bridge;
  },
}));
vi.mock('../src/main/modules/devtoolbox-frontend-server', () => ({ DEVTOOLS_PARTITION: 'persist:devtools' }));

const host = await import('../src/main/modules/devtoolbox-host');

function makeWindow(id: number, webContentsId: number): InstanceType<typeof state.FakeWindow> {
  const win = new state.FakeWindow(id, webContentsId);
  state.windows.set(id, win);
  return win;
}

describe('DevTools host per window (P4b)', () => {
  let winA: InstanceType<typeof state.FakeWindow>;
  let winB: InstanceType<typeof state.FakeWindow>;

  beforeEach(() => {
    state.reset();
    host.resetDevToolsHostsForTest();
    winA = makeWindow(1, 101);
    winB = makeWindow(2, 201);
  });

  it('attaches an independent frontend view to each window', async () => {
    await expect(host.attachDevToolsView(1, 'page')).resolves.toMatchObject({ ok: true });
    await expect(host.attachDevToolsView(2, 'page')).resolves.toMatchObject({ ok: true });

    expect(winA.addBrowserView).toHaveBeenCalledTimes(1);
    expect(winB.addBrowserView).toHaveBeenCalledTimes(1);
    const contentsA = host.getDevToolsFrontendContents(1);
    const contentsB = host.getDevToolsFrontendContents(2);
    expect(contentsA).not.toBeNull();
    expect(contentsB).not.toBeNull();
    expect(contentsA).not.toBe(contentsB);
    expect(winA.views[0].webContents.loadURL).toHaveBeenCalledWith('file:///front.html?win=1');
    expect(winB.views[0].webContents.loadURL).toHaveBeenCalledWith('file:///front.html?win=2');
  });

  it('destroys only the targeted window frontend', async () => {
    await host.attachDevToolsView(1, 'page');
    await host.attachDevToolsView(2, 'page');
    const viewA = winA.views[0];

    host.destroyDevToolsView(1);

    expect(host.getDevToolsFrontendContents(1)).toBeNull();
    expect(host.getDevToolsFrontendContents(2)).not.toBeNull();
    expect(winA.removeBrowserView).toHaveBeenCalledWith(viewA);
    expect(winB.removeBrowserView).not.toHaveBeenCalled();
    expect(viewA.webContents.destroy).toHaveBeenCalled();
  });

  it('routes bounds to the owning window view only', async () => {
    await host.attachDevToolsView(1, 'page');
    await host.attachDevToolsView(2, 'page');
    const viewA = winA.views[0];
    const viewB = winB.views[0];

    host.setDevToolsViewBounds(2, { x: 1.4, y: 2.6, width: 300.2, height: 0 });

    expect(viewB.setBounds).toHaveBeenCalledWith({ x: 1, y: 3, width: 300, height: 1 });
    expect(viewA.setBounds).not.toHaveBeenCalledWith({ x: 1, y: 3, width: 300, height: 1 });
  });

  it('refuses to attach without a registered host window', async () => {
    await expect(host.attachDevToolsView(99, 'page')).resolves.toMatchObject({ ok: false, error: 'no-window' });
  });
});
