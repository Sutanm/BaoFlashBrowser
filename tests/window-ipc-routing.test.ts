// 多窗口 P2（SDD: docs/specs/multi-window-plan.md §6.3 / §7 P2）
//
// 先于实现写：window.ipc 目前全部走一个 provider（单窗口），既没有
// win:get-context，也没有 win:new-window。目标语义：
//   - 每个 win:* 通道按 event.sender 路由到该 sender 所属窗口
//   - 未注册 sender 一律拒绝
//   - win:get-context 返回 windowKey/index/isPrimary/isMaximized/bounds
//   - win:new-window 创建新窗口并返回 windowKey
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, args?: unknown) => unknown>();
  const windowsBySender = new Map<number, unknown>();
  const created = { id: 900, webContents: { id: 9000 } };
  return {
    handlers,
    windowsBySender,
    created,
    createWindow: vi.fn(() => created),
    getWindowKey: vi.fn(() => 'wk-new'),
    getWindowContext: vi.fn((win: { id: number }) => (
      win.id === 1
        ? { windowKey: 'wk-a', index: 0, isPrimary: true }
        : { windowKey: 'wk-b', index: 1, isPrimary: false }
    )),
    recoveryStatus: vi.fn(() => ({ abnormalExit: false })),
    resolveRecovery: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args?: unknown) => unknown) => {
      state.handlers.set(channel, handler);
    },
  },
}));
vi.mock('electron-log', () => ({ default: { error: state.error, warn: state.warn, info: vi.fn() } }));
vi.mock('../src/main/modules/window', () => ({
  createWindow: state.createWindow,
  getWindowKey: state.getWindowKey,
  getWindowContext: state.getWindowContext,
}));
vi.mock('../src/main/modules/session-recovery', () => ({
  getSessionRecoveryStatus: state.recoveryStatus,
  resolveSessionRecovery: state.resolveRecovery,
}));

const { registerWindowIPC } = await import('../src/main/ipc/window.ipc');
const { setIpcWindowResolver } = await import('../src/main/utils/ipc-wrapper');

interface FakeWindow {
  id: number;
  webContents: { id: number };
  minimize: ReturnType<typeof vi.fn>;
  maximize: ReturnType<typeof vi.fn>;
  unmaximize: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  setFullScreen: ReturnType<typeof vi.fn>;
  isFullScreen: ReturnType<typeof vi.fn>;
  isMaximized: ReturnType<typeof vi.fn>;
  getBounds: ReturnType<typeof vi.fn>;
}

function makeWindow(id: number, webContentsId: number, maximized = false): FakeWindow {
  return {
    id,
    webContents: { id: webContentsId },
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    close: vi.fn(),
    setFullScreen: vi.fn(),
    isFullScreen: vi.fn(() => false),
    isMaximized: vi.fn(() => maximized),
    getBounds: vi.fn(() => ({ x: 10, y: 20, width: 1000, height: 700 })),
  };
}

function senderFor(win: FakeWindow): { sender: { id: number } } {
  return { sender: { id: win.webContents.id } };
}

describe('window IPC routing (P2)', () => {
  let winA: FakeWindow;
  let winB: FakeWindow;

  beforeEach(() => {
    winA = makeWindow(1, 101, true);
    winB = makeWindow(2, 201, false);
    state.handlers.clear();
    state.windowsBySender.clear();
    state.windowsBySender.set(winA.webContents.id, winA);
    state.windowsBySender.set(winB.webContents.id, winB);
    state.error.mockClear();
    state.createWindow.mockClear();
    state.getWindowKey.mockClear();
    setIpcWindowResolver((wc: { id: number }) => (state.windowsBySender.get(wc.id) as never) ?? null);
    registerWindowIPC();
  });

  it('routes each window channel to the sender window, never the focused one', async () => {
    await state.handlers.get('win:minimize')!(senderFor(winB));
    await state.handlers.get('win:maximize')!(senderFor(winA));
    expect(winB.minimize).toHaveBeenCalledTimes(1);
    expect(winA.minimize).not.toHaveBeenCalled();
    expect(winA.maximize).toHaveBeenCalledTimes(1);
    expect(winB.maximize).not.toHaveBeenCalled();
  });

  it('answers isMaximized from the sender window', async () => {
    await expect(state.handlers.get('win:isMaximized')!(senderFor(winA))).resolves.toBe(true);
    await expect(state.handlers.get('win:isMaximized')!(senderFor(winB))).resolves.toBe(false);
  });

  it('returns window context for the sender', async () => {
    await expect(state.handlers.get('win:get-context')!(senderFor(winB))).resolves.toEqual({
      windowKey: 'wk-b',
      index: 1,
      isPrimary: false,
      isMaximized: false,
      bounds: { x: 10, y: 20, width: 1000, height: 700 },
    });
  });

  it('rejects unregistered senders without touching any window', async () => {
    await expect(state.handlers.get('win:minimize')!({ sender: { id: 999 } })).rejects.toThrow('not a registered window');
    await expect(state.handlers.get('win:get-context')!({ sender: { id: 999 } })).rejects.toThrow('not a registered window');
    expect(winA.minimize).not.toHaveBeenCalled();
    expect(winB.minimize).not.toHaveBeenCalled();
  });

  it('creates a new window for win:new-window and returns its key', async () => {
    const result = await state.handlers.get('win:new-window')!(senderFor(winA), {
      bounds: { x: 300, y: 200, width: 900, height: 600 },
    });

    expect(result).toEqual({ windowKey: 'wk-new' });
    expect(state.createWindow).toHaveBeenCalledWith({
      bounds: { x: 300, y: 200, width: 900, height: 600 },
    });
  });

  it('accepts win:new-window without a payload', async () => {
    const result = await state.handlers.get('win:new-window')!(senderFor(winA), undefined);
    expect(result).toEqual({ windowKey: 'wk-new' });
    expect(state.createWindow).toHaveBeenCalledWith({ bounds: undefined });
  });
});
