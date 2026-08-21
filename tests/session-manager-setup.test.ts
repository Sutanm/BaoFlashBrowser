import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const makeSession = () => ({
    setUserAgent: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    webRequest: {
      onBeforeRequest: vi.fn(),
      onHeadersReceived: vi.fn(),
    },
  });
  return {
    defaultSession: makeSession(),
    persistentSession: makeSession(),
    setupDownloadHandlers: vi.fn(),
  };
});

vi.mock('electron', () => ({
  session: {
    defaultSession: mocks.defaultSession,
    fromPartition: vi.fn(() => mocks.persistentSession),
  },
}));
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/main/modules/download', () => ({ setupDownloadHandlers: mocks.setupDownloadHandlers }));
vi.mock('../src/main/modules/js-patch-service', () => ({ chunkRedirectUrl: () => null }));
vi.mock('../src/main/modules/userscripts', () => ({ getWebRequestObserver: () => null }));

describe('session manager setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('configures default and persistent sessions independently and only once', async () => {
    vi.resetModules();
    const { initSession, setupSessionOnce } = await import('../src/main/modules/session-manager');

    initSession();
    setupSessionOnce(mocks.defaultSession as never);
    setupSessionOnce(mocks.persistentSession as never);

    expect(mocks.defaultSession.setUserAgent).toHaveBeenCalledTimes(1);
    expect(mocks.persistentSession.setUserAgent).toHaveBeenCalledTimes(1);
    expect(mocks.setupDownloadHandlers).toHaveBeenCalledTimes(2);
  });
});
