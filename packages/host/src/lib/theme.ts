/**
 * Theme resolution + persistence (MMR-74). The palette lives in `styles.css`
 * as a `[data-theme="light"]` token override; this module only decides which
 * theme is active and records an explicit pick.
 *
 * Default is the OS preference; an explicit pick is remembered and wins over
 * the OS (and silences OS-change following). The inline script in `index.html`
 * mirrors `resolve()` + `apply()` so the first paint is already themed (no
 * flash); this module owns runtime toggling and system-change following.
 */
import { WELL_900 } from './theme-colors';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'mimir-theme';
const LIGHT_QUERY = '(prefers-color-scheme: light)';

/** The page background per theme, reflected onto `<meta name=theme-color>`. */
const THEME_COLOR: Record<Theme, string> = WELL_900;

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

/** The active theme: an explicit pick wins, otherwise follow the OS. */
export function resolve(): Theme {
  return storedChoice() ?? systemTheme();
}

/** Reflect a theme onto the document (the `<html data-theme>` the CSS keys on). */
export function apply(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
}

/** Record an explicit pick (so it outlives reloads) and apply it. */
export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // private mode / storage disabled — the pick just won't persist
  }
  apply(theme);
}
