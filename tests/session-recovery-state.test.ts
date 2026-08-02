import { describe, expect, it } from 'vitest';
import { beginSession, finishSession, type SessionRunState } from '../src/main/utils/session-recovery-state';

const clean: SessionRunState = { running: false, startedAt: 100, cleanShutdownAt: 200 };

describe('session recovery run marker', () => {
  it('does not request recovery after a clean shutdown', () => {
    const result = beginSession(clean, 300);
    expect(result.abnormalExit).toBe(false);
    expect(result.state).toEqual({ running: true, startedAt: 300, cleanShutdownAt: 200 });
  });

  it('requests recovery when the previous run never marked itself clean', () => {
    const result = beginSession({ ...clean, running: true }, 300);
    expect(result.abnormalExit).toBe(true);
  });

  it('marks a user-initiated shutdown as clean', () => {
    expect(finishSession({ ...clean, running: true }, 400)).toEqual({
      running: false,
      startedAt: 100,
      cleanShutdownAt: 400,
    });
  });
});
