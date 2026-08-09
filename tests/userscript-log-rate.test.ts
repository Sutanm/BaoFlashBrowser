import { describe, it, expect } from 'vitest';
import { createLogRateLimiter } from '../src/main/ipc/userscript-log-rate';

describe('createLogRateLimiter', () => {
  it('allows up to 10 per second then rejects', () => {
    const limiter = createLogRateLimiter({ perSecond: 10 });
    let ok = 0;
    for (let i = 0; i < 10; i++) if (limiter.allow('s')) ok++;
    expect(ok).toBe(10);
    expect(limiter.allow('s')).toBe(false);
  });

  it('rejects independently per script', () => {
    const limiter = createLogRateLimiter({ perSecond: 2 });
    limiter.allow('a');
    limiter.allow('a');
    expect(limiter.allow('a')).toBe(false);
    expect(limiter.allow('b')).toBe(true);
  });

  it('reopens the window after 1s', async () => {
    const limiter = createLogRateLimiter({ perSecond: 1 });
    expect(limiter.allow('s')).toBe(true);
    expect(limiter.allow('s')).toBe(false);
    await new Promise((r) => setTimeout(r, 1050));
    expect(limiter.allow('s')).toBe(true);
  });

  it('warnOnce emits at most once per 30s window', () => {
    const limiter = createLogRateLimiter({ warnEveryMs: 30_000 });
    expect(limiter.warnOnce('s')).toBe(true);
    expect(limiter.warnOnce('s')).toBe(false);
    expect(limiter.warnOnce('other')).toBe(true);
  });
});
