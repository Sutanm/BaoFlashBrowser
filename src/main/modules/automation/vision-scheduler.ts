import { performance } from 'perf_hooks';

export class AutomationVisionSchedulerError extends Error {
  constructor(readonly code: 'QUEUE_FULL', message: string) {
    super(message);
    this.name = 'AutomationVisionSchedulerError';
  }
}

export type ScheduledVisionResult<T> = {
  readonly value: T;
  readonly queueWaitMs: number;
  readonly queueDepthAtSubmit: number;
};

type QueueEntry<T> = {
  readonly signal: AbortSignal;
  readonly submittedAt: number;
  readonly depthAtSubmit: number;
  readonly operation: () => Promise<T>;
  readonly resolve: (result: ScheduledVisionResult<T>) => void;
  readonly reject: (error: Error) => void;
  started: boolean;
  settled: boolean;
  onAbort: () => void;
};

/** FIFO scheduler for the single-request OpenCV worker channel. */
export class AutomationVisionScheduler {
  private readonly queue: QueueEntry<unknown>[] = [];
  private running = false;

  constructor(readonly maxQueueDepth = 64) {
    if (!Number.isSafeInteger(maxQueueDepth) || maxQueueDepth < 1) throw new Error('vision maxQueueDepth must be a positive integer');
  }

  schedule<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<ScheduledVisionResult<T>> {
    if (signal.aborted) return Promise.reject(new Error('automation cancelled'));
    if (this.queue.length >= this.maxQueueDepth) {
      return Promise.reject(new AutomationVisionSchedulerError('QUEUE_FULL', `vision queue is full: ${this.queue.length}/${this.maxQueueDepth}`));
    }
    return new Promise<ScheduledVisionResult<T>>((resolve, reject) => {
      const entry: QueueEntry<T> = {
        signal,
        submittedAt: performance.now(),
        depthAtSubmit: this.queue.length + (this.running ? 1 : 0),
        operation,
        resolve,
        reject,
        started: false,
        settled: false,
        onAbort: () => undefined,
      };
      entry.onAbort = () => {
        if (entry.started || entry.settled) return;
        const index = this.queue.indexOf(entry as QueueEntry<unknown>);
        if (index >= 0) this.queue.splice(index, 1);
        entry.settled = true;
        entry.reject(new Error('automation cancelled'));
      };
      signal.addEventListener('abort', entry.onAbort, { once: true });
      this.queue.push(entry as QueueEntry<unknown>);
      this.drain();
    });
  }

  private drain(): void {
    if (this.running) return;
    const entry = this.queue.shift();
    if (!entry) return;
    if (entry.settled || entry.signal.aborted) {
      entry.signal.removeEventListener('abort', entry.onAbort);
      if (!entry.settled) {
        entry.settled = true;
        entry.reject(new Error('automation cancelled'));
      }
      this.drain();
      return;
    }
    this.running = true;
    entry.started = true;
    const queueWaitMs = performance.now() - entry.submittedAt;
    void Promise.resolve().then(entry.operation).then(
      (value) => {
        if (entry.settled) return;
        entry.settled = true;
        entry.resolve({ value, queueWaitMs, queueDepthAtSubmit: entry.depthAtSubmit });
      },
      (error: unknown) => {
        if (entry.settled) return;
        entry.settled = true;
        entry.reject(error instanceof Error ? error : new Error(String(error)));
      },
    ).finally(() => {
      entry.signal.removeEventListener('abort', entry.onAbort);
      this.running = false;
      this.drain();
    });
  }
}

const sharedSchedulers = new WeakMap<object, AutomationVisionScheduler>();

export function visionSchedulerFor(owner: object): AutomationVisionScheduler {
  const existing = sharedSchedulers.get(owner);
  if (existing) return existing;
  const scheduler = new AutomationVisionScheduler();
  sharedSchedulers.set(owner, scheduler);
  return scheduler;
}
