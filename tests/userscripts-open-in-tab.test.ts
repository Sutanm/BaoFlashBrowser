// 多窗口 P4a：GM 的"在新标签页打开"必须开在脚本所在窗口，而不是第一个可见窗口。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const listeners = new Map<string, (event: unknown, args?: unknown) => void>();
  return {
    listeners,
    openInTab: vi.fn(() => true),
    windows: new Map<number, { id: number; webContents: { id: number; send: ReturnType<typeof vi.fn> } }>(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  clipboard: { readText: () => '' },
  ipcMain: {
    handle: vi.fn(),
    on: (channel: string, listener: (event: unknown, args?: unknown) => void) => {
      state.listeners.set(channel, listener);
    },
  },
}));
vi.mock('electron-log', () => ({ default: state.log }));
vi.mock('../src/main/modules/desktop-notification', () => ({ createDesktopNotification: vi.fn() }));
vi.mock('../src/main/modules/userscripts', () => ({
  getUserscriptManager: () => ({ openInTab: state.openInTab }),
  getRequestService: () => null,
  getDownloadService: () => null,
  getBackgroundRuntime: () => null,
  getCookieService: () => null,
  getWebRequestObserver: () => null,
}));
vi.mock('../src/main/modules/window', () => ({
  getWindowForWebContents: (wc: { id: number }) => state.windows.get(wc.id) ?? null,
}));

const { registerUserscriptsIPC } = await import('../src/main/ipc/userscripts.ipc');

function makeWindow(id: number, webContentsId: number) {
  return { id, webContents: { id: webContentsId, send: vi.fn() } };
}

describe('userscript open-in-tab routing (P4a)', () => {
  const winA = makeWindow(1, 101);
  const winB = makeWindow(2, 201);

  beforeEach(() => {
    state.listeners.clear();
    state.openInTab.mockClear();
    winA.webContents.send.mockClear();
    winB.webContents.send.mockClear();
    state.windows.clear();
    state.windows.set(winA.webContents.id, winA);
    state.windows.set(winB.webContents.id, winB);
    registerUserscriptsIPC();
  });

  it('opens the tab in the sender window', () => {
    state.listeners.get('userscript:open-in-tab')!(
      { sender: { id: winB.webContents.id } },
      { scriptId: 's', url: 'https://example.com/game' },
    );

    expect(winB.webContents.send).toHaveBeenCalledWith('userscript:open-tab', { url: 'https://example.com/game' });
    expect(winA.webContents.send).not.toHaveBeenCalled();
  });

  it('does nothing when the sender has no registered window', () => {
    state.listeners.get('userscript:open-in-tab')!(
      { sender: { id: 999 } },
      { scriptId: 's', url: 'https://example.com/game' },
    );

    expect(winA.webContents.send).not.toHaveBeenCalled();
    expect(winB.webContents.send).not.toHaveBeenCalled();
  });
});
