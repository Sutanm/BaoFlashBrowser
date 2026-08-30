import type { RuntimeValue, RuntimeValueType, ValueExpression } from './workflow-ir';

export interface RuntimeBindings {
  get(name: string): RuntimeValue | undefined;
}

export class ExpressionEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpressionEvaluationError';
  }
}

export type ExpressionEvaluationLimits = {
  readonly maxOperations: number;
  readonly maxStringLength: number;
};

const DEFAULT_LIMITS: ExpressionEvaluationLimits = Object.freeze({ maxOperations: 1_000, maxStringLength: 10_000 });

function valueType(value: RuntimeValue): RuntimeValueType {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') return 'string';
  if ('activationPoint' in value) return 'located-target';
  return 'width' in value ? 'region' : 'point';
}

function expectType<T extends RuntimeValue>(value: RuntimeValue, type: RuntimeValueType, label: string): T {
  if (valueType(value) !== type) throw new ExpressionEvaluationError(`${label} requires ${type}`);
  return value as T;
}

export class AutomationExpressionEvaluator {
  private readonly limits: ExpressionEvaluationLimits;

  constructor(limits: Partial<ExpressionEvaluationLimits> = {}) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    if (!Number.isSafeInteger(this.limits.maxOperations) || this.limits.maxOperations < 1
      || !Number.isSafeInteger(this.limits.maxStringLength) || this.limits.maxStringLength < 1) {
      throw new ExpressionEvaluationError('expression limits must be positive safe integers');
    }
  }

  evaluate(expression: ValueExpression, bindings: RuntimeBindings): RuntimeValue {
    let operations = 0;
    const visit = (current: ValueExpression): RuntimeValue => {
      operations += 1;
      if (operations > this.limits.maxOperations) throw new ExpressionEvaluationError('expression operation budget exceeded');
      if (current.kind === 'literal') return current.value;
      if (current.kind === 'variable') {
        const value = bindings.get(current.name);
        if (value === undefined) throw new ExpressionEvaluationError(`variable is not bound: ${current.name}`);
        if (valueType(value) !== current.valueType) throw new ExpressionEvaluationError(`runtime variable type mismatch: ${current.name}`);
        return value;
      }
      if (current.kind === 'unary') {
        const operand = visit(current.operand);
        return current.operator === 'not'
          ? !expectType<boolean>(operand, 'boolean', 'not')
          : -expectType<number>(operand, 'number', 'negate');
      }
      if (current.kind === 'project') {
        const source = visit(current.source);
        if (source === null || typeof source !== 'object' || !(current.field in source)) {
          throw new ExpressionEvaluationError(`projected field is unavailable: ${current.field}`);
        }
        const projected = (source as unknown as Record<string, RuntimeValue | undefined>)[current.field];
        if (projected === undefined || valueType(projected) !== current.valueType) throw new ExpressionEvaluationError(`projected field type mismatch: ${current.field}`);
        return projected;
      }
      const left = visit(current.left);
      if (current.operator === 'and') return expectType<boolean>(left, 'boolean', 'and') && expectType<boolean>(visit(current.right), 'boolean', 'and');
      if (current.operator === 'or') return expectType<boolean>(left, 'boolean', 'or') || expectType<boolean>(visit(current.right), 'boolean', 'or');
      const right = visit(current.right);
      if (current.operator === 'equal') return Object.is(left, right);
      if (current.operator === 'notEqual') return !Object.is(left, right);
      if (current.operator === 'concat') {
        const result = expectType<string>(left, 'string', 'concat') + expectType<string>(right, 'string', 'concat');
        if (result.length > this.limits.maxStringLength) throw new ExpressionEvaluationError('expression string budget exceeded');
        return result;
      }
      if (['less', 'lessOrEqual', 'greater', 'greaterOrEqual'].includes(current.operator)) {
        if (typeof left !== typeof right || (typeof left !== 'number' && typeof left !== 'string')) throw new ExpressionEvaluationError(`${current.operator} requires matching number or string operands`);
        const ordered = typeof left === 'number'
          ? left - expectType<number>(right, 'number', current.operator)
          : left.localeCompare(expectType<string>(right, 'string', current.operator));
        if (current.operator === 'less') return ordered < 0;
        if (current.operator === 'lessOrEqual') return ordered <= 0;
        if (current.operator === 'greater') return ordered > 0;
        return ordered >= 0;
      }
      const first = expectType<number>(left, 'number', current.operator);
      const second = expectType<number>(right, 'number', current.operator);
      if ((current.operator === 'divide' || current.operator === 'modulo') && second === 0) throw new ExpressionEvaluationError('division by zero');
      const result = current.operator === 'add' ? first + second
        : current.operator === 'subtract' ? first - second
          : current.operator === 'multiply' ? first * second
            : current.operator === 'divide' ? first / second
              : first % second;
      if (!Number.isFinite(result)) throw new ExpressionEvaluationError('numeric result is not finite');
      return result;
    };
    const result = visit(expression);
    if (valueType(result) !== expression.valueType) throw new ExpressionEvaluationError('expression result type mismatch');
    return result;
  }
}
