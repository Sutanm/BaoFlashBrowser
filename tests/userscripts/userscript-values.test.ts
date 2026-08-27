import { describe, expect, it } from 'vitest';
import {
  MAX_SERIALIZABLE_DEPTH,
  MAX_SERIALIZABLE_NODES,
  isSerializableValue,
  serializeValue,
  deserializeValue,
} from '@main/modules/userscripts/userscript-values';

describe('userscript-values serialization', () => {
  it('accepts JSON-serializable primitives and structures', () => {
    expect(isSerializableValue('text')).toBe(true);
    expect(isSerializableValue(42)).toBe(true);
    expect(isSerializableValue(true)).toBe(true);
    expect(isSerializableValue(null)).toBe(true);
    expect(isSerializableValue([1, 'a', { b: 2 }])).toBe(true);
    expect(isSerializableValue({ a: 1, b: [true, 'x'] })).toBe(true);
  });

  it('rejects functions, undefined, Date and symbols', () => {
    expect(isSerializableValue(() => 1)).toBe(false);
    expect(isSerializableValue(undefined)).toBe(false);
    expect(isSerializableValue(new Date())).toBe(false);
    expect(isSerializableValue({ nested: () => 1 })).toBe(false);
    expect(isSerializableValue(Symbol('x'))).toBe(false);
  });

  it('rejects NaN and Infinity', () => {
    expect(isSerializableValue(NaN)).toBe(false);
    expect(isSerializableValue(Infinity)).toBe(false);
  });

  it('round-trips values through serialization', () => {
    const original = { count: 3, label: 'demo', flags: [true, false, null] };
    expect(deserializeValue(serializeValue(original))).toEqual(original);
  });

  it('rejects circular structures instead of throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(isSerializableValue(circular)).toBe(false);
  });

  it('rejects circular arrays without infinite recursion', () => {
    const circular: unknown[] = ['x'];
    circular.push(circular);
    expect(isSerializableValue(circular)).toBe(false);
    const circularObject: Array<unknown> = [{}];
    (circularObject[0] as Record<string, unknown>).back = circularObject;
    expect(isSerializableValue(circularObject)).toBe(false);
  });

  it('allows shared non-circular references', () => {
    const shared = { a: 1 };
    expect(isSerializableValue([shared, shared])).toBe(true);
    expect(isSerializableValue({ first: shared, second: shared })).toBe(true);
  });

  it('rejects deep circular references through array indexes', () => {
    const matrix: unknown[] = [[1]];
    const inner = matrix[0] as unknown[];
    inner.push(inner);
    expect(isSerializableValue(matrix)).toBe(false);
  });

  it('rejects structures that exceed the nesting-depth budget', () => {
    const root: Record<string, unknown> = {};
    let cursor = root;
    for (let depth = 0; depth <= MAX_SERIALIZABLE_DEPTH; depth++) {
      const child: Record<string, unknown> = {};
      cursor.child = child;
      cursor = child;
    }
    expect(isSerializableValue(root)).toBe(false);
  });

  it('rejects structures that exceed the visited-node budget', () => {
    const value = Array.from({ length: MAX_SERIALIZABLE_NODES + 1 }, () => ({}));
    expect(isSerializableValue(value)).toBe(false);
  });
});
