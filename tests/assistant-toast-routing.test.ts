// 多窗口 P4a：自动化助手的地址栏提示必须发到"该标签所属窗口"。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, args?: unknown) => unknown>();
  return {
    handlers,
    windows: new Map<number, { id: number; webContents: { id: number; send: ReturnType<typeof vi.fn> } }>(),
    tabOwners: new Map<string, { id: number; webContents: { id: number; send: ReturnType<typeof vi.fn> } }>(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args?: unknown) => unknown) => {
      state.handlers.set(channel, handler);
    },
  },
}));
vi.mock('electron-log', () => ({ default: state.log }));
vi.mock('../src/main/modules/automation/service-v3', () => ({ getAutomationV3Service: () => null }));
vi.mock('../src/main/modules/automation/game-surface-detector', () => ({ detectGameSurfaces: vi.fn() }));
vi.mock('../src/main/modules/tabs', () => ({
  tabManager: {
    getTabIdForWebContents: (wcId: number) => (wcId === 101 ? 'tab-a' : wcId === 201 ? 'tab-b' : null),
  },
  getTabOwnerWindow: (tabId: string) => state.tabOwners.get(tabId) ?? null,
}));

const { registerAutomationAssistantBridge } = await import('../src/main/ipc/automation-assistant-bridge');
const PREFIX = 'userscript:automation-v3-';

function makeWindow(id: number, webContentsId: number) {
  return { id, webContents: { id: webContentsId, send: vi.fn() }, isDestroyed: () => false };
}

describe('automation assistant toast routing (P4a)', () => {
  const winA = makeWindow(1, 101);
  const winB = makeWindow(2, 201);

  beforeEach(() => {
    state.handlers.clear();
    winA.webContents.send.mockClear();
    winB.webContents.send.mockClear();
    state.tabOwners.clear();
    state.tabOwners.set('tab-a', winA);
    state.tabOwners.set('tab-b', winB);
    registerAutomationAssistantBridge(PREFIX, () => true);
  });

  it('sends the toast to the window that owns the calling tab', async () => {
    await expect(state.handlers.get(PREFIX + 'toast')!(
      { sender: { id: 201 } },
      { scriptId: 's', message: 'hello', type: 'warning' },
    )).resolves.toEqual({ success: true });

    expect(winB.webContents.send).toHaveBeenCalledWith('ui:toast', { message: 'hello', type: 'warning' });
    expect(winA.webContents.send).not.toHaveBeenCalled();
  });

  it('rejects a sender that is not allowed to use the bridge', async () => {
    registerAutomationAssistantBridge(PREFIX, () => false);
    await expect(state.handlers.get(PREFIX + 'toast')!(
      { sender: { id: 201 } },
      { scriptId: 's', message: 'hello' },
    )).resolves.toEqual({ success: false });
    expect(winB.webContents.send).not.toHaveBeenCalled();
  });
});
