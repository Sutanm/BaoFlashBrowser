import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  isDestroyed: () => false, addBrowserView: vi.fn(), removeBrowserView: vi.fn(),
  webContents: { send: vi.fn() },
}));
vi.mock('../src/main/modules/window', () => ({ getMainWindow: () => host }));
vi.mock('../src/main/modules/session-manager', () => ({ setupSessionOnce: vi.fn() }));
vi.mock('electron', () => ({
  Menu: {},
  BrowserView: class {
    webContents = Object.assign(new EventEmitter(), {
      id: 9191, isDestroyed: () => false, isLoading: () => false,
      loadURL: async () => undefined, setZoomFactor: vi.fn(), setAudioMuted: vi.fn(),
      destroy: vi.fn(), getURL: () => 'https://fixture.invalid/login',
    });
    setBounds = vi.fn();
    setAutoResize = vi.fn();
    destroy = vi.fn();
  },
}));

import { configureOptionalTabServices, tabManager } from '../src/main/modules/tabs';

afterEach(() => {
  tabManager.destroyAll();
  configureOptionalTabServices({});
  vi.useRealTimers();
});

describe('password capture re-arm on a dynamic form', () => {
  function fixture(autofill: boolean) {
    vi.useFakeTimers();
    const setupCapture = vi.fn();
    const fillPasswords = vi.fn(async () => ({ success: false, filledFields: 0, filledCredentials: 0, usernames: [] }));
    configureOptionalTabServices({ passwords: {
      setupCapture, teardownCapture: vi.fn(), fillPasswords,
      getFillCredentialForUrl: () => null, isAutoFillEnabled: () => autofill,
    } });
    tabManager.create('form', 'https://fixture.invalid/login');
    return { setupCapture, fillPasswords, wc: tabManager.getWebContents('form')! };
  }

  it('restores capture immediately when autofill is disabled', async () => {
    const { setupCapture, fillPasswords, wc } = fixture(false);
    tabManager.notifyPasswordFormDetected(wc.id);
    expect(setupCapture).toHaveBeenCalledWith(wc);
    await vi.advanceTimersByTimeAsync(100);
    expect(fillPasswords).not.toHaveBeenCalled();
  });

  it('does not reattach while a JSONP login resource is loading', () => {
    const { setupCapture, wc } = fixture(true);
    vi.spyOn(wc, 'isLoading').mockReturnValue(true);
    tabManager.notifyPasswordFormDetected(wc.id);
    expect(setupCapture).not.toHaveBeenCalled();
  });

  it('ignores a form signal from an old/destroyed view', () => {
    const { setupCapture, wc } = fixture(true);
    tabManager.close('form');
    tabManager.notifyPasswordFormDetected(wc.id);
    expect(setupCapture).not.toHaveBeenCalled();
  });

  it('ignores a destroyed WebContents even before its tab entry is removed', () => {
    const { setupCapture, wc } = fixture(true);
    vi.spyOn(wc, 'isDestroyed').mockReturnValue(true);
    expect(() => tabManager.notifyPasswordFormDetected(wc.id)).not.toThrow();
    expect(setupCapture).not.toHaveBeenCalled();
  });
});
