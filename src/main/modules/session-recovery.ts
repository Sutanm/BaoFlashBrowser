import Store from 'electron-store';
import log from 'electron-log';
import { beginSession, finishSession, type SessionRunState } from '../utils/session-recovery-state';

const DEFAULT_STATE: SessionRunState = { running: false, startedAt: 0, cleanShutdownAt: null };
let store: Store<{ session: SessionRunState }> | null = null;

function getStore(): Store<{ session: SessionRunState }> {
  if (!store) {
    store = new Store<{ session: SessionRunState }>({
      name: 'session-recovery',
      defaults: { session: DEFAULT_STATE },
    });
  }
  return store;
}

let recoveryRequired = false;
let cleanShutdownAllowed = true;
let initialized = false;

export function initializeSessionRecovery(): void {
  if (initialized) return;
  initialized = true;
  const activeStore = getStore();
  const result = beginSession(activeStore.get('session', DEFAULT_STATE));
  recoveryRequired = result.abnormalExit;
  activeStore.set('session', result.state);
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
  const activeStore = getStore();
  activeStore.set('session', finishSession(activeStore.get('session', DEFAULT_STATE)));
}
