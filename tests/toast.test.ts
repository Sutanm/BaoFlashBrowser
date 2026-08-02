import { describe, expect, it, vi } from 'vitest';
import { enqueueToast, MAX_TOASTS, toastDuration, type AddressToast } from '../src/renderer/services/toast';

function toast(id: number, overrides: Partial<AddressToast> = {}): AddressToast {
  return { id, message: `toast-${id}`, type: 'info', ...overrides };
}

describe('toast queue policy', () => {
  it('distinguishes default, explicit and persistent durations', () => {
    expect(toastDuration(toast(1))).toBe(2500);
    expect(toastDuration(toast(2, { type: 'warning' }))).toBe(3200);
    expect(toastDuration(toast(3, { type: 'error' }))).toBe(4500);
    expect(toastDuration(toast(4, { duration: 1234 }))).toBe(1234);
    expect(toastDuration(toast(5, { duration: null }))).toBeNull();
    expect(toastDuration(toast(6, { actions: [{ label: 'Act', onClick: () => {} }] }))).toBeNull();
  });

  it('replaces duplicate keys and keeps the currently visible toast first', () => {
    const current = toast(1, { key: 'current' });
    const normal = toast(2, { key: 'same' });
    const replacement = toast(3, { key: 'same', type: 'error' });
    const result = enqueueToast([current, normal], replacement);
    expect(result.queue.map((item) => item.id)).toEqual([1, 3]);
    expect(result.dismissed).toEqual([{ toast: normal, reason: 'replaced' }]);
  });

  it('limits backlog and prioritizes errors without interrupting the current toast', () => {
    let queue = [toast(1)];
    for (let id = 2; id <= MAX_TOASTS + 5; id++) queue = enqueueToast(queue, toast(id)).queue;
    expect(queue).toHaveLength(MAX_TOASTS);
    const result = enqueueToast(queue, toast(99, { type: 'error' }));
    expect(result.queue[0].id).toBe(queue[0].id);
    expect(result.queue[1].id).toBe(99);
    expect(result.queue).toHaveLength(MAX_TOASTS);
  });
});
