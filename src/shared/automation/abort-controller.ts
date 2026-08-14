type AbortCallback = () => void;

class LegacyAbortSignal {
  aborted = false;
  private readonly listeners = new Map<EventListenerOrEventListenerObject, AbortCallback>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (type !== 'abort' || !listener) return;
    const callback = typeof listener === 'function'
      ? listener as unknown as AbortCallback
      : listener.handleEvent.bind(listener) as unknown as AbortCallback;
    this.listeners.set(listener, callback);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (type !== 'abort' || !listener) return;
    this.listeners.delete(listener);
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    for (const listener of this.listeners.values()) listener();
    this.listeners.clear();
  }
}

class LegacyAbortController {
  readonly legacySignal = new LegacyAbortSignal();
  readonly signal = this.legacySignal as unknown as AbortSignal;
  abort(): void { this.legacySignal.abort(); }
}

export function createAutomationAbortController(): AbortController {
  const NativeAbortController = globalThis.AbortController;
  if (typeof NativeAbortController === 'function') return new NativeAbortController();
  return new LegacyAbortController() as unknown as AbortController;
}
