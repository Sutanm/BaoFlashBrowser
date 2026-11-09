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
/**
 * 已被某个窗口消费掉的恢复状态。多窗口下第一个窗口 resolve 不能把
 * 其他窗口的异常退出状态一起清掉（否则第二个窗口永远不会提示恢复）。
 */
const resolvedWindows = new Set<string>();

export function initializeSessionRecovery(): void {
  if (initialized) return;
  initialized = true;
  const activeStore = getStore();
  const result = beginSession(activeStore.get('session', DEFAULT_STATE));
  recoveryRequired = result.abnormalExit;
  activeStore.set('session', result.state);
  log.info(`[Session] previous exit: ${recoveryRequired ? 'abnormal' : 'clean'}`);
}

export function getSessionRecoveryStatus(windowKey?: string): { abnormalExit: boolean } {
  if (windowKey && resolvedWindows.has(windowKey)) return { abnormalExit: false };
  return { abnormalExit: recoveryRequired };
}

/**
 * `windowKey` 给出时只消费该窗口；不传时保留旧的"整进程已消费"语义。
 */
export function resolveSessionRecovery(windowKey?: string): void {
  if (windowKey) {
    resolvedWindows.add(windowKey);
    return;
  }
  recoveryRequired = false;
}

/** 仅测试用：清空进程内状态（store 不动）。 */
export function resetSessionRecoveryForTest(): void {
  initialized = false;
  recoveryRequired = false;
  cleanShutdownAllowed = true;
  resolvedWindows.clear();
}

export function preventCleanShutdownMark(): void {
  cleanShutdownAllowed = false;
}

export function markCleanShutdown(): void {
  if (!initialized || !cleanShutdownAllowed) return;
  const activeStore = getStore();
  activeStore.set('session', finishSession(activeStore.get('session', DEFAULT_STATE)));
}
