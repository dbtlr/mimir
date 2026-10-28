/**
 * The adapter between Loom's installation record and Mimir's receipt (ADR 0031,
 * refinement MMR-554). Loom's managed `install.sh` and its self-update plugin
 * record a script installation in `install.json`, but that record holds no
 * install mode or directories, so Mimir keeps its own receipt beside the
 * binary and reads Loom's record only to learn that an installer placed the
 * bytes. This module reads that record; it writes nothing. Retire it once
 * Loom's record can carry an application's bindings (LM-s30).
 */
import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import type { InstallationPaths } from './index';

type Env = Readonly<Record<string, string | undefined>>;

/** A script installation as Loom's `install.json` states it: the binary's path and digest. */
export type ScriptInstallation = { path: string; sha256: string };

const APPLICATION = 'mimir';

function absoluteVariable(env: Env, name: string): string | undefined {
  const value = env[name];
  return value !== undefined && isAbsolute(value) ? value : undefined;
}

/**
 * The directory of Mimir's Loom installation record, by Loom's rule (its
 * `applicationDirectory('installation', …)`, Loom ADR-0071): the platform's
 * state directory, `$HOME/Library/Application Support` on macOS and
 * `$XDG_STATE_HOME`, else `$HOME/.local/state`, elsewhere. `undefined` when
 * the environment cannot name it. A cli test holds this to Loom's resolver.
 */
export function scriptRecordDirectory(env: Env, platform: string): string | undefined {
  const home = absoluteVariable(env, 'HOME');
  if (platform === 'darwin') {
    return home === undefined
      ? undefined
      : join(home, 'Library', 'Application Support', APPLICATION, 'installation');
  }
  const state = absoluteVariable(env, 'XDG_STATE_HOME');
  if (state !== undefined) {
    return join(state, APPLICATION, 'installation');
  }
  return home === undefined
    ? undefined
    : join(home, '.local', 'state', APPLICATION, 'installation');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The script installation Loom's record holds, or `undefined` when there is
 * none, it cannot be read, or another installer wrote it. Whether it names the
 * running executable, and its bytes, is the caller's check.
 */
export function readScriptInstallation(env: Env, platform: string): ScriptInstallation | undefined {
  const directory = scriptRecordDirectory(env, platform);
  if (directory === undefined) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(directory, 'install.json'), 'utf8'));
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.format !== 1 || value.method !== 'script') {
    return undefined;
  }
  const { digest, path } = value;
  if (typeof path !== 'string' || !isAbsolute(path) || typeof digest !== 'string') {
    return undefined;
  }
  const sha256 = /^sha256:(?<hex>[a-f0-9]{64})$/.exec(digest)?.groups?.hex;
  return sha256 === undefined ? undefined : { path, sha256 };
}

/**
 * A first run's adoption: the live directories it binds, or why it binds none
 * and how a later run can adopt.
 */
export type Adoption = { paths: InstallationPaths } | { refusal: string; remedy: string };

/** Each XDG root an adoption depends on, and its default under `$HOME`. */
const DEFAULT_ROOTS = [
  ['XDG_CACHE_HOME', ['.cache']],
  ['XDG_CONFIG_HOME', ['.config']],
  ['XDG_DATA_HOME', ['.local', 'share']],
  ['XDG_STATE_HOME', ['.local', 'state']],
] as const;

/** `A`, `A and B`, or `A, B, and C`. */
function series(names: readonly string[]): string {
  if (names.length <= 2) {
    return names.join(' and ');
  }
  return `${names.slice(0, -1).join(', ')}, and ${names.at(-1)}`;
}

/** An XDG root a run set to something other than its `$HOME` default. */
type RedirectedRoot = { variable: string; value: string; fallback: string };

/**
 * How a later run can adopt, given every root this one refused. A data root
 * (cache, config, or data) is unset for the `$HOME` defaults; an installation
 * whose directories are not the defaults needs a receipt an earlier installer
 * wrote, which no current installer writes. An absolute
 * `XDG_STATE_HOME` holds Loom's record itself, so a run with it unset finds no
 * record and adopts nothing: Loom's install.sh is re-run without it first, so
 * the record lands at the default.
 */
function adoptionRemedy(redirected: readonly RedirectedRoot[]): string {
  const names = redirected.map(({ variable }) => variable);
  const recordMoves = redirected.some(
    ({ variable, value }) => variable === 'XDG_STATE_HOME' && isAbsolute(value),
  );
  const reinstall = recordMoves
    ? "re-run Loom's install.sh with XDG_STATE_HOME unset so its record moves to the default, then "
    : '';
  const runIt = recordMoves ? 'run mimir' : 'run it';
  return `To adopt the $HOME defaults, ${reinstall}${runIt} once with ${series(names)} unset`;
}

/**
 * The live directories a first run adopts, failing closed: only the `$HOME`
 * defaults, the paths the old installer resolved with no XDG overrides. A run
 * that sets an XDG root to anything but its default, such as a test that
 * points one at a temp directory beside the real `$HOME`, adopts nothing,
 * because the receipt would bind the installation to that directory for good.
 * The refusal names every such root, so one refused run says all that must
 * change. The state root counts where Loom's record lives under it (not on
 * macOS). An empty variable is unset, as the XDG rules say.
 */
export function adoptionPaths(env: Env, platform: string): Adoption {
  const home = absoluteVariable(env, 'HOME');
  if (home === undefined) {
    return {
      refusal: 'HOME is not an absolute path',
      remedy: 'To adopt the $HOME defaults, run it once with HOME set to an absolute path',
    };
  }
  const redirected: RedirectedRoot[] = [];
  for (const [variable, defaultRoot] of DEFAULT_ROOTS) {
    if (variable === 'XDG_STATE_HOME' && platform === 'darwin') {
      continue;
    }
    const value = env[variable];
    const fallback = join(home, ...defaultRoot);
    if (
      value !== undefined &&
      value !== '' &&
      !(isAbsolute(value) && resolve(value) === fallback)
    ) {
      redirected.push({ fallback, value, variable });
    }
  }
  if (redirected.length > 0) {
    return {
      refusal: redirected
        .map(
          ({ fallback, value, variable }) => `${variable} is ${value}, not its default ${fallback}`,
        )
        .join('; '),
      remedy: adoptionRemedy(redirected),
    };
  }
  return {
    paths: {
      cache: join(home, '.cache', APPLICATION),
      config: join(home, '.config', APPLICATION),
      data: join(home, '.local', 'share', APPLICATION),
    },
  };
}
