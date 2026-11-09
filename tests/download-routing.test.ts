// 多窗口 P4a：下载目录弹窗必须挂在发起请求的窗口上。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, args?: unknown) => unknown>();
  return {
    handlers,
    showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ['/downloads'] })),
    saveConfig: vi.fn(),
    windows: new Map<number, { id: number; webContents: { id: number } }>(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

vi.mock('electron', () => ({
  BrowserWindow: class {},
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args?: unknown) => unknown) => {
      state.handlers.set(channel, handler);
    },
    on: vi.fn(),
  },
  dialog: { showOpenDialog: state.showOpenDialog },
  shell: { openPath: vi.fn() },
  session: {},
}));
vi.mock('electron-log', () => ({ default: state.log }));
vi.mock('../src/main/modules/download', () => ({
  cancelDownload: vi.fn(),
  pauseDownload: vi.fn(),
  resumeDownload: vi.fn(),
  getAria2Status: vi.fn(() => null),
  getDownloadDir: vi.fn(() => '/downloads'),
}));
vi.mock('../src/main/modules/download-state', () => ({
  clearFinishedDownloadRecords: vi.fn(),
  getDownloadRecords: vi.fn(() => []),
  removeDownloadRecord: vi.fn(),
}));
vi.mock('../src/main/modules/config', () => ({ saveConfig: state.saveConfig }));
vi.mock('../src/main/modules/window', () => ({ getMainWindow: () => null }));

const { registerDownloadIPC } = await import('../src/main/ipc/download.ipc');
const { setIpcWindowResolver } = await import('../src/main/utils/ipc-wrapper');

function makeWindow(id: number, webContentsId: number) {
  return { id, webContents: { id: webContentsId }, isDestroyed: () => false };
}

describe('download IPC sender routing (P4a)', () => {
  const winA = makeWindow(1, 101);
  const winB = makeWindow(2, 201);

  beforeEach(() => {
    state.handlers.clear();
    state.showOpenDialog.mockClear();
    state.saveConfig.mockClear();
    state.windows.clear();
    state.windows.set(winA.webContents.id, winA);
    state.windows.set(winB.webContents.id, winB);
    setIpcWindowResolver((wc: { id: number }) => (state.windows.get(wc.id) as never) ?? null);
    registerDownloadIPC();
  });

  it('parents download:set-dir to the sender window', async () => {
    const result = await state.handlers.get('download:set-dir')!({ sender: { id: winB.webContents.id } }, { title: 'pick' });

    expect(result).toBe('/downloads');
    expect(state.showOpenDialog).toHaveBeenCalledWith(winB, expect.objectContaining({ title: 'pick' }));
    expect(state.saveConfig).toHaveBeenCalledWith({ downloadDir: '/downloads' });
  });

  it('returns null without opening a dialog when the sender has no window', async () => {
    await expect(state.handlers.get('download:set-dir')!({ sender: { id: 999 } }, {}))
      .resolves.toBeNull();
    expect(state.showOpenDialog).not.toHaveBeenCalled();
  });
});
