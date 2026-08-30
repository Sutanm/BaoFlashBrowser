import { validateSurfaceSpec, type SurfaceSpecRegistry } from './surface';
import type { RuntimeValue, RuntimeValueType, ValueExpression, WorkflowDocumentV3, WorkflowNode } from './workflow-ir';

export type WorkflowValidationErrorCode =
  | 'DOCUMENT_INVALID' | 'NODE_INVALID' | 'NODE_DUPLICATE' | 'BUDGET_EXCEEDED'
  | 'VARIABLE_INVALID' | 'EXPRESSION_INVALID' | 'CONTROL_SCOPE_INVALID';

export class WorkflowValidationError extends Error {
  constructor(readonly code: WorkflowValidationErrorCode, message: string, readonly nodeId?: string) {
    super(message);
    this.name = 'WorkflowValidationError';
  }
}

export type WorkflowValidationLimits = {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxBindings: number;
  readonly maxStringLength: number;
};

export const DEFAULT_WORKFLOW_VALIDATION_LIMITS: WorkflowValidationLimits = Object.freeze({
  maxDepth: 64,
  maxNodes: 100_000,
  maxBindings: 256,
  maxStringLength: 10_000,
});

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;

function runtimeType(value: RuntimeValue): RuntimeValueType {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  if ('activationPoint' in value) return 'located-target';
  if ('dx' in value) throw new WorkflowValidationError('EXPRESSION_INVALID', 'vectors are not runtime values');
  return 'width' in value ? 'region' : 'point';
}

function assertFiniteDuration(value: number, label: string, nodeId: string): void {
  if (!Number.isFinite(value) || value < 0) throw new WorkflowValidationError('NODE_INVALID', `${label} must be non-negative and finite`, nodeId);
}

function validateExpression(
  expression: ValueExpression,
  bindings: ReadonlyMap<string, RuntimeValueType>,
  limits: WorkflowValidationLimits,
  nodeId: string,
): RuntimeValueType {
  if (expression.kind === 'literal') {
    if (runtimeType(expression.value) !== expression.valueType) throw new WorkflowValidationError('EXPRESSION_INVALID', 'literal valueType does not match value', nodeId);
    if (typeof expression.value === 'number' && !Number.isFinite(expression.value)) throw new WorkflowValidationError('EXPRESSION_INVALID', 'number literal must be finite', nodeId);
    if (typeof expression.value === 'string' && expression.value.length > limits.maxStringLength) throw new WorkflowValidationError('BUDGET_EXCEEDED', 'string literal budget exceeded', nodeId);
    return expression.valueType;
  }
  if (expression.kind === 'variable') {
    const declared = bindings.get(expression.name);
    if (!declared) throw new WorkflowValidationError('VARIABLE_INVALID', `variable is not declared: ${expression.name}`, nodeId);
    if (declared !== expression.valueType) throw new WorkflowValidationError('EXPRESSION_INVALID', `variable type mismatch: ${expression.name}`, nodeId);
    return declared;
  }
  if (expression.kind === 'unary') {
    const operand = validateExpression(expression.operand, bindings, limits, nodeId);
    const required = expression.operator === 'not' ? 'boolean' : 'number';
    if (operand !== required || expression.valueType !== required) throw new WorkflowValidationError('EXPRESSION_INVALID', `invalid ${expression.operator} operand`, nodeId);
    return required;
  }
  if (expression.kind === 'project') {
    const source = validateExpression(expression.source, bindings, limits, nodeId);
    const fields: Record<string, Readonly<Record<string, RuntimeValueType>>> = {
      point: { x: 'number', y: 'number' },
      region: { x: 'number', y: 'number', width: 'number', height: 'number' },
      'located-target': { confidence: 'number', locatorFingerprint: 'string' },
    };
    const projected = fields[source]?.[expression.field];
    if (!projected || projected !== expression.valueType) throw new WorkflowValidationError('EXPRESSION_INVALID', `field ${expression.field} is not available on ${source}`, nodeId);
    return projected;
  }
  const left = validateExpression(expression.left, bindings, limits, nodeId);
  const right = validateExpression(expression.right, bindings, limits, nodeId);
  const boolean = ['and', 'or'];
  const comparison = ['equal', 'notEqual'];
  const ordered = ['less', 'lessOrEqual', 'greater', 'greaterOrEqual'];
  const arithmetic = ['add', 'subtract', 'multiply', 'divide', 'modulo'];
  let result: RuntimeValueType;
  if (boolean.includes(expression.operator)) result = left === 'boolean' && right === 'boolean' ? 'boolean' : 'null';
  else if (comparison.includes(expression.operator)) result = left === right ? 'boolean' : 'null';
  else if (ordered.includes(expression.operator)) result = left === right && (left === 'number' || left === 'string') ? 'boolean' : 'null';
  else if (arithmetic.includes(expression.operator)) result = left === 'number' && right === 'number' ? 'number' : 'null';
  else result = left === 'string' && right === 'string' ? 'string' : 'null';
  if (result === 'null' || result !== expression.valueType) throw new WorkflowValidationError('EXPRESSION_INVALID', `invalid binary expression: ${expression.operator}`, nodeId);
  return result;
}

