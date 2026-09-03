import { beforeEach, describe, expect, it, vi } from 'vitest';

const storeState = vi.hoisted(() => ({ stores: new Map<string, Map<string, unknown>>() }));

vi.mock('electron-store', () => ({
  default: class MockStore {
    private readonly data: Map<string, unknown>;

    constructor(options: { name?: string; defaults?: Record<string, unknown> }) {
      const name = options.name ?? 'config';
      let data = storeState.stores.get(name);
      if (!data) {
        data = new Map(Object.entries(options.defaults ?? {}));
        storeState.stores.set(name, data);
      }
      this.data = data;
    }

    get(key: string): unknown { return this.data.get(key); }
    set(key: string, value: unknown): void { this.data.set(key, value); }
    clear(): void { this.data.clear(); }
  },
}));

import { deleteEntry } from '../src/main/modules/password-store';

describe('password-store deleteEntry', () => {
  beforeEach(() => {
    storeState.stores.get('password-store')?.set('entries', [
      { id: 'keep', username: 'one' },
      { id: 'remove', username: 'two' },
    ]);
  });

  it('returns true and persists the filtered list when the entry exists', () => {
    expect(deleteEntry('remove')).toBe(true);
    expect(storeState.stores.get('password-store')?.get('entries')).toEqual([
      { id: 'keep', username: 'one' },
    ]);
  });

  it('returns false without rewriting the list when the entry does not exist', () => {
    const entries = storeState.stores.get('password-store')?.get('entries');
    expect(deleteEntry('missing')).toBe(false);
    expect(storeState.stores.get('password-store')?.get('entries')).toBe(entries);
  });
});
