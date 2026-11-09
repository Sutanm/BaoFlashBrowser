// 多窗口 P4a（SDD: docs/specs/multi-window-plan.md §6.6 / §7 P4a）
//
// screenshot IPC 的窗口作用域通道必须按 sender 定位：
//   - capture-active 取 sender 窗口的活动标签，而不是"聚焦窗口"
//   - set-dir 的目录选择框挂在 sender 窗口上
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, args?: unknown) => unknown>();
  return {
    handlers,
    captureTab: vi.fn(async () => ({ success: true, width: 1, height: 1 })),
    getScreenshotDir: vi.fn(() => '/shots'),
    saveConfig: vi.fn(),
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
    windows: new Map<number, { id: number; webContents: { id: number } }>(),
    managers: new Map<number, { getActiveId: () => string | null }>(),
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  };
});

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/userData' },
  BrowserWindow: class {},
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args?: unknown) => unknown) => {
      state.handlers.set(channel, handler);
    },
  },
  dialog: { showOpenDialog: state.showOpenDialog },
  shell: { showItemInFolder: vi.fn() },
}));
vi.mock('electron-log', () => ({ default: { error: state.error, warn: state.warn, info: state.info, debug: vi.fn() } }));
vi.mock('../src/main/modules/screenshot', () => ({
  captureTab: state.captureTab,
  getScreenshotDir: state.getScreenshotDir,
}));
vi.mock('../src/main/modules/config', () => ({ saveConfig: state.saveConfig }));
vi.mock('../src/main/modules/tabs', () => ({
  tabManager: {},
  getTabManagerForSender: (wc: { id: number }) => state.managers.get(wc.id),
}));

const { registerScreenshotIPC } = await import('../src/main/ipc/screenshot.ipc');
const { setIpcWindowResolver } = await import('../src/main/utils/ipc-wrapper');

function makeWindow(id: number, webContentsId: number) {
  return { id, webContents: { id: webContentsId }, isDestroyed: () => false };
}

describe('screenshot IPC sender routing (P4a)', () => {
  const winA = makeWindow(1, 101);
  const winB = makeWindow(2, 201);

  beforeEach(() => {
    state.handlers.clear();
    state.windows.clear();
    state.managers.clear();
    state.captureTab.mockClear();
    state.showOpenDialog.mockClear();
    state.saveConfig.mockClear();
    state.windows.set(winA.webContents.id, winA);
    state.windows.set(winB.webContents.id, winB);
    setIpcWindowResolver((wc: { id: number }) => (state.windows.get(wc.id) as never) ?? null);
    registerScreenshotIPC();
  });

  it('captures the active tab of the sender window', async () => {
    state.managers.set(winB.webContents.id, { getActiveId: () => 'tab-b' });

    await state.handlers.get('screenshot:capture-active')!({ sender: { id: winB.webContents.id } }, { save: true });

    expect(state.captureTab).toHaveBeenCalledWith('tab-b', { save: true });
  });

  it('reports NO_ACTIVE_TAB instead of borrowing another window', async () => {
    state.managers.set(winA.webContents.id, { getActiveId: () => 'tab-a' });

    await expect(state.handlers.get('screenshot:capture-active')!({ sender: { id: winB.webContents.id } }, {}))
      .resolves.toMatchObject({ success: false, code: 'NO_ACTIVE_TAB' });
    expect(state.captureTab).not.toHaveBeenCalled();
  });

  it('parents the directory dialog to the sender window', async () => {
    await state.handlers.get('screenshot:set-dir')!({ sender: { id: winB.webContents.id } }, { title: 'pick' });

    expect(state.showOpenDialog).toHaveBeenCalledWith(winB, expect.objectContaining({ title: 'pick' }));
  });

  it('refuses set-dir without a registered sender window', async () => {
    await expect(state.handlers.get('screenshot:set-dir')!({ sender: { id: 999 } }, {}))
      .resolves.toMatchObject({ success: false, code: 'NO_WINDOW' });
    expect(state.showOpenDialog).not.toHaveBeenCalled();
  });
});