export function validateWorkflowDocument(
  document: WorkflowDocumentV3,
  customLimits: Partial<WorkflowValidationLimits> = {},
  namedSurfaces?: SurfaceSpecRegistry,
): void {
  const limits = { ...DEFAULT_WORKFLOW_VALIDATION_LIMITS, ...customLimits };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new WorkflowValidationError('BUDGET_EXCEEDED', `validation limit ${name} must be a positive safe integer`);
  }
  if (document.formatVersion !== 3 || !document.id.trim() || !document.name.trim()) throw new WorkflowValidationError('DOCUMENT_INVALID', 'workflow v3 requires id and name');
  const ids = new Set<string>();
  let nodeCount = 0;

  const visit = (node: WorkflowNode, bindings: Map<string, RuntimeValueType>, depth: number, loopDepth: number): void => {
    if (depth > limits.maxDepth) throw new WorkflowValidationError('BUDGET_EXCEEDED', `workflow nesting exceeds ${limits.maxDepth}`, node.id);
    nodeCount += 1;
    if (nodeCount > limits.maxNodes) throw new WorkflowValidationError('BUDGET_EXCEEDED', `workflow nodes exceed ${limits.maxNodes}`, node.id);
    if (!node.id.trim()) throw new WorkflowValidationError('NODE_INVALID', 'node id is required');
    if (ids.has(node.id)) throw new WorkflowValidationError('NODE_DUPLICATE', `duplicate node id: ${node.id}`, node.id);
    ids.add(node.id);

    if (node.kind === 'sequence') {
      const sequenceBindings = new Map(bindings);
      for (const child of node.nodes) {
        visit(child, sequenceBindings, depth + 1, loopDepth);
        if (child.kind === 'let' || child.kind === 'query' || (child.kind === 'callScript' && child.assignTo && child.valueType)) {
          sequenceBindings.set(child.kind === 'let' ? child.name : child.assignTo!, child.valueType!);
        }
      }
      return;
    }
    if (node.kind === 'if') {
      if (validateExpression(node.condition, bindings, limits, node.id) !== 'boolean') throw new WorkflowValidationError('EXPRESSION_INVALID', 'if condition must be boolean', node.id);
      visit(node.then, new Map(bindings), depth + 1, loopDepth);
      if (node.else) visit(node.else, new Map(bindings), depth + 1, loopDepth);
      return;
    }
    if (node.kind === 'loop') {
      if (node.mode === 'repeat' && validateExpression(node.count, bindings, limits, node.id) !== 'number') throw new WorkflowValidationError('EXPRESSION_INVALID', 'repeat count must be a number', node.id);
      if (node.mode === 'while' && validateExpression(node.condition, bindings, limits, node.id) !== 'boolean') throw new WorkflowValidationError('EXPRESSION_INVALID', 'while condition must be boolean', node.id);
      visit(node.body, new Map(bindings), depth + 1, loopDepth + 1);
      return;
    }
    if (node.kind === 'break' || node.kind === 'continue') {
      if (loopDepth === 0) throw new WorkflowValidationError('CONTROL_SCOPE_INVALID', `${node.kind} must be inside a loop`, node.id);
      return;
    }
    if (node.kind === 'wait') {
      if ('durationMs' in node) {
        if (validateExpression(node.durationMs, bindings, limits, node.id) !== 'number') throw new WorkflowValidationError('EXPRESSION_INVALID', 'wait duration must be a number', node.id);
      }
      else {
        assertFiniteDuration(node.timeoutMs, 'wait timeout', node.id);
        if (node.pollIntervalMs !== undefined) assertFiniteDuration(node.pollIntervalMs, 'wait poll interval', node.id);
      }
      return;
    }
    if (node.kind === 'let') {
      if (!IDENTIFIER.test(node.name) || bindings.has(node.name)) throw new WorkflowValidationError('VARIABLE_INVALID', `invalid or duplicate variable: ${node.name}`, node.id);
      if (bindings.size >= limits.maxBindings) throw new WorkflowValidationError('BUDGET_EXCEEDED', `active bindings exceed ${limits.maxBindings}`, node.id);
      if (validateExpression(node.value, bindings, limits, node.id) !== node.valueType) throw new WorkflowValidationError('EXPRESSION_INVALID', `let type mismatch: ${node.name}`, node.id);
      return;
    }
    if (node.kind === 'query') {
      if (!IDENTIFIER.test(node.assignTo) || bindings.has(node.assignTo)) throw new WorkflowValidationError('VARIABLE_INVALID', `invalid or duplicate variable: ${node.assignTo}`, node.id);
      if (bindings.size >= limits.maxBindings) throw new WorkflowValidationError('BUDGET_EXCEEDED', `active bindings exceed ${limits.maxBindings}`, node.id);
      if (node.valueType !== node.query.resultType) throw new WorkflowValidationError('VARIABLE_INVALID', `query result type mismatch: ${node.assignTo}`, node.id);
      return;
    }
    if (node.kind === 'set') {
      const declared = bindings.get(node.name);
      if (!declared) throw new WorkflowValidationError('VARIABLE_INVALID', `cannot set undeclared variable: ${node.name}`, node.id);
      if (validateExpression(node.value, bindings, limits, node.id) !== declared) throw new WorkflowValidationError('EXPRESSION_INVALID', `set type mismatch: ${node.name}`, node.id);
      return;
    }
    if (node.kind === 'callScript') {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(node.scriptId)) throw new WorkflowValidationError('NODE_INVALID', 'script call requires a valid script id', node.id);
      if (node.arguments.length > 16) throw new WorkflowValidationError('BUDGET_EXCEEDED', 'script argument limit exceeded', node.id);
      node.arguments.forEach((argument) => validateExpression(argument, bindings, limits, node.id));
      if ((node.assignTo === undefined) !== (node.valueType === undefined)) throw new WorkflowValidationError('VARIABLE_INVALID', 'script result name and type must be provided together', node.id);
      if (node.assignTo && (!IDENTIFIER.test(node.assignTo) || bindings.has(node.assignTo))) throw new WorkflowValidationError('VARIABLE_INVALID', `invalid or duplicate variable: ${node.assignTo}`, node.id);
      return;
    }
    if (node.kind === 'with') {
      if (node.surface) validateSurfaceSpec(node.surface, { named: namedSurfaces, allowUnresolvedNamed: !namedSurfaces });
      if (node.region) validateSurfaceSpec({ kind: 'region', parent: { kind: 'viewport' }, region: node.region });
      if (node.timeoutMs !== undefined) assertFiniteDuration(node.timeoutMs, 'context timeout', node.id);
      if (node.frameReuse?.maxAgeMs !== undefined) assertFiniteDuration(node.frameReuse.maxAgeMs, 'frame max age', node.id);
      visit(node.body, new Map(bindings), depth + 1, loopDepth);
    }
  };

  visit(document.root, new Map(), 1, 0);
}
