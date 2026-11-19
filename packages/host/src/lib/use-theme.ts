import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { apply, clearTheme, resolve, setTheme, subscribeTheme, themeChoice } from './theme';
import type { Theme, ThemeChoice } from './theme';

/**
 * The live theme, the stored choice, and the ways to change them. Seeded from
 * {@link resolve} (which the inline `index.html` script already applied, so
 * this matches the painted state). While no pick is stored the theme follows
 * OS changes; a pick is recorded by {@link setTheme}, and `system` clears it.
 *
 * Every caller reads the one store in `theme.ts`, so the shell's Toaster, the
 * "…" menu's switch, and the Appearance page stay in step.
 */
export function useTheme(): {
  theme: Theme;
  choice: ThemeChoice;
  toggle: () => void;
  choose: (choice: ThemeChoice) => void;
} {
  const theme = useSyncExternalStore(subscribeTheme, resolve, resolve);
  const choice = useSyncExternalStore(subscribeTheme, themeChoice, themeChoice);

  // Keep the document (incl. <meta name=theme-color>) in sync. The inline
  // index.html script set data-theme pre-paint but not the meta color, so the
  // first mount reconciles it; later changes flow through here too.
  useEffect(() => {
    apply(theme);
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme(resolve() === 'dark' ? 'light' : 'dark');
  }, []);

  const choose = useCallback((next: ThemeChoice) => {
    if (next === 'system') {
      clearTheme();
    } else {
      setTheme(next);
    }
  }, []);

  return { choice, choose, theme, toggle };
}
