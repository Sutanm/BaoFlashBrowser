import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAutomationAbortController } from '../src/shared/automation/abort-controller';

afterEach(() => vi.unstubAllGlobals());

describe('automation AbortController compatibility', () => {
  it('provides cancellation on Electron 11 / Node 12 without a native AbortController', () => {
    vi.stubGlobal('AbortController', undefined);
    const controller = createAutomationAbortController();
    const listener = vi.fn();
    controller.signal.addEventListener('abort', listener);
    controller.abort();
    controller.abort();
    expect(controller.signal.aborted).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('uses the native implementation when available', () => {
    const controller = createAutomationAbortController();
    expect(controller).toBeInstanceOf(AbortController);
  });
});
