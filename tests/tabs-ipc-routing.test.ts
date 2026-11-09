// 多窗口 P2（SDD: docs/specs/multi-window-plan.md §6.3 / §7 P2）
//
// 先于实现写：tabs.ipc 目前一律直调全局 tabManager。目标语义：
//   - tab:create / tab:setBounds / tab:focusActive 按 event.sender 解析实例
//   - 其余 tabId 通道校验"归属窗口 == sender 窗口"，越窗拒绝并记日志
//   - 未知 tabId 保持既有 no-op 语义（崩溃恢复/关闭竞态不能被抛错打断）
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const invokeHandlers = new Map<string, (event: unknown, args?: unknown) => unknown>();
  const listeners = new Map<string, (event: unknown, args?: unknown) => void>();
  const managersBySender = new Map<number, FakeManager>();
  const managersByTab = new Map<string, FakeManager>();
  const ownerWindows = new Map<string, unknown>();
  return {
    invokeHandlers,
    listeners,
    managersBySender,
    managersByTab,
    ownerWindows,
    notifyPasswordFormDetected: vi.fn(),
    getRuffleForWC: vi.fn(() => null),
    warn: vi.fn(),
    error: vi.fn(),
    makeManager(): FakeManager {
      return {
        create: vi.fn(),
        close: vi.fn(),
        suspend: vi.fn(),
        activate: vi.fn(),
        focusActive: vi.fn(() => true),
        navigate: vi.fn(),
        goBack: vi.fn(),
        goForward: vi.fn(),
        reload: vi.fn(),
        stop: vi.fn(),
        setZoom: vi.fn(),
        setMuted: vi.fn(),
        openDevTools: vi.fn(),
        findInPage: vi.fn(),
        stopFindInPage: vi.fn(),
        setBounds: vi.fn(),
        setRuffleMode: vi.fn(),
      };
    },
  };
});

interface FakeManager {
  create: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  suspend: ReturnType<typeof vi.fn>;
  activate: ReturnType<typeof vi.fn>;
  focusActive: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
  goBack: ReturnType<typeof vi.fn>;
  goForward: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  setZoom: ReturnType<typeof vi.fn>;
  setMuted: ReturnType<typeof vi.fn>;
  openDevTools: ReturnType<typeof vi.fn>;
  findInPage: ReturnType<typeof vi.fn>;
  stopFindInPage: ReturnType<typeof vi.fn>;
  setBounds: ReturnType<typeof vi.fn>;
  setRuffleMode: ReturnType<typeof vi.fn>;
}

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args?: unknown) => unknown) => {
      state.invokeHandlers.set(channel, handler);
    },
    on: (channel: string, listener: (event: unknown, args?: unknown) => void) => {
      state.listeners.set(channel, listener);
    },
  },
}));
vi.mock('electron-log', () => ({ default: { error: state.error, warn: state.warn, info: vi.fn(), debug: vi.fn() } }));
vi.mock('../src/main/modules/tabs', () => ({
  tabManager: {
    notifyPasswordFormDetected: state.notifyPasswordFormDetected,
    getRuffleForWC: state.getRuffleForWC,
  },
  getTabManagerForSender: (wc: { id: number }) => state.managersBySender.get(wc.id),
  getTabManagerForTabId: (tabId: string) => state.managersByTab.get(tabId),
  getTabOwnerWindow: (tabId: string) => state.ownerWindows.get(tabId) ?? null,
}));
vi.mock('../src/main/modules/ruffle-bundle', () => ({
  ruffleBundleInfo: () => null,
  ruffleJsContent: () => '',
}));

const { registerTabsIPC } = await import('../src/main/ipc/tabs.ipc');
const { setIpcWindowResolver } = await import('../src/main/utils/ipc-wrapper');

function makeWindow(id: number, webContentsId: number): { id: number; webContents: { id: number } } {
  return { id, webContents: { id: webContentsId } };
}

