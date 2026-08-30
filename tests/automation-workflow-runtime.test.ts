import { describe, expect, it, vi } from 'vitest';
import {
  AutomationActionRegistry,
  AutomationCoordinateResolver,
  AutomationRuntimeQueryRegistry,
  AutomationWorkflowRuntime,
  generation,
  size,
  targetId,
  viewportSpace,
  type RuntimeExecutionContext,
  type WorkflowDocumentV3,
} from '../src/shared/automation/core';

type RecordAction = { readonly kind: 'record'; readonly value: string };
type FixtureQuery = { readonly kind: 'fixture'; readonly resultType: 'boolean' };

declare module '../src/shared/automation/core/action' {
  interface ActionSpecMap { readonly record: RecordAction }
}
declare module '../src/shared/automation/core/workflow-ir' {
  interface RuntimeQuerySpecMap { readonly fixture: FixtureQuery }
}

const bool = (value: boolean) => ({ kind: 'literal' as const, valueType: 'boolean' as const, value });
const number = (value: number) => ({ kind: 'literal' as const, valueType: 'number' as const, value });
const variable = (name: string) => ({ kind: 'variable' as const, valueType: 'number' as const, name });
const doc = (root: WorkflowDocumentV3['root']): WorkflowDocumentV3 => ({ formatVersion: 3, id: 'runtime-test', name: 'Runtime Test', root });

function harness(options: { query?: () => boolean; callScript?: RuntimeExecutionContext['callScript']; sleep?: RuntimeExecutionContext['sleep']; limits?: ConstructorParameters<typeof AutomationWorkflowRuntime>[2]['limits'] } = {}) {
  const records: string[] = [];
  const actions = new AutomationActionRegistry();
  actions.register<RecordAction>({ kind: 'record', execute: async (action) => { records.push(action.value); } });
  actions.freeze();
  const queries = new AutomationRuntimeQueryRegistry();
  queries.register<FixtureQuery>({ kind: 'fixture', execute: async () => options.query?.() ?? true });
  queries.freeze();
  const runtime = new AutomationWorkflowRuntime(actions, queries, { limits: options.limits });
  const space = viewportSpace({ targetId: targetId('runtime'), targetGeneration: generation(1), viewportGeneration: generation(1) });
  const resolver = new AutomationCoordinateResolver({ viewport: space, viewportSize: size(100, 100) });
  let clock = 0;
  const createContext = (signal: AbortSignal): RuntimeExecutionContext => ({
    currentSpace: space,
    coordinateResolver: resolver,
    signal,
    now: () => clock,
    callScript: options.callScript,
    sleep: options.sleep ?? (async (duration, activeSignal) => {
      if (activeSignal.aborted) throw new Error('automation cancelled');
      clock += duration;
      await Promise.resolve();
    }),
  });
  return { runtime, records, createContext };
}

