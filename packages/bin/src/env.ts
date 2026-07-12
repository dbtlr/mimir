/**
 * Environment defaults — the Norn-vault path and `serve` port, resolved against a
 * build profile so running from source never touches production state (MMR-117).
 *
 * The defaults are *dev by default*: from-source (`bun run mimir …`) and tests
 * resolve to an isolated, gitignored repo-local vault and an off-production
 * port. A release build overlays the production target by injecting
 * `MIMIR_BUILD_PROFILE="production"` via `bun build --define` — the same
 * build-time-constant idiom as `MIMIR_BUILD_VERSION` (MMR-57, see version.ts).
 * The polarity is deliberate: a build missing the define lands in dev (harmless),
 * so only a real compiled binary ever points at production work-state.
 *
 * User overrides still sit on top of the baked default: `MIMIR_VAULT` / `MIMIR_PORT`
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
 * Resolve a path under the build's data root. Production resolves the single
 * user-global XDG root (`$XDG_DATA_HOME/mimir`, defaulting to
 * `~/.local/share/mimir`), so an installed `mimir` works from any directory.
 * Dev/from-source resolves an isolated repo-local `.dev` (relative to this
 * source file, not cwd, so it holds from any subdirectory).
 */
function dataPath(...leaf: string[]): string {
  if (!IS_PRODUCTION) {
    const srcDir = dirname(fileURLToPath(import.meta.url)); // packages/bin/src
    return join(srcDir, '..', '..', '..', '.dev', ...leaf);
  }
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
  return join(dataHome, 'mimir', ...leaf);
}

/**
 * The default Norn-vault path for this build (MMR-142): production resolves
 * `$XDG_DATA_HOME/mimir/vault`; dev/from-source resolves the isolated repo-local
 * `.dev/vault`. `MIMIR_VAULT` / the `[vault] path` config override it upstream
 * (see `resolveVault`).
 */
export function defaultVaultPath(): string {
  return dataPath('vault');
}

/**
 * A boolean env flag, value-based like a proper switch: only an explicit
 * affirmative (`1`/`true`/`yes`/`on`, case-insensitive) enables it. `0`,
 * `false`, `no`, `off`, empty, unset, or noise stay disabled — so exporting
 * the var with a falsy value can never read as an accidental opt-in. Used for
 * `MIMIR_ALLOW_REAL_SERVICE`, the MMR-147 real-supervisor escape hatch.
 */
export function envFlag(raw: string | undefined): boolean {
  if (raw === undefined) {
    return false;
  }
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * The `MIMIR_PORT` override for the port seam. Tolerant
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
