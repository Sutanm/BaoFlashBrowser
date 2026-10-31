import { nativeTheme } from 'electron';
import { z } from 'zod';
import { createValidatedHandler } from '../utils/ipc-wrapper';

export function registerThemeIPC(): void {
  createValidatedHandler('theme:set-source', z.enum(['system', 'light', 'dark']), (source) => {
    // Chromium propagates this preference to existing and future BrowserViews,
    // including CSS media queries and matchMedia change listeners.
    nativeTheme.themeSource = source;
  });
}
