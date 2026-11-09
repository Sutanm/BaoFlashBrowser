// 多窗口 P4b：工具箱 IPC 的信任边界与目标实例都必须按 sender 所属窗口解析。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, args?: unknown) => unknown>();
  const listeners = new Map<string, (event: unknown, args?: unknown) => void>();
  const windows = new Map<number, { id: number; webContents: { id: number; send: ReturnType<typeof vi.fn> } }>();
  const frontends = new Map<number, { id: number; isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> }>();
  const bridges = new Map<number, {
    beginFrontendSession: ReturnType<typeof vi.fn>;
    attach: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    detach: ReturnType<typeof vi.fn>;
    rotate: ReturnType<typeof vi.fn>;
    markFrontendReady: ReturnType<typeof vi.fn>;
    getStats: ReturnType<typeof vi.fn>;
    setEventSink: ReturnType<typeof vi.fn>;
    shutdown: ReturnType<typeof vi.fn>;
  }>();
  return {
    handlers,
    listeners,
    windows,
    frontends,
    bridges,
    windowFor: new Map<number, { id: number; webContents: { id: number } }>(),
    attach: vi.fn(async () => ({ ok: true })),
    clear: vi.fn(),
    closeWin: vi.fn(),
    destroy: vi.fn(),
    snapshot: vi.fn(() => ({ entries: [], targets: [], flash: {}, cdpOwner: null, activeTabId: null })),
    getFrontend: (winId: number) => frontends.get(winId) ?? null,
    url: vi.fn(async () => ({ url: 'file:///front.html', reason: 'ok', mode: 'bridge', targetId: 't1' })),
    openWin: vi.fn(async () => ({ ok: true })),
    openNative: vi.fn(() => true),
    probe: vi.fn(async () => null),
    setBounds: vi.fn(),
    resolveTarget: vi.fn(async () => 'target-1'),
    bridgeFor(winId: number) {
      let bridge = bridges.get(winId);
      if (!bridge) {
        bridge = {
          beginFrontendSession: vi.fn(),
          attach: vi.fn().mockResolvedValue({ sessionId: `s-${winId}` }),
          send: vi.fn().mockResolvedValue({ ok: true, result: winId }),
          detach: vi.fn().mockResolvedValue(undefined),
          rotate: vi.fn().mockResolvedValue({ ok: true }),
          markFrontendReady: vi.fn(),
          getStats: vi.fn(() => ({ window: winId })),
          setEventSink: vi.fn(),
          shutdown: vi.fn(),
        };
        bridges.set(winId, bridge);
      }
      return bridge;
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args?: unknown) => unknown) => state.handlers.set(channel, handler),
    on: (channel: string, listener: (event: unknown, args?: unknown) => void) => state.listeners.set(channel, listener),
  },
}));
vi.mock('electron-log', () => ({ default: state.log }));
vi.mock('../src/main/modules/window', () => ({
  getWindowForWebContents: (wc: { id: number }) => state.windowFor.get(wc.id) ?? null,
  getRegisteredWindows: () => [...state.windows.values()],
}));
vi.mock('../src/main/modules/devtoolbox', () => ({
  attachDevToolsView: state.attach,
  clearDevToolEntries: state.clear,
  closeDevToolsWindow: state.closeWin,
  destroyDevToolsView: state.destroy,
  getDevToolSnapshot: state.snapshot,
  getDevToolsFrontendContents: state.getFrontend,
  getDevToolsTargetUrl: state.url,
  openDevToolsWindow: state.openWin,
  openNativeDevTools: state.openNative,
  probeActivePage: state.probe,
  resolveDebugPort: () => 9333,
  resolveTargetId: state.resolveTarget,
  setDevToolsViewBounds: state.setBounds,
}));
vi.mock('../src/main/modules/devtoolbox-bridge', () => ({ getDevToolsBridge: state.bridgeFor }));
vi.mock('../src/main/modules/devtoolbox-workspace', () => ({
  createWorkspaceDirectory: vi.fn(),
  createWorkspaceFile: vi.fn(),
  deleteWorkspacePath: vi.fn(),
  listWorkspaceRoots: vi.fn(() => []),
  moveWorkspacePath: vi.fn(),
  pickWorkspaceRoot: vi.fn(),
  readWorkspaceDirectory: vi.fn(),
  readWorkspaceFile: vi.fn(),
  removeWorkspaceRoot: vi.fn(),
  searchWorkspacePath: vi.fn(),
  setWorkspaceChangeSink: vi.fn(),
  statWorkspacePath: vi.fn(),
  warmWorkspaceIndexes: vi.fn(),
  writeWorkspaceFile: vi.fn(),
}));

const { registerDevToolboxIPC } = await import('../src/main/ipc/devtoolbox.ipc');
const { setIpcWindowResolver } = await import('../src/main/utils/ipc-wrapper');

