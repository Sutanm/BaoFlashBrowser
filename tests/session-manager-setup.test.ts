import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const makeSession = () => ({
    clearCache: vi.fn().mockResolvedValue(undefined),
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
describe('session manager setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('configures default and persistent sessions independently and only once', async () => {
    vi.resetModules();
    const { configureOptionalSessionServices, initSession, setupSessionOnce } = await import('../src/main/modules/session-manager');

    configureOptionalSessionServices({ downloadSetup: mocks.setupDownloadHandlers });
    initSession();
    setupSessionOnce(mocks.defaultSession as never);
    setupSessionOnce(mocks.persistentSession as never);

    expect(mocks.defaultSession.setUserAgent).toHaveBeenCalledTimes(1);
    expect(mocks.persistentSession.setUserAgent).toHaveBeenCalledTimes(1);
    expect(mocks.setupDownloadHandlers).toHaveBeenCalledTimes(2);
  });

  it('clears both browser HTTP caches without clearing site storage', async () => {
    vi.resetModules();
    const { clearBrowserCache } = await import('../src/main/modules/session-manager');

    await expect(clearBrowserCache()).resolves.toEqual({ clearedSessions: 2 });
    expect(mocks.defaultSession.clearCache).toHaveBeenCalledTimes(1);
    expect(mocks.persistentSession.clearCache).toHaveBeenCalledTimes(1);
  });

  it('patches only GitHub document CSP and keeps CORS restricted to SWF', async () => {
    vi.resetModules();
    const { configureOptionalSessionServices, initSession } = await import('../src/main/modules/session-manager');
    const patchCsp = vi.fn(headers => ({ ...headers, patched: ['yes'] }));
    configureOptionalSessionServices({ githubModules: { register: vi.fn(), redirect: vi.fn().mockResolvedValue(null), patchCsp } });
    initSession();
    const handler = mocks.defaultSession.webRequest.onHeadersReceived.mock.calls[0][1];
    const xhr = vi.fn();
    handler({ url: 'https://github.com/api/test', resourceType: 'xhr', responseHeaders: { original: ['keep'] } }, xhr);
    expect(xhr).toHaveBeenCalledWith({ responseHeaders: { original: ['keep'] } });
    expect(patchCsp).not.toHaveBeenCalled();
    const document = vi.fn();
    handler({ url: 'https://github.com/', resourceType: 'mainFrame', responseHeaders: { original: ['keep'] } }, document);
    expect(document).toHaveBeenCalledWith({ responseHeaders: { original: ['keep'], patched: ['yes'] } });
    const swf = vi.fn();
    handler({ url: 'https://game.test/game.swf', resourceType: 'object', responseHeaders: {} }, swf);
    expect(swf.mock.calls[0][0].responseHeaders['Access-Control-Allow-Origin']).toEqual(['*']);
  });
});
