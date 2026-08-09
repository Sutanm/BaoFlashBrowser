// Per-script crash tracking with exponential backoff, pure logic (no Electron).

export interface CrashTrackerOptions {
  stopAfter?: number;
}

export interface CrashRecord {
  crashedCount: number;
  shouldStop: boolean;
  nextDelayMs: number;
}

export interface CrashTracker {
  record(scriptId: string): CrashRecord;
  reset(scriptId: string): void;
  crashedCount(scriptId: string): number;
}

export function backoffDelayMs(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt <= 0) return 1000;
  if (attempt >= 5) return 60_000;
  return 1000 * 2 ** (attempt - 1);
}

export function createCrashTracker(options?: CrashTrackerOptions): CrashTracker {
  const stopAfter = options?.stopAfter ?? 5;
  const counts = new Map<string, number>();
  return {
    record(scriptId: string): CrashRecord {
      const crashedCount = (counts.get(scriptId) ?? 0) + 1;
      counts.set(scriptId, crashedCount);
      return { crashedCount, shouldStop: crashedCount >= stopAfter, nextDelayMs: backoffDelayMs(crashedCount) };
    },
    reset(scriptId: string): void {
      counts.delete(scriptId);
    },
    crashedCount(scriptId: string): number {
      return counts.get(scriptId) ?? 0;
    },
  };
}
