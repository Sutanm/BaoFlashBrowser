// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SnapshotScript } from './userscript-types';
import { scheduleScripts } from './preload/scheduler';

function makeScript(overrides?: Partial<SnapshotScript>): SnapshotScript {
  return {
    id: 'test:script',
    runAt: 'document-body',
    source: '/* fixture */',
    ...overrides,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('userscript scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs document-body immediately when the body already exists', () => {
    const script = makeScript();
    const runs: string[] = [];
    scheduleScripts([script], { executeScript: (_s, runAt) => runs.push(runAt) });
    expect(runs).toEqual(['document-body']);
  });

  it('runs document-body when the body appears later', async () => {
    document.body?.remove();
    const script = makeScript();
    const runs: string[] = [];
    scheduleScripts([script], { executeScript: (_s, runAt) => runs.push(runAt) });
    expect(runs).toEqual([]);
    const body = document.createElement('body');
    document.documentElement.appendChild(body);
    await flushMicrotasks();
    expect(runs).toEqual(['document-body']);
  });

  it('falls back after the absolute timeout when the body never appears', async () => {
    document.body?.remove();
    const script = makeScript();
    const runs: string[] = [];
    scheduleScripts([script], { executeScript: (_s, runAt) => runs.push(runAt) });
    expect(runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(4999);
    expect(runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toEqual(['document-body']);
  });

  it('runs each script at most once when the observer and timeout race', async () => {
    document.body?.remove();
    const script = makeScript();
    const runs: string[] = [];
    scheduleScripts([script], { executeScript: (_s, runAt) => runs.push(runAt) });
    const body = document.createElement('body');
    document.documentElement.appendChild(body);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(6000);
    expect(runs).toEqual(['document-body']);
  });

  it('schedules document-start, document-end and document-idle phases', async () => {
    Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true });
    const scripts: SnapshotScript[] = [
      makeScript({ id: 's:start', runAt: 'document-start' }),
      makeScript({ id: 's:end', runAt: 'document-end' }),
      makeScript({ id: 's:idle', runAt: 'document-idle' }),
    ];
    const runs: string[] = [];
    scheduleScripts(scripts, { executeScript: (s, runAt) => runs.push(`${s.id}@${runAt}`) });
    expect(runs).toEqual(['s:start@document-start']);
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await flushMicrotasks();
    expect(runs).toEqual(['s:start@document-start', 's:end@document-end']);
    await vi.advanceTimersByTimeAsync(2000);
    expect(runs).toEqual(['s:start@document-start', 's:end@document-end', 's:idle@document-idle']);
  });

  it('runs document-end immediately when the document is already interactive', async () => {
    Object.defineProperty(document, 'readyState', { value: 'interactive', configurable: true });
    const script = makeScript({ id: 's:end', runAt: 'document-end' });
    const runs: string[] = [];
    scheduleScripts([script], { executeScript: (_s, runAt) => runs.push(runAt) });
    await flushMicrotasks();
    expect(runs).toEqual(['document-end']);
  });
});
