/**
 * Theme resolution + persistence (MMR-74). The palette lives in `styles.css`
 * as a `[data-theme="light"]` token override; this module only decides which
 * theme is active and records an explicit pick.
 *
 * Default is the OS preference; an explicit pick is remembered and wins over
 * the OS (and silences OS-change following). The inline script in `document.tsx`
 * mirrors `resolve()` + `apply()` so the first paint is already themed (no
 * flash); this module owns runtime toggling and system-change following.
 */
import { WELL_950 } from './theme-colors';

export type Theme = 'light' | 'dark';

/** What Appearance offers: a pinned theme, or `system` (no stored pick, follow the OS). */
export type ThemeChoice = Theme | 'system';

const STORAGE_KEY = 'mimir-theme';
const LIGHT_QUERY = '(prefers-color-scheme: light)';

/** The top bar's ground per theme, reflected onto `<meta name=theme-color>`. */
const THEME_COLOR: Record<Theme, string> = WELL_950;

export function systemTheme(): Theme {
  return globalThis.matchMedia(LIGHT_QUERY).matches ? 'light' : 'dark';
}

/** The remembered explicit pick, or null when the user has never chosen. */
export function storedChoice(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

/** The stored choice as Appearance reads it: the pick, or `system` when none is stored. */
export function themeChoice(): ThemeChoice {
  return storedChoice() ?? 'system';
}

/** The active theme: an explicit pick wins, otherwise follow the OS. */
export function resolve(): Theme {
  return storedChoice() ?? systemTheme();
}

/** Reflect a theme onto the document (the `<html data-theme>` the CSS keys on). */
export function apply(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
}

const listeners = new Set<() => void>();

/**
 * Subscribe to theme changes: a pick, a return to the system theme, or an OS
 * change while no pick is stored. Every `useTheme` reader shares this one
 * source, so the Appearance page and the shell's Toaster never diverge.
 */
export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  const media = globalThis.matchMedia(LIGHT_QUERY);
  const onSystemChange = () => {
    if (storedChoice() === null) {
      apply(systemTheme());
      listener();
    }
  };
  media.addEventListener('change', onSystemChange);
  return () => {
    listeners.delete(listener);
    media.removeEventListener('change', onSystemChange);
  };
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** Record an explicit pick (so it outlives reloads) and apply it. */
export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // private mode / storage disabled — the pick just won't persist
  }
  apply(theme);
  notify();
}

/** Forget the pick: the console follows the OS again, from now on and across reloads. */
export function clearTheme(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage disabled — nothing was stored to forget
  }
  apply(systemTheme());
  notify();
}
