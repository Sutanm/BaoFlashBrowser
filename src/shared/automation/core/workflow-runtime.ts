import type { ActionContext } from './action';
import { AutomationActionRegistry } from './action';
import { AutomationExpressionEvaluator } from './expression-evaluator';
import { AutomationRuntimeQueryRegistry } from './runtime-query';
import type { PersistedRegion, SurfaceSpec, SurfaceSpecRegistry } from './surface';
import type { RuntimeValue, RuntimeValueType, WorkflowDocumentV3, WorkflowNode } from './workflow-ir';
import { DEFAULT_WORKFLOW_VALIDATION_LIMITS, validateWorkflowDocument } from './workflow-validator';
import { createAutomationAbortController } from '../abort-controller';

export type RuntimeContextChange = {
  readonly surface?: SurfaceSpec;
  readonly region?: PersistedRegion;
  readonly timeoutMs?: number;
  readonly frameReuse?: { readonly mode: 'fresh' | 'reuse-compatible'; readonly maxAgeMs?: number };
};

export type RuntimeContextLease = {
  readonly context: RuntimeExecutionContext;
  release(): Promise<void>;
};

export type RuntimeExecutionContext = ActionContext & {
  readonly sleep: (durationMs: number, signal: AbortSignal) => Promise<void>;
  derive?(change: RuntimeContextChange): Promise<RuntimeContextLease>;
  callScript?(scriptId: string, args: readonly RuntimeValue[], signal: AbortSignal): Promise<RuntimeValue>;
};

export interface RuntimeResourceBarrier {
  close(): Promise<void>;
}

export type WorkflowRuntimeLimits = {
  readonly maxExecutedNodes: number;
  readonly maxLoopIterations: number;
  readonly maxWallTimeMs: number;
  readonly maxBindings: number;
  readonly yieldEveryNodes: number;
  readonly yieldEveryMs: number;
  readonly maxHistoryEvents: number;
};

export const DEFAULT_WORKFLOW_RUNTIME_LIMITS: WorkflowRuntimeLimits = Object.freeze({
  maxExecutedNodes: 100_000,
  maxLoopIterations: 10_000,
  maxWallTimeMs: 30 * 60 * 1_000,
  maxBindings: 256,
  yieldEveryNodes: 100,
  yieldEveryMs: 8,
  maxHistoryEvents: 1_000,
});

export type WorkflowRunState = 'created' | 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed';
export type WorkflowRunEvent =
  | { readonly kind: 'state'; readonly at: number; readonly state: WorkflowRunState }
  | { readonly kind: 'node-start' | 'node-end'; readonly at: number; readonly nodeId: string; readonly nodeKind: WorkflowNode['kind'] }
  | { readonly kind: 'diagnostic'; readonly at: number; readonly message: string };
export type WorkflowRunResult =
  | { readonly status: 'completed'; readonly runId: string; readonly executedNodes: number; readonly durationMs: number }
  | { readonly status: 'cancelled'; readonly runId: string; readonly executedNodes: number; readonly durationMs: number; readonly reason: string }
  | { readonly status: 'failed'; readonly runId: string; readonly executedNodes: number; readonly durationMs: number; readonly error: Error };

export type WorkflowRunHandle = {
  readonly runId: string;
  readonly completion: Promise<WorkflowRunResult>;
  readonly state: WorkflowRunState;
  readonly history: readonly WorkflowRunEvent[];
  cancel(reason?: string): Promise<WorkflowRunResult>;
  subscribe(listener: (event: WorkflowRunEvent) => void): () => void;
};

export class WorkflowRuntimeError extends Error {
  constructor(readonly code: 'BUDGET_EXCEEDED' | 'RUNTIME_TYPE' | 'CONTEXT_UNAVAILABLE', message: string, readonly nodeId?: string) {
    super(message);
    this.name = 'WorkflowRuntimeError';
  }
}

function runtimeValueType(value: RuntimeValue): RuntimeValueType {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  if ('activationPoint' in value) return 'located-target';
  return 'width' in value ? 'region' : 'point';
}

class RuntimeEnvironment {
  private readonly values = new Map<string, { type: RuntimeValueType; value: RuntimeValue }>();
  constructor(private readonly parent?: RuntimeEnvironment) {}

