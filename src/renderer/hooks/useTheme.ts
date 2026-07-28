import { atom, useAtom } from 'jotai';
import { useCallback } from 'react';

const themeAtom = atom<'light' | 'dark'>(
  (localStorage.getItem('baoflash_theme') as 'light' | 'dark') || 'light',
);

export function useTheme() {
  const [theme, setTheme] = useAtom(themeAtom);

  const toggle = useCallback(() => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    localStorage.setItem('baoflash_theme', next);
    document.documentElement.classList.toggle('dark', next === 'dark');
  }, [theme, setTheme]);

  return { theme, toggle };
}
