import { describe, expect, it } from 'vitest';
import { AutomationExpressionEvaluator } from '../src/shared/automation/core';

const bindings = (values: Record<string, null | boolean | number | string>) => ({ get: (name: string) => values[name] });

describe('AutomationExpressionEvaluator', () => {
  it('evaluates typed arithmetic and comparisons', () => {
    const evaluator = new AutomationExpressionEvaluator();
    expect(evaluator.evaluate({ kind: 'binary', valueType: 'number', operator: 'multiply',
      left: { kind: 'variable', valueType: 'number', name: 'price' },
      right: { kind: 'literal', valueType: 'number', value: 2 } }, bindings({ price: 12 }))).toBe(24);
    expect(evaluator.evaluate({ kind: 'binary', valueType: 'boolean', operator: 'less',
      left: { kind: 'variable', valueType: 'number', name: 'price' },
      right: { kind: 'literal', valueType: 'number', value: 20 } }, bindings({ price: 12 }))).toBe(true);
  });

  it('short-circuits boolean operators', () => {
    const evaluator = new AutomationExpressionEvaluator();
    expect(evaluator.evaluate({ kind: 'binary', valueType: 'boolean', operator: 'and',
      left: { kind: 'literal', valueType: 'boolean', value: false },
      right: { kind: 'variable', valueType: 'boolean', name: 'missing' } }, bindings({}))).toBe(false);
  });

  it('rejects division by zero and oversized results', () => {
    const evaluator = new AutomationExpressionEvaluator({ maxStringLength: 3 });
    expect(() => evaluator.evaluate({ kind: 'binary', valueType: 'number', operator: 'divide', left: { kind: 'literal', valueType: 'number', value: 1 }, right: { kind: 'literal', valueType: 'number', value: 0 } }, bindings({}))).toThrow('division by zero');
    expect(() => evaluator.evaluate({ kind: 'binary', valueType: 'string', operator: 'concat', left: { kind: 'literal', valueType: 'string', value: 'ab' }, right: { kind: 'literal', valueType: 'string', value: 'cd' } }, bindings({}))).toThrow('string budget');
  });

  it('enforces expression operation budget', () => {
    const evaluator = new AutomationExpressionEvaluator({ maxOperations: 1 });
    expect(() => evaluator.evaluate({ kind: 'unary', valueType: 'number', operator: 'negate', operand: { kind: 'literal', valueType: 'number', value: 1 } }, bindings({}))).toThrow('operation budget');
  });
});
