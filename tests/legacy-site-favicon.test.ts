import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserView: class {}, Menu: {} }));
vi.mock('../src/main/modules/window', () => ({ getMainWindow: () => null }));
vi.mock('../src/main/modules/session-manager', () => ({ setupSessionOnce: () => {} }));
vi.mock('../src/main/modules/password-capture', () => ({ setupCapture: () => {}, teardownCapture: () => {} }));
vi.mock('../src/main/modules/password-fill', () => ({ fillPasswordsInWebContents: () => Promise.resolve({ success: false }) }));
vi.mock('../src/main/modules/password-store', () => ({ getFillCredentialForUrl: () => null, isAutoFillEnabled: () => false }));

import { legacySiteFavicon } from '../src/main/modules/tabs';

describe('legacy site favicon fallback', () => {
  it('uses the current 7K7K origin favicon without leaking across sites', () => {
    expect(legacySiteFavicon('https://news.7k7k.com/pkt/?account=private')).toBe('https://news.7k7k.com/favicon.ico');
    expect(legacySiteFavicon('https://web.7k7k.com/game/')).toBe('https://web.7k7k.com/favicon.ico');
    expect(legacySiteFavicon('https://example.com/7k7k.com')).toBeNull();
  });
});
