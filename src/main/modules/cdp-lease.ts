export type CdpLeaseOwner = 'password-capture' | 'automation';

export type CdpDebuggerLike = {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  detach(): void;
};

export type CdpWebContentsLike = {
  id: number;
  isDestroyed(): boolean;
  debugger: CdpDebuggerLike;
};

export type CdpLease = {
  readonly owner: CdpLeaseOwner;
  readonly webContentsId: number;
  readonly released: boolean;
  release(): void;
};

export type CdpLeaseWatchdog = {
  run<T>(command: string, operation: () => Promise<T>, timeoutMs?: number): Promise<T>;
  throwIfExpired(): void;
  close(): void;
};

type LeaseRecord = {
  owner: CdpLeaseOwner;
  token: symbol;
};

const leases = new Map<number, LeaseRecord>();
const automationQueueTails = new Map<number, Promise<void>>();

function waitForQueueTurn(
  previous: Promise<void>,
  signal?: AbortSignal,
  timeoutMs = 10_000,
): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('automation cancelled'));
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve();
    };
    const onAbort = (): void => finish(new Error('automation cancelled'));
    const timer = setTimeout(
      () => finish(new Error(`timed out waiting for Automation CDP access after ${timeoutMs}ms`)),
      timeoutMs,
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    previous.then(() => finish(), (error) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

/**
 * Electron permits only one Debugger client per WebContents. Keep ownership
 * explicit so password capture and automation can never detach each other.
 */
export function acquireCdpLease(
  webContents: CdpWebContentsLike,
  owner: CdpLeaseOwner,
  protocolVersion = '1.3',
): CdpLease {
  if (webContents.isDestroyed()) throw new Error(`cannot acquire CDP lease for destroyed WebContents ${webContents.id}`);
  const current = leases.get(webContents.id);
  if (current) throw new Error(`CDP is already leased by ${current.owner}`);
  if (webContents.debugger.isAttached()) throw new Error('CDP is already attached by an unmanaged client');

  const token = Symbol(`${owner}:${webContents.id}`);
  webContents.debugger.attach(protocolVersion);
  leases.set(webContents.id, { owner, token });
  let released = false;

  return {
    owner,
    webContentsId: webContents.id,
    get released(): boolean { return released; },
    release(): void {
      if (released) return;
      released = true;
      const active = leases.get(webContents.id);
      if (active?.token !== token) return;
      leases.delete(webContents.id);
      if (!webContents.isDestroyed() && webContents.debugger.isAttached()) webContents.debugger.detach();
    },
  };
}

/**
 * Automation surface discovery, recognition and input all use short-lived CDP
 * sessions. Serialize those sessions per WebContents so a resize/surface refresh
 * cannot make an input step fail merely because another Automation operation is
 * finishing. Different tabs retain independent queues and can run concurrently.
 */
export async function acquireAutomationCdpLease(
  webContents: CdpWebContentsLike,
  signal?: AbortSignal,
  timeoutMs = 10_000,
): Promise<CdpLease> {
  const webContentsId = webContents.id;
  const previous = automationQueueTails.get(webContentsId) ?? Promise.resolve();
  let releaseTurn!: () => void;
  const turn = new Promise<void>((resolve) => { releaseTurn = resolve; });
  const tail = previous.catch(() => undefined).then(() => turn);
  automationQueueTails.set(webContentsId, tail);

  let turnReleased = false;
  const finishTurn = (): void => {
    if (turnReleased) return;
    turnReleased = true;
    releaseTurn();
    void tail.then(() => {
      if (automationQueueTails.get(webContentsId) === tail) automationQueueTails.delete(webContentsId);
    });
  };

  try {
    await waitForQueueTurn(previous, signal, timeoutMs);
    if (signal?.aborted) throw new Error('automation cancelled');
    const lease = acquireCdpLease(webContents, 'automation');
    return {
      owner: lease.owner,
      webContentsId: lease.webContentsId,
      get released(): boolean { return lease.released; },
      release(): void {
        lease.release();
        finishTurn();
      },
    };
  } catch (error) {
    finishTurn();
    throw error;
  }
}

/**
 * A lease finally-block cannot run while an Electron debugger command is
 * permanently pending. This watchdog releases the lease at the deadline and
 * actively rejects every pending command so its caller reaches cleanup.
 */
export function createCdpLeaseWatchdog(
  lease: CdpLease,
  label: string,
  overallTimeoutMs: number,
  defaultCommandTimeoutMs: number,
): CdpLeaseWatchdog {
  const startedAt = Date.now();
  const pendingRejects = new Set<(error: Error) => void>();
  let terminalError: Error | null = null;
  let closed = false;
  let lastCommand = 'initialization';

  const expire = (reason: string): Error => {
    if (!terminalError) {
      terminalError = new Error(`${label} timed out: ${reason}; last CDP command: ${lastCommand}`);
      lease.release();
      for (const reject of [...pendingRejects]) reject(terminalError);
      pendingRejects.clear();
    }
    return terminalError;
  };
  const overallTimer = setTimeout(
    () => expire(`overall limit ${overallTimeoutMs}ms`),
    overallTimeoutMs,
  );

  return {
    run<T>(command: string, operation: () => Promise<T>, timeoutMs = defaultCommandTimeoutMs): Promise<T> {
      if (closed) return Promise.reject(new Error(`${label} watchdog is closed`));
      if (terminalError) return Promise.reject(terminalError);
      lastCommand = command;
      const remaining = overallTimeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) return Promise.reject(expire(`overall limit ${overallTimeoutMs}ms`));
      const commandLimit = Math.max(1, Math.min(timeoutMs, remaining));
      return new Promise<T>((resolve, reject) => {
        let settled = false;
        const rejectPending = (error: Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(commandTimer);
          pendingRejects.delete(rejectPending);
          reject(error);
        };
        const commandTimer = setTimeout(
          () => rejectPending(expire(`command limit ${commandLimit}ms`)),
          commandLimit,
        );
        pendingRejects.add(rejectPending);
        let operationPromise: Promise<T>;
        try {
          operationPromise = operation();
        } catch (error) {
          rejectPending(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        operationPromise.then((value) => {
          if (settled) return;
          settled = true;
          clearTimeout(commandTimer);
          pendingRejects.delete(rejectPending);
          resolve(value);
        }, (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(commandTimer);
          pendingRejects.delete(rejectPending);
          reject(error);
        });
      });
    },
    throwIfExpired(): void {
      if (terminalError) throw terminalError;
    },
    close(): void {
      if (closed) return;
      closed = true;
      clearTimeout(overallTimer);
    },
  };
}

export function getCdpLeaseOwner(webContentsId: number): CdpLeaseOwner | null {
  return leases.get(webContentsId)?.owner ?? null;
}

