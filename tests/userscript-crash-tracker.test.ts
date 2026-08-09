import { describe, it, expect } from 'vitest';
import { createCrashTracker } from '../src/main/modules/userscripts/userscript-crash-tracker';

describe('createCrashTracker', () => {
  it('stops after 5 consecutive crashes with backoff 1,2,4,8,60s', () => {
    const tracker = createCrashTracker({ stopAfter: 5 });
    const delays: number[] = [];
    let shouldStop = false;
    for (let i = 0; i < 5; i++) {
      const r = tracker.record('bg-a');
      delays.push(r.nextDelayMs);
      shouldStop = r.shouldStop;
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 60000]);
    expect(shouldStop).toBe(true);
  });

  it('tracks crash counts per script independently', () => {
    const tracker = createCrashTracker({ stopAfter: 5 });
    tracker.record('a'); tracker.record('a'); tracker.record('a'); tracker.record('a');
    expect(tracker.record('a').shouldStop).toBe(true);
    expect(tracker.record('b').shouldStop).toBe(false);
    expect(tracker.crashedCount('b')).toBe(1);
  });

  it('reset clears the count (manual restart)', () => {
    const tracker = createCrashTracker({ stopAfter: 3 });
    tracker.record('a'); tracker.record('a');
    tracker.reset('a');
    expect(tracker.crashedCount('a')).toBe(0);
    expect(tracker.record('a').crashedCount).toBe(1);
    expect(tracker.crashedCount('a')).toBe(1);
    expect(tracker.record('a').shouldStop).toBe(false);
  });
});
