import { describe, expect, it, vi } from 'vitest';
import { acquireCdpLease, getCdpLeaseOwner } from '../src/main/modules/cdp-lease';

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
});
