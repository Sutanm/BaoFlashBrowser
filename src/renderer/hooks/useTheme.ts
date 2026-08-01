import { useCallback, useEffect, useState } from 'react';
import { useDataStore } from '@renderer/store/useDataStore';

export function useTheme() {
  const themeMode = useDataStore((s) => s.themeMode);
  const setThemeMode = useDataStore((s) => s.setThemeMode);

  const [systemTheme, setSystemTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'light';
  });

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemTheme(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const theme = themeMode === 'system' ? systemTheme : themeMode;

  const toggle = useCallback(() => {
    const next = themeMode === 'light' ? 'dark' : themeMode === 'dark' ? 'system' : 'light';
    setThemeMode(next);
  }, [themeMode, setThemeMode]);

  useEffect(() => {
    document.body.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  return { theme, themeMode, toggle, setThemeMode };
}