describe('AutomationWorkflowRuntime', () => {
  it('runs sequence/if/repeat with internal continue and break signals', async () => {
    const { runtime, records, createContext } = harness();
    const root: WorkflowDocumentV3['root'] = { id: 'root', kind: 'sequence', nodes: [
      { id: 'n', kind: 'let', name: 'n', valueType: 'number', value: number(0) },
      { id: 'loop', kind: 'loop', mode: 'repeat', count: number(5), body: { id: 'body', kind: 'sequence', nodes: [
        { id: 'inc', kind: 'set', name: 'n', value: { kind: 'binary', valueType: 'number', operator: 'add', left: variable('n'), right: number(1) } },
        { id: 'skip-three', kind: 'if', condition: { kind: 'binary', valueType: 'boolean', operator: 'equal', left: variable('n'), right: number(3) }, then: { id: 'continue', kind: 'continue' } },
        { id: 'stop-four', kind: 'if', condition: { kind: 'binary', valueType: 'boolean', operator: 'equal', left: variable('n'), right: number(4) }, then: { id: 'break', kind: 'break' } },
        { id: 'record', kind: 'action', action: { kind: 'record', value: 'tick' } },
      ] } },
    ] };
    const result = await runtime.start(doc(root), createContext).completion;
    expect(result.status).toBe('completed');
    expect(records).toEqual(['tick', 'tick']);
  });

  it('polls a query until it becomes true', async () => {
    let calls = 0;
    const { runtime, createContext } = harness({ query: () => ++calls === 3 });
    const result = await runtime.start(doc({ id: 'wait', kind: 'wait', query: { kind: 'fixture', resultType: 'boolean' }, until: 'truthy', timeoutMs: 100, pollIntervalMs: 10, onTimeout: 'fail' }), createContext).completion;
    expect(result.status).toBe('completed');
    expect(calls).toBe(3);
  });

  it('fails on a hard loop budget', async () => {
    const { runtime, createContext } = harness({ limits: { maxLoopIterations: 2 } });
    const result = await runtime.start(doc({ id: 'loop', kind: 'loop', mode: 'while', condition: bool(true), body: { id: 'body', kind: 'sequence', nodes: [] } }), createContext).completion;
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error.message).toContain('loop iteration budget');
  });

  it('cancel waits for the resource barrier', async () => {
    const closed = vi.fn(async () => undefined);
    const sleep = (_duration: number, signal: AbortSignal): Promise<void> => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('automation cancelled')), { once: true }));
    const { runtime, createContext } = harness({ sleep });
    const handle = runtime.start(doc({ id: 'wait', kind: 'wait', durationMs: number(1_000) }), createContext, [{ close: closed }]);
    const result = await handle.cancel('test cancel');
    expect(result).toMatchObject({ status: 'cancelled', reason: 'test cancel' });
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('bounds event history without affecting subscribers', async () => {
    const { runtime, createContext } = harness({ limits: { maxHistoryEvents: 3 } });
    const handle = runtime.start(doc({ id: 'root', kind: 'sequence', nodes: [{ id: 'one', kind: 'action', action: { kind: 'record', value: 'x' } }] }), createContext);
    await handle.completion;
    expect(handle.history).toHaveLength(3);
    expect(handle.state).toBe('completed');
  });

  it('releases a derived Context after its body', async () => {
    const { runtime, records, createContext } = harness();
    const released = vi.fn(async () => undefined);
    const base = createContext(new AbortController().signal);
    const createDerived = (signal: AbortSignal): RuntimeExecutionContext => ({
      ...base,
      signal,
      derive: async () => ({ context: { ...base, signal }, release: released }),
    });
    const result = await runtime.start(doc({ id: 'with', kind: 'with', surface: { kind: 'viewport' }, body: {
      id: 'record', kind: 'action', action: { kind: 'record', value: 'inside' },
    } }), createDerived).completion;
    expect(result.status).toBe('completed');
    expect(records).toEqual(['inside']);
    expect(released).toHaveBeenCalledTimes(1);
  });

  it('applies profile values as typed overrides of declared defaults', async () => {
    const { runtime, createContext } = harness();
    const root: WorkflowDocumentV3['root'] = { id: 'root', kind: 'sequence', nodes: [
      { id: 'threshold', kind: 'let', name: 'threshold', valueType: 'number', value: number(10) },
      { id: 'use', kind: 'set', name: 'threshold', value: { kind: 'binary', valueType: 'number', operator: 'add', left: variable('threshold'), right: number(1) } },
    ] };
    expect((await runtime.start(doc(root), createContext, [], { threshold: 99 }).completion).status).toBe('completed');
    expect((await runtime.start(doc(root), createContext, [], { threshold: 'wrong' }).completion).status).toBe('failed');
  });

  it('calls a reusable script with primitive arguments and assigns its result', async () => {
    const callScript = vi.fn(async (_scriptId: string, args: readonly (string | number | boolean | null)[]) => Number(args[0]) * 2);
    const { runtime, createContext } = harness({ callScript });
    const root: WorkflowDocumentV3['root'] = { id: 'root', kind: 'sequence', nodes: [
      { id: 'call', kind: 'callScript', scriptId: 'double', arguments: [number(21)], assignTo: 'answer', valueType: 'number' },
      { id: 'use', kind: 'set', name: 'answer', value: { kind: 'binary', valueType: 'number', operator: 'add', left: variable('answer'), right: number(1) } },
    ] };
    expect((await runtime.start(doc(root), createContext).completion).status).toBe('completed');
    expect(callScript).toHaveBeenCalledWith('double', [21], expect.any(AbortSignal));
  });
});