  get(name: string): RuntimeValue | undefined { return this.values.get(name)?.value ?? this.parent?.get(name); }
  activeCount(): number { return this.values.size + (this.parent?.activeCount() ?? 0); }
  declare(name: string, type: RuntimeValueType, value: RuntimeValue, maxBindings: number): void {
    if (this.activeCount() >= maxBindings) throw new WorkflowRuntimeError('BUDGET_EXCEEDED', 'runtime binding budget exceeded');
    if (runtimeValueType(value) !== type) throw new WorkflowRuntimeError('RUNTIME_TYPE', `runtime binding type mismatch: ${name}`);
    this.values.set(name, { type, value });
  }
  set(name: string, value: RuntimeValue): void {
    const current = this.values.get(name);
    if (current) {
      if (runtimeValueType(value) !== current.type) throw new WorkflowRuntimeError('RUNTIME_TYPE', `runtime binding type mismatch: ${name}`);
      this.values.set(name, { ...current, value }); return;
    }
    if (this.parent) { this.parent.set(name, value); return; }
    throw new WorkflowRuntimeError('RUNTIME_TYPE', `runtime variable is not bound: ${name}`);
  }
}

const BREAK = Symbol('break');
const CONTINUE = Symbol('continue');
type Control = typeof BREAK | typeof CONTINUE | undefined;
let nextRunId = 1;

/** Minimum pause between forever-loop iterations so an empty body cannot spin the CPU. */
const FOREVER_LOOP_MIN_GAP_MS = 16;

export class AutomationWorkflowRuntime {
  private readonly limits: WorkflowRuntimeLimits;
  private readonly expressions: AutomationExpressionEvaluator;

