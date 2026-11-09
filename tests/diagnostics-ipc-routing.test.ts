// 多窗口 P4a：诊断相关的文件对话框必须挂在发起请求的窗口上。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, args?: unknown) => unknown>();
  return {
    handlers,
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: undefined })),
    windows: new Map<number, { id: number; webContents: { id: number } }>(),
    createReport: vi.fn(async () => ({ ok: true })),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

vi.mock('electron', () => ({
  app: { getPath: (name: string) => (name === 'downloads' ? '/downloads' : '/tmp') },
  dialog: { showOpenDialog: state.showOpenDialog, showSaveDialog: state.showSaveDialog },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args?: unknown) => unknown) => {
      state.handlers.set(channel, handler);
    },
  },
}));
vi.mock('electron-log', () => ({ default: state.log }));
vi.mock('../src/main/modules/diagnostics', () => ({ createDiagnosticReport: state.createReport }));
vi.mock('../src/main/modules/ui-language', () => ({ uiText: (zh: string) => zh }));
vi.mock('../src/main/modules/session-recovery', () => ({
  getSessionRecoveryStatus: () => ({ abnormalExit: false }),
  resolveSessionRecovery: vi.fn(),
}));

const { registerDiagnosticsIPC } = await import('../src/main/ipc/diagnostics.ipc');
const { setIpcWindowResolver } = await import('../src/main/utils/ipc-wrapper');

function makeWindow(id: number, webContentsId: number) {
  return { id, webContents: { id: webContentsId } };
}

describe('diagnostics IPC sender routing (P4a)', () => {
  const winA = makeWindow(1, 101);
  const winB = makeWindow(2, 201);

  beforeEach(() => {
    state.handlers.clear();
    state.showOpenDialog.mockClear();
    state.showSaveDialog.mockClear();
    state.windows.clear();
    state.windows.set(winA.webContents.id, winA);
    state.windows.set(winB.webContents.id, winB);
    setIpcWindowResolver((wc: { id: number }) => (state.windows.get(wc.id) as never) ?? null);
    registerDiagnosticsIPC();
  });

  it('parents file:open-swf to the sender window', async () => {
    await state.handlers.get('file:open-swf')!({ sender: { id: winB.webContents.id } });

    expect(state.showOpenDialog).toHaveBeenCalledWith(winB, expect.objectContaining({ properties: ['openFile'] }));
  });

  it('parents diagnostics:export to the sender window', async () => {
    await state.handlers.get('diagnostics:export')!({ sender: { id: winB.webContents.id } });

    expect(state.showSaveDialog).toHaveBeenCalledWith(winB, expect.any(Object));
    expect(state.createReport).not.toHaveBeenCalled();
  });

  it('falls back to a parentless dialog when the sender is unregistered', async () => {
    await state.handlers.get('file:open-swf')!({ sender: { id: 999 } });

    expect(state.showOpenDialog).toHaveBeenCalledTimes(1);
    expect(state.showOpenDialog.mock.calls[0]).toHaveLength(1);
  });
});
