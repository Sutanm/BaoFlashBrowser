export type ToastType = 'success' | 'info' | 'warning' | 'error';
export type ToastPriority = 'normal' | 'high';
export type ToastDismissReason = 'timeout' | 'click' | 'close-button' | 'action' | 'replaced';

export interface ToastAction {
  label: string;
  onClick: () => void | Promise<void>;
  primary?: boolean;
}

export interface ToastInput {
  key?: string;
  message: string;
  type: ToastType;
  color?: string;
  duration?: number | null;
  priority?: ToastPriority;
  actions?: ToastAction[];
  onDismiss?: (reason: ToastDismissReason) => void;
}

export interface AddressToast extends ToastInput {
  id: number;
}

export const MAX_TOASTS = 20;

const DEFAULT_DURATION: Record<ToastType, number> = {
  success: 2500,
  info: 2500,
  warning: 3200,
  error: 4500,
};

export function toastDuration(toast: ToastInput): number | null {
  if (toast.duration === null) return null;
  if (typeof toast.duration === 'number') return Math.max(0, toast.duration);
  if (toast.actions?.length) return null;
  return DEFAULT_DURATION[toast.type];
}

export interface EnqueueToastResult {
  queue: AddressToast[];
  dismissed: Array<{ toast: AddressToast; reason: 'replaced' }>;
}

export function enqueueToast(queue: AddressToast[], toast: AddressToast): EnqueueToastResult {
  const dismissed: EnqueueToastResult['dismissed'] = [];
  const next = [...queue];

  if (toast.key) {
    const existingIndex = next.findIndex((item) => item.key === toast.key);
    if (existingIndex >= 0) {
      dismissed.push({ toast: next[existingIndex], reason: 'replaced' });
      next.splice(existingIndex, 1);
    }
  }

  const priority = toast.priority || (toast.type === 'error' ? 'high' : 'normal');
  const normalized = { ...toast, priority };
  if (priority === 'high') {
    const waitingStart = next.length > 0 ? 1 : 0;
    const relativeIndex = next.slice(waitingStart).findIndex((item) =>
      (item.priority || (item.type === 'error' ? 'high' : 'normal')) !== 'high');
    const insertionIndex = relativeIndex < 0 ? next.length : waitingStart + relativeIndex;
    next.splice(insertionIndex, 0, normalized);
  } else {
    next.push(normalized);
  }

  while (next.length > MAX_TOASTS) {
    let dropIndex = next.length - 1;
    for (let index = next.length - 1; index >= 0; index--) {
      if ((next[index].priority || 'normal') === 'normal') {
        dropIndex = index;
        break;
      }
    }
    const [dropped] = next.splice(dropIndex, 1);
    dismissed.push({ toast: dropped, reason: 'replaced' });
  }

  return { queue: next, dismissed };
}
