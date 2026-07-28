import { useEffect } from 'react';
import { onShortcut, type ShortcutHandler } from '@renderer/services/keyboard.service';

export function useShortcut(handler: ShortcutHandler): void {
  useEffect(() => {
    const unsub = onShortcut(handler);
    return unsub;
  }, [handler]);
}
