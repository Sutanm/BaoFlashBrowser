// run-at scheduler. Handles documents that are already past a phase when the
// preload runs (e.g. body present, DOMContentLoaded already fired).
// Mirrors the planned src/webview-preload/userscripts/scheduler.ts.

import type { RunAt, SnapshotScript } from '../userscript-types';

export interface SchedulerHost {
  executeScript(script: SnapshotScript, runAt: RunAt): void;
}

const BODY_WAIT_MS = 5000;

export function scheduleScripts(scripts: SnapshotScript[], host: SchedulerHost): void {
  const pending = new Set(scripts.map((script) => script.id));
  const run = (script: SnapshotScript, runAt: RunAt): void => {
    if (!pending.has(script.id)) return;
    pending.delete(script.id);
    try {
      host.executeScript(script, runAt);
    } catch {
      // executor never throws; guard for host bugs
    }
  };

  const runAtStart = (script: SnapshotScript): void => {
    const proceed = () => run(script, 'document-start');
    if (document.documentElement) {
      proceed();
      return;
    }
    // At preload time Chromium 87 may not have parsed <html> yet. Wait for the
    // root element like other runtimes do; page scripts run only after parsing
    // starts, so this still beats them.
    const observer = new MutationObserver(() => {
      if (document.documentElement) {
        observer.disconnect();
        proceed();
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  };

  const runAtBody = (script: SnapshotScript): void => {
    const proceed = () => run(script, 'document-body');
    if (document.body) {
      proceed();
      return;
    }
    // Absolute fallback: pages that never create a body (and stop mutating)
    // must not wait forever. The observer path fires early when body appears.
    const force = setTimeout(() => {
      observer.disconnect();
      proceed();
    }, BODY_WAIT_MS);
    const observer = new MutationObserver(() => {
      if (document.body) {
        clearTimeout(force);
        observer.disconnect();
        proceed();
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  };

  const runAtEnd = (script: SnapshotScript): void => {
    const proceed = () => run(script, 'document-end');
    if (document.readyState === 'interactive' || document.readyState === 'complete') {
      queueMicrotask(proceed);
      return;
    }
    document.addEventListener('DOMContentLoaded', proceed, { once: true });
  };

  const runAtIdle = (script: SnapshotScript): void => {
    const proceed = () => run(script, 'document-idle');
    const schedule = (): void => {
      const scheduleIdleCallback = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => void })
        .requestIdleCallback;
      if (typeof scheduleIdleCallback === 'function') {
        scheduleIdleCallback(proceed, { timeout: 500 });
      } else {
        setTimeout(proceed, 250);
      }
    };
    if (document.readyState === 'complete') {
      setTimeout(schedule, 50);
      return;
    }
    document.addEventListener('DOMContentLoaded', schedule, { once: true });
  };

  for (const script of scripts) {
    switch (script.runAt) {
      case 'document-start':
        runAtStart(script);
        break;
      case 'document-body':
        runAtBody(script);
        break;
      case 'document-end':
        runAtEnd(script);
        break;
      case 'document-idle':
        runAtIdle(script);
        break;
    }
  }
}

export function runAtPriority(runAt: RunAt): number {
  switch (runAt) {
    case 'document-start':
      return 0;
    case 'document-body':
      return 1;
    case 'document-end':
      return 2;
    case 'document-idle':
      return 3;
  }
}
