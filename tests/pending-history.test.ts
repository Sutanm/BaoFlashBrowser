import { describe, expect, it } from 'vitest';
import { PendingHistoryRegistry } from '../src/renderer/services/pending-history';

describe('pending history registry', () => {
  it('keeps simultaneous navigations isolated by tab', () => {
    const registry = new PendingHistoryRegistry();
    registry.set({ tabId: 'a', url: 'https://a.example/one' });
    registry.set({ tabId: 'b', url: 'https://b.example/two' });
    registry.updateTitle('a', 'A title');

    expect(registry.take('b')).toEqual({ tabId: 'b', url: 'https://b.example/two' });
    expect(registry.take('a')).toEqual({ tabId: 'a', url: 'https://a.example/one', title: 'A title' });
  });

  it('deletes only the closed tab candidate', () => {
    const registry = new PendingHistoryRegistry();
    registry.set({ tabId: 'a', url: 'https://a.example/' });
    registry.set({ tabId: 'b', url: 'https://b.example/' });
    registry.delete('a');

    expect(registry.take('a')).toBeNull();
    expect(registry.take('b')?.url).toBe('https://b.example/');
  });
});
