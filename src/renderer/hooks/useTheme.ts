import { useAtom } from 'jotai';
import { useCallback, useEffect } from 'react';
import { themeAtom } from '@renderer/atoms/data.atom';
import { saveMeta } from '@renderer/services/db';

export function useTheme() {
  const [theme, setTheme] = useAtom(themeAtom);

  const toggle = useCallback(() => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
  }, [theme, setTheme]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    saveMeta('theme', theme);
  }, [theme]);

  return { theme, toggle };
}
