/**
 * The page-ground hex per theme (`--color-well-900` in `styles.css`) — the
 * single source. Every importable consumer (theme resolution, the PWA
 * manifest, the document meta tag) reads this; `styles.css` and the icon
 * SVGs can't import JS, so `theme-colors.test.ts` asserts they still agree.
 */
export const WELL_900 = { dark: '#0d1219', light: '#e9eff3' } as const;
