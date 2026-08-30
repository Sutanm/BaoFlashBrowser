import type { ActionSpec } from './action';
import type { PersistedPoint } from './geometry';
import type { SurfaceSpec } from './surface';
import type { WorkflowDocumentV3, WorkflowNode } from './workflow-ir';
import { validateWorkflowDocument } from './workflow-validator';

export type RecorderContextV3 = { readonly surface?: SurfaceSpec };

type RecorderEventBase = {
  readonly timestampMs: number;
  readonly context?: RecorderContextV3;
};

export type RecorderEventV3 = RecorderEventBase & (
  | { readonly kind: 'click'; readonly point: PersistedPoint; readonly button?: 'primary' | 'middle' | 'secondary'; readonly count?: number }
  | { readonly kind: 'move'; readonly point: PersistedPoint; readonly durationMs?: number }
  | { readonly kind: 'drag'; readonly from: PersistedPoint; readonly to: PersistedPoint; readonly button?: 'primary' | 'middle' | 'secondary'; readonly durationMs?: number }
);

export type RecorderCompileOptionsV3 = {
  readonly id: string;
  readonly name: string;
  readonly waitThresholdMs?: number;
  readonly recordMoves?: boolean;
};

export class AutomationRecorderError extends Error {
  constructor(readonly code: 'EVENT_INVALID' | 'EVENT_ORDER_INVALID', message: string) {
    super(message);
    this.name = 'AutomationRecorderError';
  }
}

function assertPoint(point: PersistedPoint, label: string): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new AutomationRecorderError('EVENT_INVALID', `${label} must be finite`);
  if (point.unit === 'ratio' && (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1)) {
    throw new AutomationRecorderError('EVENT_INVALID', `${label} ratio must be inside [0,1]`);
  }
}

function actionFor(event: RecorderEventV3): ActionSpec {
  if (event.kind === 'click') {
    assertPoint(event.point, 'click point');
    return { kind: 'click', target: { locator: { kind: 'coordinate', point: event.point } }, button: event.button, count: event.count };
  }
  if (event.kind === 'move') {
    assertPoint(event.point, 'move point');
    return { kind: 'move', target: { locator: { kind: 'coordinate', point: event.point } }, durationMs: event.durationMs };
  }
  assertPoint(event.from, 'drag start');
  assertPoint(event.to, 'drag end');
  return {
    kind: 'drag',
    from: { locator: { kind: 'coordinate', point: event.from } },
    to: { locator: { kind: 'coordinate', point: event.to } },
    button: event.button,
    durationMs: event.durationMs,
  };
}

const literalNumber = (value: number) => ({ kind: 'literal' as const, valueType: 'number' as const, value });

export function compileRecorderEventsV3(events: readonly RecorderEventV3[], options: RecorderCompileOptionsV3): WorkflowDocumentV3 {
  const threshold = options.waitThresholdMs ?? 250;
  if (!Number.isFinite(threshold) || threshold < 0) throw new AutomationRecorderError('EVENT_INVALID', 'wait threshold must be non-negative and finite');
  const selected = options.recordMoves ? events : events.filter((event) => event.kind !== 'move');
  const rootNodes: WorkflowNode[] = [];
  let previousTimestamp: number | undefined;
  let sequence = 0;

  for (const event of selected) {
    if (!Number.isFinite(event.timestampMs) || event.timestampMs < 0) throw new AutomationRecorderError('EVENT_INVALID', 'event timestamp must be non-negative and finite');
    if (previousTimestamp !== undefined && event.timestampMs < previousTimestamp) throw new AutomationRecorderError('EVENT_ORDER_INVALID', 'recorder events must be ordered by timestamp');
    const gap = previousTimestamp === undefined ? 0 : event.timestampMs - previousTimestamp;
    if (gap >= threshold && gap > 0) rootNodes.push({ id: `recorded-wait-${sequence++}`, kind: 'wait', durationMs: literalNumber(gap) });
    const action: WorkflowNode = { id: `recorded-action-${sequence++}`, kind: 'action', action: actionFor(event) };
    rootNodes.push(event.context?.surface
      ? { id: `recorded-context-${sequence++}`, kind: 'with', surface: event.context.surface, body: action }
      : action);
    previousTimestamp = event.timestampMs;
  }

  const document: WorkflowDocumentV3 = {
    formatVersion: 3,
    id: options.id,
    name: options.name,
    root: { id: 'recorded-root', kind: 'sequence', nodes: rootNodes },
  };
  validateWorkflowDocument(document);
  return Object.freeze(document);
}

