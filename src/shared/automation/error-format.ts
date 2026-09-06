/** Convert errors crossing Electron/contextBridge boundaries into useful text. */
export function automationErrorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (value && typeof value === 'object') {
    const candidate = value as { code?: unknown; message?: unknown };
    const message = typeof candidate.message === 'string' ? candidate.message.trim() : '';
    const code = typeof candidate.code === 'string' ? candidate.code.trim() : '';
    if (message) return code && !message.includes(code) ? `${code}: ${message}` : message;
    if (code) return code;
    try {
      const serialized = JSON.stringify(value);
      if (serialized && serialized !== '{}') return serialized;
    } catch { /* Fall through to String for cyclic foreign values. */ }
  }
  return String(value);
}

export function automationError(value: unknown): Error {
  return value instanceof Error ? value : new Error(automationErrorMessage(value));
}