describe('tabs IPC routing (P2)', () => {
  const winA = makeWindow(1, 101);
  const winB = makeWindow(2, 201);
  const managerA = state.makeManager();
  const managerB = state.makeManager();

  beforeEach(() => {
    state.invokeHandlers.clear();
    state.listeners.clear();
    state.managersBySender.clear();
    state.managersByTab.clear();
    state.ownerWindows.clear();
    state.warn.mockClear();
    for (const manager of [managerA, managerB]) {
      for (const fn of Object.values(manager)) fn.mockClear();
    }
    state.managersBySender.set(winA.webContents.id, managerA);
    state.managersBySender.set(winB.webContents.id, managerB);
    setIpcWindowResolver((wc: { id: number }) => (
      wc.id === winA.webContents.id ? winA as never : wc.id === winB.webContents.id ? winB as never : null
    ));
    registerTabsIPC();
  });

  it('creates a tab on the manager of the sender window', async () => {
    await state.invokeHandlers.get('tab:create')!(
      { sender: { id: winB.webContents.id } },
      { tabId: 'tab-b1', url: 'https://example.com' },
    );

    expect(managerB.create).toHaveBeenCalledWith('tab-b1', 'https://example.com', undefined);
    expect(managerA.create).not.toHaveBeenCalled();
  });

  it('applies bounds and focus to the sender window only', async () => {
    await state.invokeHandlers.get('tab:setBounds')!(
      { sender: { id: winB.webContents.id } },
      { x: 0, y: 88, w: 1200, h: 800 },
    );
    await state.invokeHandlers.get('tab:focusActive')!({ sender: { id: winB.webContents.id } }, undefined);

    expect(managerB.setBounds).toHaveBeenCalledWith(0, 88, 1200, 800);
    expect(managerA.setBounds).not.toHaveBeenCalled();
    expect(managerB.focusActive).toHaveBeenCalledTimes(1);
    expect(managerA.focusActive).not.toHaveBeenCalled();
  });

  it('rejects window-scoped channels when the sender window has no manager', async () => {
    state.managersBySender.delete(winB.webContents.id);
    await expect(state.invokeHandlers.get('tab:create')!(
      { sender: { id: winB.webContents.id } },
      { tabId: 'tab-x', url: 'https://example.com' },
    )).rejects.toThrow('no tab manager');
    expect(managerA.create).not.toHaveBeenCalled();
    expect(managerB.create).not.toHaveBeenCalled();
  });

  it('rejects unregistered senders outright', async () => {
    await expect(state.invokeHandlers.get('tab:create')!(
      { sender: { id: 999 } },
      { tabId: 'tab-x', url: 'https://example.com' },
    )).rejects.toThrow('not a registered window');
    expect(managerA.create).not.toHaveBeenCalled();
    expect(managerB.create).not.toHaveBeenCalled();
  });

  it('closes a tab owned by the sender window', async () => {
    state.ownerWindows.set('tab-a1', winA);
    state.managersByTab.set('tab-a1', managerA);

    await state.invokeHandlers.get('tab:close')!(
      { sender: { id: winA.webContents.id } },
      { tabId: 'tab-a1' },
    );

    expect(managerA.close).toHaveBeenCalledWith('tab-a1');
    expect(managerB.close).not.toHaveBeenCalled();
  });

  it('rejects a tabId owned by another window and logs a warning', async () => {
    state.ownerWindows.set('tab-b1', winB);
    state.managersByTab.set('tab-b1', managerB);

    await expect(state.invokeHandlers.get('tab:close')!(
      { sender: { id: winA.webContents.id } },
      { tabId: 'tab-b1' },
    )).rejects.toThrow('does not belong to this window');

    expect(managerB.close).not.toHaveBeenCalled();
    expect(state.warn).toHaveBeenCalled();
  });

  it('keeps unknown tabIds a no-op (restore/close races must not throw)', async () => {
    await expect(state.invokeHandlers.get('tab:close')!(
      { sender: { id: winA.webContents.id } },
      { tabId: 'tab-missing' },
    )).resolves.toBeUndefined();

    expect(managerA.close).not.toHaveBeenCalled();
    expect(managerB.close).not.toHaveBeenCalled();
  });

  it('rejects a malformed payload before touching any manager', async () => {
    await expect(state.invokeHandlers.get('tab:create')!(
      { sender: { id: winA.webContents.id } },
      { tabId: 'tab-a1', url: 'javascript:alert(1)' },
    )).rejects.toThrow('Invalid arguments for tab:create');
    expect(managerA.create).not.toHaveBeenCalled();
  });
});
