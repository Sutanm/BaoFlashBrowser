// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { CAPTURE_SCRIPT } from '../src/main/modules/password-capture';

vi.mock('../src/main/modules/password-store', () => ({
  getMetaForHost: () => [], isAutoCaptureEnabled: () => true, isCaptureExcluded: () => false,
}));
vi.mock('../src/main/modules/window', () => ({ getMainWindow: () => null }));

describe('password capture page transport', () => {
  it('uses the CDP binding and never writes a captured password to console.log', () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const fetch = vi.fn().mockResolvedValue(undefined);
    Object.assign(window, { __baopReport: report, fetch });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    document.body.innerHTML = '<form><input name="username" value="bao"><input type="password" value="secret"></form>';

    window.eval(CAPTURE_SCRIPT);
    document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const payloads = report.mock.calls.map(([value]) => JSON.parse(String(value)));
    expect(payloads).toContainEqual(expect.objectContaining({ _type: 'baop_capture', user: 'bao', pass: 'secret' }));
    expect(consoleSpy).not.toHaveBeenCalled();

    window.fetch('/login', { method: 'POST', body: 'username=Bao+User&password=SeCrEt%21' });
    const fetchPayloads = report.mock.calls.map(([value]) => JSON.parse(String(value)));
    expect(fetchPayloads).toContainEqual(expect.objectContaining({
      _type: 'baop_capture', user: 'Bao User', pass: 'SeCrEt!', source: 'fetch',
    }));

    consoleSpy.mockRestore();
    vi.useRealTimers();
  });
});