  constructor(
    private readonly actions: AutomationActionRegistry,
    private readonly queries: AutomationRuntimeQueryRegistry,
    private readonly options: {
      readonly limits?: Partial<WorkflowRuntimeLimits>;
      readonly expressions?: AutomationExpressionEvaluator;
      readonly namedSurfaces?: SurfaceSpecRegistry;
    } = {},
  ) {
    if (!actions.isFrozen || !queries.isFrozen) throw new WorkflowRuntimeError('CONTEXT_UNAVAILABLE', 'runtime registries must be frozen before construction');
    this.limits = { ...DEFAULT_WORKFLOW_RUNTIME_LIMITS, ...options.limits };
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isFinite(value) || value < 0) throw new WorkflowRuntimeError('BUDGET_EXCEEDED', `invalid runtime limit ${name}: ${value}`);
    }
    for (const name of ['maxExecutedNodes', 'maxLoopIterations', 'maxBindings', 'yieldEveryNodes', 'maxHistoryEvents'] as const) {
      if (!Number.isSafeInteger(this.limits[name]) || this.limits[name] < 1) throw new WorkflowRuntimeError('BUDGET_EXCEEDED', `runtime limit ${name} must be a positive safe integer`);
    }
    this.expressions = options.expressions ?? new AutomationExpressionEvaluator();
  }

  start(
    document: WorkflowDocumentV3,
    createContext: (signal: AbortSignal) => RuntimeExecutionContext,
    resources: readonly RuntimeResourceBarrier[] = [],
    profileVariables: Readonly<Record<string, null | boolean | number | string>> = {},
  ): WorkflowRunHandle {
    validateWorkflowDocument(document, {
      maxNodes: Math.min(DEFAULT_WORKFLOW_VALIDATION_LIMITS.maxNodes, this.limits.maxExecutedNodes),
      maxBindings: this.limits.maxBindings,
    }, this.options.namedSurfaces);
    const runId = `run-${nextRunId++}`;
    const controller = createAutomationAbortController();
    const listeners = new Set<(event: WorkflowRunEvent) => void>();
    const events: WorkflowRunEvent[] = [];
    let state: WorkflowRunState = 'created';
    let cancelReason = 'cancelled by user';
    let executedNodes = 0;
    let completionResult: WorkflowRunResult | undefined;
    let executionSettled = false;
    const context = createContext(controller.signal);
    const startedAt = context.now();
    let lastYieldAt = startedAt;
    let nodesSinceYield = 0;
    let unboundedRuntime = false;

    const emit = (event: WorkflowRunEvent): void => {
      events.push(event);
      if (events.length > this.limits.maxHistoryEvents) events.splice(0, events.length - this.limits.maxHistoryEvents);
      for (const listener of listeners) { try { listener(event); } catch { /* observer isolation */ } }
    };
    const transition = (next: WorkflowRunState): void => { state = next; emit({ kind: 'state', at: context.now(), state: next }); };
    const check = async (nodeId?: string): Promise<void> => {
      if (controller.signal.aborted) throw new Error('automation cancelled');
      if (!unboundedRuntime && context.now() - startedAt > this.limits.maxWallTimeMs) throw new WorkflowRuntimeError('BUDGET_EXCEEDED', 'workflow wall-clock budget exceeded', nodeId);
      if (!unboundedRuntime && executedNodes > this.limits.maxExecutedNodes) throw new WorkflowRuntimeError('BUDGET_EXCEEDED', 'executed node budget exceeded', nodeId);
      nodesSinceYield += 1;
      if (nodesSinceYield >= this.limits.yieldEveryNodes || context.now() - lastYieldAt >= this.limits.yieldEveryMs) {
        if (controller.signal.aborted) throw new Error('automation cancelled');
        await context.sleep(0, controller.signal);
        nodesSinceYield = 0;
        lastYieldAt = context.now();
      }
    };
    const evaluate = (expression: Parameters<AutomationExpressionEvaluator['evaluate']>[0], environment: RuntimeEnvironment): RuntimeValue => this.expressions.evaluate(expression, environment);
    const truthyQuery = (value: RuntimeValue): boolean => value !== null && value !== false;

    const execute = async (node: WorkflowNode, environment: RuntimeEnvironment, activeContext: RuntimeExecutionContext): Promise<Control> => {
      executedNodes += 1;
      await check(node.id);
      emit({ kind: 'node-start', at: context.now(), nodeId: node.id, nodeKind: node.kind });
      let control: Control;
      if (node.kind === 'sequence') {
        const scope = new RuntimeEnvironment(environment);
        for (const child of node.nodes) {
          control = await execute(child, scope, activeContext);
          if (control) break;
        }
      } else if (node.kind === 'if') {
        const condition = evaluate(node.condition, environment);
        if (typeof condition !== 'boolean') throw new WorkflowRuntimeError('RUNTIME_TYPE', 'if condition is not boolean', node.id);
        if (condition) control = await execute(node.then, new RuntimeEnvironment(environment), activeContext);
        else if (node.else) control = await execute(node.else, new RuntimeEnvironment(environment), activeContext);
      } else if (node.kind === 'loop') {
        const repeat = node.mode === 'repeat' ? evaluate(node.count, environment) : undefined;
        if (repeat !== undefined && (!Number.isSafeInteger(repeat) || typeof repeat !== 'number' || repeat < 0)) throw new WorkflowRuntimeError('RUNTIME_TYPE', 'repeat count must be a non-negative safe integer', node.id);
        let iterations = 0;
        // A forever loop is the only construct allowed to outlive the
        // wall-clock/node/iteration budgets (the user's cancel is the sole
        // terminator). Scope the flag so that breaking out of the loop —
        // or an error propagating from its body — restores budget checks for
        // whatever runs afterwards; it must not leak past the loop.
        const previousUnbounded = unboundedRuntime;
        if (node.mode === 'forever') unboundedRuntime = true;
        try {
          while (node.mode === 'repeat' ? iterations < (repeat as number) : node.mode === 'forever' || evaluate(node.condition, environment) === true) {
            iterations += 1;
            if (node.mode !== 'forever' && iterations > this.limits.maxLoopIterations) throw new WorkflowRuntimeError('BUDGET_EXCEEDED', 'loop iteration budget exceeded', node.id);
            await check(node.id);
            const result = await execute(node.body, new RuntimeEnvironment(environment), activeContext);
            if (result === BREAK) break;
            // A forever body that is purely CPU-bound would otherwise spin at
            // full speed; the fixed gap keeps it responsive to cancellation
            // and to the rest of the system without needing a wait block.
            // It applies to continue and normal iteration ends alike.
            if (node.mode === 'forever') await activeContext.sleep(FOREVER_LOOP_MIN_GAP_MS, controller.signal);
            if (result === CONTINUE) continue;
          }
        } finally {
          unboundedRuntime = previousUnbounded;
        }
      } else if (node.kind === 'break') control = BREAK;
      else if (node.kind === 'continue') control = CONTINUE;
      else if (node.kind === 'action') await this.actions.execute(node.action, activeContext);
      else if (node.kind === 'query') {
        const value = await this.queries.execute(node.query, activeContext);
        environment.declare(node.assignTo, node.valueType, value, this.limits.maxBindings);
      } else if (node.kind === 'let') {
        const profileValue = Object.prototype.hasOwnProperty.call(profileVariables, node.name) ? profileVariables[node.name] : undefined;
        environment.declare(node.name, node.valueType, profileValue !== undefined ? profileValue : evaluate(node.value, environment), this.limits.maxBindings);
      } else if (node.kind === 'set') environment.set(node.name, evaluate(node.value, environment));
      else if (node.kind === 'callScript') {
        if (!activeContext.callScript) throw new WorkflowRuntimeError('CONTEXT_UNAVAILABLE', 'script calls are unavailable', node.id);
        const value = await activeContext.callScript(node.scriptId, node.arguments.map((argument) => evaluate(argument, environment)), activeContext.signal);
        if (node.assignTo && node.valueType) environment.declare(node.assignTo, node.valueType, value, this.limits.maxBindings);
      }
      else if (node.kind === 'wait') {
        if ('durationMs' in node) {
          const duration = evaluate(node.durationMs, environment);
          if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) throw new WorkflowRuntimeError('RUNTIME_TYPE', 'wait duration must be non-negative and finite', node.id);
          if (controller.signal.aborted) throw new Error('automation cancelled');
          await activeContext.sleep(duration, controller.signal);
        } else {
          const deadline = context.now() + node.timeoutMs;
          for (;;) {
            const truthy = truthyQuery(await this.queries.execute(node.query, activeContext));
            if (node.until === 'truthy' ? truthy : !truthy) break;
            const remaining = deadline - context.now();
            if (remaining <= 0) {
              if (node.onTimeout === 'fail') throw new WorkflowRuntimeError('BUDGET_EXCEEDED', `wait timed out after ${node.timeoutMs}ms`, node.id);
              break;
            }
            if (controller.signal.aborted) throw new Error('automation cancelled');
            await activeContext.sleep(Math.min(node.pollIntervalMs ?? 0, remaining), controller.signal);
            await check(node.id);
          }
        }
      } else if (node.kind === 'with') {
        if (!activeContext.derive) throw new WorkflowRuntimeError('CONTEXT_UNAVAILABLE', 'runtime context derivation is unavailable', node.id);
        const lease = await activeContext.derive({ surface: node.surface, region: node.region, timeoutMs: node.timeoutMs, frameReuse: node.frameReuse });
        try { control = await execute(node.body, new RuntimeEnvironment(environment), lease.context); }
        finally { await lease.release(); }
      }
      emit({ kind: 'node-end', at: context.now(), nodeId: node.id, nodeKind: node.kind });
      return control;
    };

    transition('running');
    const completion = (async (): Promise<WorkflowRunResult> => {
      let result: WorkflowRunResult;
      let terminalState: Extract<WorkflowRunState, 'completed' | 'cancelled' | 'failed'>;
      try {
        await execute(document.root, new RuntimeEnvironment(), context);
        terminalState = 'completed';
        result = { status: 'completed', runId, executedNodes, durationMs: context.now() - startedAt };
      } catch (error) {
        if (controller.signal.aborted) {
          terminalState = 'cancelled';
          result = { status: 'cancelled', runId, executedNodes, durationMs: context.now() - startedAt, reason: cancelReason };
        } else {
          terminalState = 'failed';
          result = { status: 'failed', runId, executedNodes, durationMs: context.now() - startedAt, error: error instanceof Error ? error : new Error(String(error)) };
        }
      } finally {
        executionSettled = true;
        for (const resource of [...resources].reverse()) {
          try { await resource.close(); }
          catch (error) { emit({ kind: 'diagnostic', at: context.now(), message: `resource close failed: ${error instanceof Error ? error.message : String(error)}` }); }
        }
      }
      completionResult = result!;
      transition(terminalState!);
      return completionResult;
    })();

    return {
      runId,
      completion,
      get state() { return state; },
      get history() { return Object.freeze([...events]); },
      async cancel(reason = 'cancelled by user') {
        if (completionResult) return completionResult;
        if (executionSettled) return completion;
        cancelReason = reason;
        transition('cancelling');
        controller.abort();
        return completion;
      },
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    };
  }
}
