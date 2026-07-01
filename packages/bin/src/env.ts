/**
 * Environment defaults — the store path and `serve` port, resolved against a
 * build profile so running from source never touches production state (MMR-117).
 *
 * The defaults are *dev by default*: from-source (`bun run mimir …`) and tests
 * resolve to an isolated, gitignored repo-local store and an off-production
 * port. A release build overlays the production target by injecting
 * `MIMIR_BUILD_PROFILE="production"` via `bun build --define` — the same
 * build-time-constant idiom as `MIMIR_BUILD_VERSION` (MMR-57, see version.ts).
 * The polarity is deliberate: a build missing the define lands in dev (harmless),
 * so only a real compiled binary ever points at production work-state.
 *
 * User overrides still sit on top of the baked default: `MIMIR_DB` / `MIMIR_PORT`
 * env vars win, then the global config, then this default.
 */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Replaced by a string literal at compile time in release builds; left
// undeclared (undefined) from source. `typeof` on the possibly-undeclared
// identifier is the one safe read.
declare const MIMIR_BUILD_PROFILE: string | undefined;

/** True only in a compiled release build (the `--define` was injected). */
export const IS_PRODUCTION = typeof MIMIR_BUILD_PROFILE !== 'undefined';

/** Production `serve` port — MIMIR on a phone keypad. */
export const PROD_PORT = 64647;
/** Dev/from-source `serve` port — off the production port so a from-source
 * `serve` never collides with the installed daemon (MMR-117). */
export const DEV_PORT = 64747;

/** The default `serve` port for this build: production unless from-source. */
export const DEFAULT_PORT = IS_PRODUCTION ? PROD_PORT : DEV_PORT;

/**
 * The default store path for this build. Production resolves the single
 * user-global XDG store (`$XDG_DATA_HOME/mimir/mimir.db`, defaulting to
 * `~/.local/share/mimir/mimir.db`), so an installed `mimir` works from any
 * directory. Dev/from-source resolves an isolated repo-local `.dev/mimir.db`
 * (relative to this source file, not cwd, so it holds from any subdirectory).
 */
export function defaultStorePath(): string {
  if (!IS_PRODUCTION) {
    const srcDir = dirname(fileURLToPath(import.meta.url)); // packages/bin/src
    return join(srcDir, '..', '..', '..', '.dev', 'mimir.db');
  }
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(dataHome, 'mimir', 'mimir.db');
}

/**
 * The resolved store path. `MIMIR_DB` is the explicit full override (the one
 * env seam that reaches a store outside the baked default); otherwise the
 * build's default. In dev that default is repo-local, so only an explicit
 * `MIMIR_DB` can point a from-source run at production work-state.
 */
export function storePath(): string {
  return process.env.MIMIR_DB ?? defaultStorePath();
}

/**
 * The `MIMIR_PORT` override, mirroring `MIMIR_DB` for the port seam. Tolerant
 * like the config reader: an unset var yields `undefined` (use the next source),
 * a malformed one yields `null` so the caller can warn and fall through rather
 * than bind a bogus port.
 *
 * - unset → `undefined`
 * - a valid integer in 1–65535 → that number
 * - anything else → `null`
 */
export function envPort(raw = process.env.MIMIR_PORT): number | null | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const port = Number(raw);
  if (Number.isInteger(port) && port >= 1 && port <= 65535) {
    return port;
  }
  return null;
}
