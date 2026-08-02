import Store from 'electron-store';
import log from 'electron-log';
import { beginSession, finishSession, type SessionRunState } from '../utils/session-recovery-state';

const DEFAULT_STATE: SessionRunState = { running: false, startedAt: 0, cleanShutdownAt: null };
const store = new Store<{ session: SessionRunState }>({
  name: 'session-recovery',
  defaults: { session: DEFAULT_STATE },
});

let recoveryRequired = false;
let cleanShutdownAllowed = true;
let initialized = false;

export function initializeSessionRecovery(): void {
  if (initialized) return;
  initialized = true;
  const result = beginSession(store.get('session', DEFAULT_STATE));
  recoveryRequired = result.abnormalExit;
  store.set('session', result.state);
  log.info(`[Session] previous exit: ${recoveryRequired ? 'abnormal' : 'clean'}`);
}

export function getSessionRecoveryStatus(): { abnormalExit: boolean } {
  return { abnormalExit: recoveryRequired };
}

export function resolveSessionRecovery(): void {
  recoveryRequired = false;
}

export function preventCleanShutdownMark(): void {
  cleanShutdownAllowed = false;
}

export function markCleanShutdown(): void {
  if (!initialized || !cleanShutdownAllowed) return;
  store.set('session', finishSession(store.get('session', DEFAULT_STATE)));
}
