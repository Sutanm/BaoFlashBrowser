import type { ActionSpec } from './action';
import type { LocatedTarget, LocatorSpec, TargetRef } from './locator';
import type { Point, Region } from './geometry';
import type { PersistedRegion, SurfaceSpec } from './surface';

export type RuntimeValue = null | boolean | number | string | Point | Region | LocatedTarget;
export type RuntimeValueType = 'null' | 'boolean' | 'number' | 'string' | 'point' | 'region' | 'located-target';

export type LiteralExpression = {
  readonly kind: 'literal';
  readonly valueType: 'null' | 'boolean' | 'number' | 'string';
  readonly value: null | boolean | number | string;
};
export type VariableExpression = { readonly kind: 'variable'; readonly valueType: RuntimeValueType; readonly name: string };
export type UnaryExpression = {
  readonly kind: 'unary';
  readonly valueType: 'boolean' | 'number';
  readonly operator: 'not' | 'negate';
  readonly operand: ValueExpression;
};
export type BinaryExpression = {
  readonly kind: 'binary';
  readonly valueType: 'boolean' | 'number' | 'string';
  readonly operator: 'and' | 'or' | 'equal' | 'notEqual' | 'less' | 'lessOrEqual' | 'greater' | 'greaterOrEqual'
    | 'add' | 'subtract' | 'multiply' | 'divide' | 'modulo' | 'concat';
  readonly left: ValueExpression;
  readonly right: ValueExpression;
};
export type ProjectExpression = {
  readonly kind: 'project';
  readonly valueType: 'number' | 'string';
  readonly source: ValueExpression<'point' | 'region' | 'located-target'>;
  readonly field: 'x' | 'y' | 'width' | 'height' | 'confidence' | 'locatorFingerprint';
};

export type ValueExpression<T extends RuntimeValueType = RuntimeValueType> =
  | (LiteralExpression & { readonly valueType: T })
  | (VariableExpression & { readonly valueType: T })
  | (UnaryExpression & { readonly valueType: T })
  | (BinaryExpression & { readonly valueType: T })
  | (ProjectExpression & { readonly valueType: T });

export type FindQuery = { readonly kind: 'find'; readonly resultType: 'located-target'; readonly target: TargetRef };
export type ExistsQuery = { readonly kind: 'exists'; readonly resultType: 'boolean'; readonly locator: LocatorSpec };
export type ReadTextQuery = { readonly kind: 'readText'; readonly resultType: 'string'; readonly region?: PersistedRegion; readonly minConfidence?: number };
export type ReadNumberQuery = { readonly kind: 'readNumber'; readonly resultType: 'number'; readonly region?: PersistedRegion; readonly locale?: string };
export interface RuntimeQuerySpecMap {
  readonly find: FindQuery;
  readonly exists: ExistsQuery;
  readonly readText: ReadTextQuery;
  readonly readNumber: ReadNumberQuery;
}
export type RuntimeQuerySpec = RuntimeQuerySpecMap[keyof RuntimeQuerySpecMap];

export type NodeBase = { readonly id: string };
export type SequenceNode = NodeBase & { readonly kind: 'sequence'; readonly nodes: readonly WorkflowNode[] };
export type IfNode = NodeBase & {
  readonly kind: 'if';
  readonly condition: ValueExpression<'boolean'>;
  readonly then: WorkflowNode;
  readonly else?: WorkflowNode;
};
export type LoopNode = NodeBase & (
  | { readonly kind: 'loop'; readonly mode: 'repeat'; readonly count: ValueExpression<'number'>; readonly body: WorkflowNode }
  | { readonly kind: 'loop'; readonly mode: 'while'; readonly condition: ValueExpression<'boolean'>; readonly body: WorkflowNode }
);
export type BreakNode = NodeBase & { readonly kind: 'break' };
export type ContinueNode = NodeBase & { readonly kind: 'continue' };
export type WaitNode = NodeBase & (
  | { readonly kind: 'wait'; readonly durationMs: ValueExpression<'number'> }
  | { readonly kind: 'wait'; readonly query: RuntimeQuerySpec; readonly until: 'truthy' | 'falsy'; readonly timeoutMs: number; readonly pollIntervalMs?: number; readonly onTimeout: 'fail' | 'continue' }
);
export type ActionNode = NodeBase & { readonly kind: 'action'; readonly action: ActionSpec };
export type QueryNode = NodeBase & {
  readonly kind: 'query';
  readonly query: RuntimeQuerySpec;
  readonly assignTo: string;
  readonly valueType: RuntimeValueType;
};
export type LetNode = NodeBase & {
  readonly kind: 'let';
  readonly name: string;
  readonly valueType: RuntimeValueType;
  readonly value: ValueExpression;
};
export type SetNode = NodeBase & { readonly kind: 'set'; readonly name: string; readonly value: ValueExpression };
export type CallScriptNode = NodeBase & {
  readonly kind: 'callScript';
  readonly scriptId: string;
  readonly arguments: readonly ValueExpression[];
  readonly assignTo?: string;
  readonly valueType?: 'null' | 'boolean' | 'number' | 'string';
};
export type WithContextNode = NodeBase & {
  readonly kind: 'with';
  readonly surface?: SurfaceSpec;
  readonly region?: PersistedRegion;
  readonly timeoutMs?: number;
  readonly frameReuse?: { readonly mode: 'fresh' | 'reuse-compatible'; readonly maxAgeMs?: number };
  readonly body: WorkflowNode;
};

export type WorkflowNode = SequenceNode | IfNode | LoopNode | BreakNode | ContinueNode | WaitNode
  | ActionNode | QueryNode | LetNode | SetNode | CallScriptNode | WithContextNode;

export type WorkflowDocumentV3 = {
  readonly formatVersion: 3;
  readonly id: string;
  readonly name: string;
  readonly root: WorkflowNode;
};
