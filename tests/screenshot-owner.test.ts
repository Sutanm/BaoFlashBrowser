// 多窗口 P4a：captureTab 的风控输入（窗口最小化、活动性、隐藏捕获尺寸）
// 必须来自"该标签的宿主窗口/所属实例"，不能读全局 getMainWindow()。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const wc = {
    id: 11,
    isDestroyed: () => false,
    incrementCapturerCount: vi.fn(),
    decrementCapturerCount: vi.fn(),
    capturePage: vi.fn(async () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 10, height: 10 }),
      toPNG: () => Buffer.from('png'),
    })),
  };
  return {
    wc,
    owner: null as { isDestroyed: () => boolean; isMinimized: () => boolean } | null,
    manager: null as {
      getWebContents: (tabId: string) => typeof wc | null;
      isTabActive: (tabId: string) => boolean;
      getContainerRect: () => { x: number; y: number; width: number; height: number };
    } | null,
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  };
});

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));
vi.mock('electron-log', () => ({ default: { info: state.info, warn: state.warn, error: state.error, debug: vi.fn() } }));
vi.mock('../src/main/modules/config', () => ({
  loadConfig: () => ({ screenshotDir: '' }),
  saveConfig: vi.fn(),
}));
vi.mock('../src/main/modules/tabs', () => ({
  getTabOwnerWindow: () => state.owner,
  findTabManagerByTabId: () => state.manager,
  tabManager: {},
}));

const { captureTab } = await import('../src/main/modules/screenshot');

function setOwner(minimized: boolean) {
  state.owner = { isDestroyed: () => false, isMinimized: () => minimized };
}

function setManager(active: boolean, rect = { x: 0, y: 0, width: 1280, height: 720 }) {
  state.manager = {
    getWebContents: () => state.wc,
    isTabActive: () => active,
    getContainerRect: () => rect,
  };
}

describe('captureTab window ownership (P4a)', () => {
  beforeEach(() => {
    state.wc.incrementCapturerCount.mockClear();
    state.wc.decrementCapturerCount.mockClear();
    state.wc.capturePage.mockClear();
    state.owner = null;
    state.manager = null;
  });

  it('rejects when the tab has no owning window', async () => {
    await expect(captureTab('tab-a', { returnData: false })).resolves.toMatchObject({ success: false, code: 'NO_WINDOW' });
    expect(state.wc.capturePage).not.toHaveBeenCalled();
  });

  it('rejects an inactive tab while its host window is minimized', async () => {
    setOwner(true);
    setManager(false);

    await expect(captureTab('tab-a', { returnData: false }))
      .resolves.toMatchObject({ success: false, code: 'MINIMIZED_INACTIVE' });
  });

  it('sizes hidden captures from the owning manager rect, not a global window', async () => {
    setOwner(false);
    setManager(false, { x: 0, y: 0, width: 900, height: 640 });

    await expect(captureTab('tab-a', { returnData: false })).resolves.toMatchObject({ success: true });
    expect(state.wc.incrementCapturerCount).toHaveBeenCalledWith({ width: 900, height: 640 }, true);
  });

  it('does not request a hidden-capture size for the active tab', async () => {
    setOwner(false);
    setManager(true);

    await expect(captureTab('tab-a', { returnData: false })).resolves.toMatchObject({ success: true });
    expect(state.wc.incrementCapturerCount).toHaveBeenCalledWith(undefined, undefined);
  });
});
