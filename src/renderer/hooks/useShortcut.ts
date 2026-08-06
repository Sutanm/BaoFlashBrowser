import { useEffect, useRef } from 'react';
import { onShortcut, type ShortcutHandler } from '@renderer/services/keyboard.service';

export function useShortcut(handler: ShortcutHandler): void {
  const handlerRef = useRef(handler);
  useEffect(() => { handlerRef.current = handler; }, [handler]);
  useEffect(() => {
    const unsub = onShortcut((action) => handlerRef.current(action));
    return unsub;
  }, []);
}