function makeWindow(id: number, webContentsId: number) {
  const win = {
    id,
    webContents: { id: webContentsId, send: vi.fn() },
    isDestroyed: () => false,
  };
  state.windows.set(id, win);
  state.windowFor.set(webContentsId, win);
  return win;
}

describe('devtoolbox IPC per window (P4b)', () => {
  const winA = makeWindow(1, 101);
  const winB = makeWindow(2, 201);
  const frontendA = { id: 5001, isDestroyed: () => false, send: vi.fn(), webContents: { id: 5001 } };
  const frontendB = { id: 5002, isDestroyed: () => false, send: vi.fn(), webContents: { id: 5002 } };

  beforeEach(() => {
    state.handlers.clear();
    state.listeners.clear();
    state.frontends.clear();
    state.bridges.clear();
    state.frontends.set(1, frontendA as never);
    state.frontends.set(2, frontendB as never);
    // 前端 BrowserView 的宿主窗口：fromWebContents 语义
    state.windowFor.set(frontendA.id, winA);
    state.windowFor.set(frontendB.id, winB);
    state.attach.mockClear();
    state.setBounds.mockClear();
    state.destroy.mockClear();
    setIpcWindowResolver((wc: { id: number }) => (state.windowFor.get(wc.id) as never) ?? null);
    registerDevToolboxIPC();
  });

  it('attaches the drawer to the sender window only', async () => {
    await state.handlers.get('devtoolbox:attach-devtools-view')!({ sender: { id: winB.webContents.id } }, { target: 'page' });

    expect(state.attach).toHaveBeenCalledWith(2, 'page', undefined);
    expect(state.attach).not.toHaveBeenCalledWith(1, expect.anything(), expect.anything());
  });

  it('accepts the window own frontend as a trusted sender and routes bridge-send to its bridge', async () => {
    const result = await state.handlers.get('devtoolbox:bridge-send')!(
      { sender: { id: frontendA.id } },
      { method: 'DOM.getDocument' },
    );

    expect(result).toMatchObject({ ok: true, result: 1 });
    expect(state.bridges.get(1)!.send).toHaveBeenCalledWith('DOM.getDocument', undefined, undefined, undefined);
    expect(state.bridges.get(2)).toBeUndefined();
  });

  it('routes shell-originated bridge calls to the shell window bridge', async () => {
    await state.handlers.get('devtoolbox:bridge-send')!(
      { sender: { id: winB.webContents.id } },
      { method: 'Target.getTargets' },
    );

    expect(state.bridges.get(2)!.send).toHaveBeenCalled();
    expect(state.bridges.get(1)).toBeUndefined();
  });

  it('rejects senders outside any registered window', async () => {
    await expect(state.handlers.get('devtoolbox:bridge-send')!(
      { sender: { id: 999 } },
      { method: 'DOM.getDocument' },
    )).resolves.toMatchObject({ ok: false, error: { message: 'untrusted-sender' } });
  });

  it('trusts an undocked DevTools window frontend for its owner window', async () => {
    // undocked 前端是独立 BrowserWindow：fromWebContents 反查不到宿主窗口，
    // 但它仍然是"窗口 2 的前端容器"。
    const undocked = { id: 6002, isDestroyed: () => false, send: vi.fn(), webContents: { id: 6002 } };
    state.frontends.set(2, undocked as never);

    const result = await state.handlers.get('devtoolbox:bridge-send')!(
      { sender: { id: undocked.id } },
      { method: 'DOM.getDocument' },
    );

    expect(result).toMatchObject({ ok: true, result: 2 });
    expect(state.bridges.get(2)!.send).toHaveBeenCalled();
  });

  it('does not trust window A frontend when it claims window B', async () => {
    // 前端 A 的 wc 在 windowFor 里映射到 A，因此它只可能被解析成 A；
    // 这里验证"另一个窗口的外壳"也不会把 A 的前端当成 B 的前端。
    state.frontends.set(2, { id: frontendA.id, isDestroyed: () => false, send: vi.fn(), webContents: { id: frontendA.id } } as never);
    const result = await state.handlers.get('devtoolbox:bridge-stats')!({ sender: { id: frontendA.id } });
    expect(result).toMatchObject({ window: 1 });
  });

  it('routes sync bounds to the sender window view', () => {
    const event = { sender: { id: winA.webContents.id }, returnValue: undefined };
    state.listeners.get('devtoolbox:set-devtools-bounds-sync')!(event, { x: 1, y: 2, width: 300, height: 200 });

    expect(event.returnValue).toBe(true);
    expect(state.setBounds).toHaveBeenCalledWith(1, { x: 1, y: 2, width: 300, height: 200 });
  });
});
