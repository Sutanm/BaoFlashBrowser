// GM value serialization rules. Values are JSON round-tripped; anything that
// cannot survive JSON is rejected at the store boundary.
// Mirrors the planned src/main/modules/userscripts/userscript-values.ts.

import type { GMSerializable } from './userscript-types';

export const MAX_SERIALIZABLE_DEPTH = 64;
export const MAX_SERIALIZABLE_NODES = 10_000;

export function isSerializableValue(value: unknown): value is GMSerializable {
  const path = new Set<object>();
  let visitedNodes = 0;

  const walk = (current: unknown, depth: number): boolean => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return true;
    if (typeof current === 'number') return Number.isFinite(current);
    if (typeof current !== 'object' || current instanceof Date) return false;
    if (depth > MAX_SERIALIZABLE_DEPTH || ++visitedNodes > MAX_SERIALIZABLE_NODES) return false;
    if (path.has(current)) return false;

    path.add(current);
    const items: unknown[] = Array.isArray(current)
      ? current
      : Object.keys(current).map((key) => (current as Record<string, unknown>)[key]);
    const ok = items.every((item) => walk(item, depth + 1));
    path.delete(current);
    return ok;
  };

  return walk(value, 0);
}

export function serializeValue(value: GMSerializable): string {
  return JSON.stringify(value);
}

export function deserializeValue(serialized: string): GMSerializable | undefined {
  try {
    return JSON.parse(serialized) as GMSerializable;
  } catch {
    return undefined;
  }
}
