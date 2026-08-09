// GM_log per-script rate limiter. Pure module (no Electron imports) so it
// can be unit-tested in plain Vitest.
// Limits: perSecond log lines per script; warnOnce throttles the "rate limit
// hit" warning to one per script per 30s window.

export interface LogRateLimiterOptions {
  perSecond?: number;
  warnEveryMs?: number;
}

export interface LogRateLimiter {
  allow(scriptId: string): boolean;
  warnOnce(scriptId: string): boolean;
}

export function createLogRateLimiter(options?: LogRateLimiterOptions): LogRateLimiter {
  const perSecond = options?.perSecond ?? 10;
  const warnEveryMs = options?.warnEveryMs ?? 30_000;
  const windows = new Map<string, { count: number; windowStart: number }>();
  const warnWindows = new Map<string, number>();

  return {
    allow(scriptId: string): boolean {
      const now = Date.now();
      const window = windows.get(scriptId);
      if (!window || now - window.windowStart >= 1000) {
        windows.set(scriptId, { count: 1, windowStart: now });
        return true;
      }
      if (window.count >= perSecond) return false;
      window.count += 1;
      return true;
    },

    warnOnce(scriptId: string): boolean {
      const now = Date.now();
      const last = warnWindows.get(scriptId) ?? 0;
      if (now - last < warnEveryMs) return false;
      warnWindows.set(scriptId, now);
      return true;
    },
  };
}
