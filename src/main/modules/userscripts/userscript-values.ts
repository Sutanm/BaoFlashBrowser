// GM value serialization rules. Values are JSON round-tripped; anything that
// cannot survive JSON is rejected at the store boundary.
// Mirrors the planned src/main/modules/userscripts/userscript-values.ts.

import type { GMSerializable } from '../../../shared/userscript-types';

export function isSerializableValue(value: unknown): value is GMSerializable {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'object') {
    if (value instanceof Date) return false;
    // Path stack detects cycles while allowing shared (non-circular)
    // references, matching JSON.stringify semantics. A WeakSet cannot be used
    // for a path because it has no delete.
    const path = new Set<object>();
    const walk = (current: object): boolean => {
      if (path.has(current)) return false;
      path.add(current);
      let ok = true;
      const items: unknown[] = Array.isArray(current)
        ? current
        : Object.keys(current).map((key) => (current as Record<string, unknown>)[key]);
      for (const item of items) {
        if (typeof item === 'object' && item !== null) {
          if (!walk(item)) {
            ok = false;
            break;
          }
        } else if (!isSerializableValue(item)) {
          ok = false;
          break;
        }
      }
      path.delete(current);
      return ok;
    };
    return walk(value);
  }
  return false;
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
