/**
 * The page-ground hex per theme (`--color-well-900` in `styles.css`) — the
 * single source. Every importable consumer (theme resolution, the PWA
 * manifest, the document meta tag) reads this; `styles.css` and the icon
 * SVGs can't import JS, so `theme-colors.test.ts` asserts they still agree.
 */
export const WELL_900 = { dark: '#0d1219', light: '#e9eff3' } as const;

/**
 * The top-bar ground per theme (`--color-well-950` in `styles.css`). The browser
 * chrome (`<meta name=theme-color>`, the manifest's `theme_color`) takes it, so
 * the status bar and the top bar read as one solid band (MMR-715).
 */
export const WELL_950 = { dark: '#0b0f14', light: '#f6f9fb' } as const;
