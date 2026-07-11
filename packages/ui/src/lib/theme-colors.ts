/**
 * The page-ground hex per theme (`--color-well-900` in `styles.css`) — the
 * single source. Every importable consumer (theme resolution, the PWA
 * manifest, the `index.html` meta tag) reads this; `styles.css` and the icon
 * SVGs can't import JS, so `theme-colors.test.ts` asserts they still agree.
 */
export const WELL_900 = { dark: '#0d1219', light: '#e9eff3' } as const;

const META_PLACEHOLDER = '__WELL_900_DARK__';

/** Fills the `index.html` meta theme-color placeholder — vite.config's `transformIndexHtml`. */
export function injectThemeColorMeta(html: string): string {
  return html.replaceAll(META_PLACEHOLDER, WELL_900.dark);
}
