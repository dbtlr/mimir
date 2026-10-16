/**
 * The version this UI bundle was built with — a vite `define` constant baked
 * in at `vite build` (see vite.config.ts), the bundle-side twin of the
 * binary's `MIMIR_BUILD_VERSION` (packages/bin/src/version.ts, MMR-57).
 * Compared against `/api/health`'s reported version, a mismatch means the
 * loaded bundle predates (or postdates) the running daemon — the stale-UI
 * signal a days-old binary can't otherwise surface (MMR-260).
 */
declare const MIMIR_BUILD_VERSION: string;

export const BUILD_VERSION = MIMIR_BUILD_VERSION;
