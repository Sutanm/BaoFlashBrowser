export interface SessionRunState {
  running: boolean;
  startedAt: number;
  cleanShutdownAt: number | null;
}

export function beginSession(previous: SessionRunState, now = Date.now()): {
  abnormalExit: boolean;
  state: SessionRunState;
} {
  return {
    abnormalExit: previous.running === true,
    state: { running: true, startedAt: now, cleanShutdownAt: previous.cleanShutdownAt },
  };
}

export function finishSession(previous: SessionRunState, now = Date.now()): SessionRunState {
  return { ...previous, running: false, cleanShutdownAt: now };
}
