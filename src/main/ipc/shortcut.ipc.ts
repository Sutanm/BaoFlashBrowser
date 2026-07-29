import type { BrowserWindow, WebContents } from 'electron';
import type { ShortcutAction } from '@shared/types/ipc';

type ShortcutEntry = {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  action: ShortcutAction | 'zoom-in' | 'zoom-out' | 'zoom-reset';
};

const SHORTCUTS: ShortcutEntry[] = [
  // Tab management
  { key: 't', ctrl: true, action: 'new-tab' },
  { key: 'w', ctrl: true, action: 'close-tab' },
  { key: 'Tab', ctrl: true, action: 'next-tab' },
  { key: 'Tab', ctrl: true, shift: true, action: 'prev-tab' },
  { key: '1', ctrl: true, action: 'switch-tab-1' },
  { key: '2', ctrl: true, action: 'switch-tab-2' },
  { key: '3', ctrl: true, action: 'switch-tab-3' },
  { key: '4', ctrl: true, action: 'switch-tab-4' },
  { key: '5', ctrl: true, action: 'switch-tab-5' },
  { key: '6', ctrl: true, action: 'switch-tab-6' },
  { key: '7', ctrl: true, action: 'switch-tab-7' },
  { key: '8', ctrl: true, action: 'switch-tab-8' },
  // Navigation
  { key: 'F5', action: 'reload' },
  { key: 'r', ctrl: true, action: 'reload' },
  { key: 'Escape', action: 'stop-or-dismiss' },
  { key: 'l', ctrl: true, action: 'focus-address' },
  { key: 'd', alt: true, action: 'focus-address' },
  // Features
  { key: 'F11', action: 'fullscreen' },
  { key: 'F12', action: 'devtools' },
  { key: 'i', ctrl: true, shift: true, action: 'devtools' },
  { key: 'd', ctrl: true, action: 'bookmark' },
  { key: 'h', ctrl: true, action: 'history-panel' },
  { key: 'f', ctrl: true, action: 'find-in-page' },
  { key: 's', ctrl: true, action: 'save-page' },
  { key: 'p', ctrl: true, action: 'print-page' },
  { key: 'u', ctrl: true, action: 'view-source' },
  { key: 'n', ctrl: true, action: 'new-window' },
  { key: 'Delete', ctrl: true, shift: true, action: 'clear-data' },
  // Zoom
  { key: '=', ctrl: true, action: 'zoom-in' },
  { key: '+', ctrl: true, action: 'zoom-in' },
  { key: '-', ctrl: true, action: 'zoom-out' },
  { key: '0', ctrl: true, action: 'zoom-reset' },
];

let mainWindow: BrowserWindow | null = null;

export function setMainWindowRef(win: BrowserWindow): void {
  mainWindow = win;
}

function matchShortcut(input: Electron.Input): ShortcutEntry | null {
  for (const sc of SHORTCUTS) {
    if (input.key !== sc.key) continue;
    if (!!sc.ctrl !== input.control) continue;
    if (!!sc.shift !== input.shift) continue;
    if (!!sc.alt !== input.alt) continue;
    return sc;
  }
  return null;
}

export function handleWebviewBeforeInputEvent(
  event: Electron.Event,
  input: Electron.Input,
): void {
  // Handle keyboard shortcuts
  if (input.type === 'keyDown') {
    const matched = matchShortcut(input);
    if (matched) {
      event.preventDefault();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('shortcut', matched.action);
      }
      return;
    }
  }

  // Handle Ctrl+MouseWheel for zoom (fallback for Flash/iframe areas)
  if (input.type === 'mouseWheel' && (input.control || input.meta)) {
    event.preventDefault();
    const action = input.deltaY < 0 ? 'zoom-in' : 'zoom-out';
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('shortcut', action);
    }
  }
}

export function registerShortcutHandler(wc: WebContents): void {
  wc.on('before-input-event', handleWebviewBeforeInputEvent);
}
