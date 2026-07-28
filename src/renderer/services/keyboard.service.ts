import type { ShortcutAction } from '@shared/types/ipc';

export type ShortcutHandler = (action: ShortcutAction | 'zoom-in' | 'zoom-out' | 'zoom-reset') => void;

export function onShortcut(handler: ShortcutHandler): () => void {
  return window.electronAPI.on('shortcut', (...args: unknown[]) => {
    const action = args[0] as ShortcutAction | 'zoom-in' | 'zoom-out' | 'zoom-reset';
    handler(action);
  });
}
