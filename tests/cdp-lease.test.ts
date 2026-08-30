import { describe, expect, it, vi } from 'vitest';
import { acquireAutomationCdpLease, acquireCdpLease, createCdpLeaseWatchdog, getCdpLeaseOwner } from '../src/main/modules/cdp-lease';

function makeWebContents(id = 42) {
  let attached = false;
  return {
    id,
    isDestroyed: () => false,
    debugger: {
      isAttached: () => attached,
      attach: vi.fn(() => { attached = true; }),
      detach: vi.fn(() => { attached = false; }),
    },
  };
}

describe('CDP lease coordinator', () => {
  it('records ownership and releases only once', () => {
    const wc = makeWebContents();
    const lease = acquireCdpLease(wc, 'automation');
    expect(getCdpLeaseOwner(wc.id)).toBe('automation');
    expect(() => acquireCdpLease(wc, 'password-capture')).toThrow(/already leased by automation/);
    lease.release();
    lease.release();
    expect(getCdpLeaseOwner(wc.id)).toBeNull();
    expect(wc.debugger.detach).toHaveBeenCalledTimes(1);
  });

  it('does not claim or detach an unmanaged debugger', () => {
    const wc = makeWebContents(43);
    wc.debugger.attach();
    expect(() => acquireCdpLease(wc, 'automation')).toThrow(/unmanaged client/);
    expect(getCdpLeaseOwner(wc.id)).toBeNull();
    expect(wc.debugger.detach).not.toHaveBeenCalled();
  });

  it('serializes Automation clients on the same tab', async () => {
    const wc = makeWebContents(44);
    const first = await acquireAutomationCdpLease(wc);
    let secondAcquired = false;
    const secondPromise = acquireAutomationCdpLease(wc).then((lease) => {
      secondAcquired = true;
      return lease;
    });

    await Promise.resolve();
    expect(secondAcquired).toBe(false);
    expect(wc.debugger.attach).toHaveBeenCalledTimes(1);

    first.release();
    const second = await secondPromise;
    expect(secondAcquired).toBe(true);
    expect(wc.debugger.attach).toHaveBeenCalledTimes(2);
    second.release();
    expect(wc.debugger.detach).toHaveBeenCalledTimes(2);
  });

  it('keeps Automation queues independent across tabs', async () => {
    const firstTab = makeWebContents(45);
    const secondTab = makeWebContents(46);
    const first = await acquireAutomationCdpLease(firstTab);
    const second = await acquireAutomationCdpLease(secondTab);

    expect(getCdpLeaseOwner(firstTab.id)).toBe('automation');
    expect(getCdpLeaseOwner(secondTab.id)).toBe('automation');
    expect(firstTab.debugger.attach).toHaveBeenCalledTimes(1);
    expect(secondTab.debugger.attach).toHaveBeenCalledTimes(1);

    first.release();
    second.release();
  });

  it('cancels a queued Automation client without blocking the next one', async () => {
    const wc = makeWebContents(47);
    const first = await acquireAutomationCdpLease(wc);
    const controller = new AbortController();
    const cancelled = acquireAutomationCdpLease(wc, controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toThrow(/cancelled/);

    first.release();
    const next = await acquireAutomationCdpLease(wc);
    next.release();
  });

  it('force-detaches a lease when a CDP command never settles', async () => {
    vi.useFakeTimers();
    try {
      const wc = makeWebContents(48);
      const lease = await acquireAutomationCdpLease(wc);
      const watchdog = createCdpLeaseWatchdog(lease, 'game surface detection', 5_000, 1_500);
      const pending = watchdog.run('DOM.getDocument', () => new Promise<never>(() => undefined));
      const rejection = expect(pending).rejects.toThrow(/DOM\.getDocument/);

      await vi.advanceTimersByTimeAsync(1_500);
      await rejection;
      expect(lease.released).toBe(true);
      expect(getCdpLeaseOwner(wc.id)).toBeNull();
      expect(wc.debugger.detach).toHaveBeenCalledTimes(1);
      watchdog.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('enforces the overall lease deadline across individually fast operations', async () => {
    vi.useFakeTimers();
    try {
      const wc = makeWebContents(49);
      const lease = await acquireAutomationCdpLease(wc);
      const watchdog = createCdpLeaseWatchdog(lease, 'game surface detection', 100, 1_000);
      await vi.advanceTimersByTimeAsync(100);
      expect(() => watchdog.throwIfExpired()).toThrow(/overall limit 100ms/);
      expect(lease.released).toBe(true);
      expect(wc.debugger.detach).toHaveBeenCalledTimes(1);
      watchdog.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
