/**
 * Vault bootstrap as one idempotent convergence (MMR-142). Create and adopt
 * are not modes — converge(dir) lands in one of three outcomes:
 *
 * - **created** — absent or effectively-empty dir (when `allowCreate`):
 *   scaffold marker + generated rules, `git init`, initial commit.
 * - **converged** — a recognized Mimir vault: regenerate drifted rules, bump
 *   an older marker, re-init a missing `.git`; no-op when current (the hot
 *   path — every vault open runs this).
 * - **refused** — a non-empty directory without the marker (never adopt a
 *   foreign vault; ADR 0016's own-repo boundary, enforced structurally), or
 *   a marker schema newer than this binary (the downgrade guard).
 *
 * Git is the history layer, not a correctness dependency: a failed git
 * operation degrades to a warning on the outcome, never an error. Upgrade
 * commits stage only converge-owned files so operator changes are never
 * swept into a mimir commit; the exception is baseline-committing a fresh
 * `git init` (there is no history to protect yet).
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { conflict, notFound } from '../core/errors';
import type { Exec } from '../exec';
import { gitAt } from './git';
import type { Git } from './git';
import {
  MARKER_FILE,
  NORN_CONFIG_FILE,
  VAULT_SCHEMA,
  parseMarker,
  renderMarker,
  renderNornConfig,
} from './schema';

export type ConvergeResult =
  | { outcome: 'created'; warnings: string[] }
  | { outcome: 'converged'; upgraded: boolean; warnings: string[] };

/** Entries that don't count against "empty" (Finder droppings). */
const IGNORABLE = new Set(['.DS_Store']);

function isEffectivelyEmpty(path: string): boolean {
  return readdirSync(path).every((entry) => IGNORABLE.has(entry));
}

/**
 * What sits at the vault path, without letting raw fs errors escape:
 * `dir` and `absent` are the workable cases; a regular file is a refusal,
 * and a dangling symlink almost always means an unmounted volume — surface
 * the mount hint instead of a raw ENOENT from `mkdir` through the link.
 */
function classifyPath(path: string): 'absent' | 'dir' | 'file' | 'dangling-symlink' {
  try {
    return statSync(path).isDirectory() ? 'dir' : 'file'; // follows symlinks
  } catch {
    try {
      lstatSync(path); // an entry exists but its target doesn't
      return 'dangling-symlink';
    } catch {
      return 'absent';
    }
  }
}

/**
 * Stage `files` and commit iff anything is actually staged. Regeneration can
 * be a round-trip back to committed content (converging drift that was never
 * committed) — staging then yields nothing, which is a no-op, not a failure.
 */
async function commitStaged(git: Git, files: string[], message: string): Promise<void> {
  if (!(await git.run(['add', ...files], 'staging the converge changes failed'))) {
    return;
  }
  const staged = await git.probe(['diff', '--cached', '--quiet']);
  if (staged !== 0) {
    await git.run(['commit', '-m', message], 'the converge commit failed');
  }
}

async function create(path: string, exec: Exec): Promise<ConvergeResult> {
  // Marker first: a crash mid-scaffold then leaves a *recognized* vault the
  // next converge heals, never a non-empty unmarked directory it refuses.
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, MARKER_FILE), renderMarker());
  mkdirSync(join(path, dirname(NORN_CONFIG_FILE)), { recursive: true });
  writeFileSync(join(path, NORN_CONFIG_FILE), renderNornConfig());
  const git = gitAt(path, exec);
  if (await git.run(['init'], 'init failed — the vault works, but has no history')) {
    await commitStaged(
      git,
      [MARKER_FILE, NORN_CONFIG_FILE],
      `mimir: initialize vault (schema ${String(VAULT_SCHEMA)})`,
    );
  }
  return { outcome: 'created', warnings: git.warnings };
}

export async function converge(
  path: string,
  opts: {
    allowCreate: boolean;
    exec: Exec;
    /**
     * Data migrations for a schema-version upgrade: rewrite existing documents
     * forward (the content counterpart to the structural marker/rules bump),
     * returning the changed paths to stage. Run once, BEFORE the marker bumps,
     * so a crash leaves the old schema and the next converge retries. Omitted by
     * fs/git-only callers (tests); production callers pass {@link ./backfill}'s
     * `backfillVaultData`.
     */
    migrateData?: (path: string, fromSchema: number) => Promise<string[]>;
  },
): Promise<ConvergeResult> {
  const kind = classifyPath(path);
  if (kind === 'file') {
    throw conflict(
      `${path} is a file, not a directory — refusing to use it as a vault`,
      'point MIMIR_VAULT / [vault] path at a directory',
    );
  }
  if (kind === 'dangling-symlink') {
    throw notFound(
      `the vault path ${path} is a symlink to a missing target`,
      'is the volume mounted?',
    );
  }
  if (kind === 'absent' || isEffectivelyEmpty(path)) {
    if (!opts.allowCreate) {
      throw notFound(
        `no vault at ${path}`,
        'is the volume mounted? set MIMIR_VAULT / [vault] path at an existing vault, or create one there first',
      );
    }
    return create(path, opts.exec);
  }

  const markerPath = join(path, MARKER_FILE);
  if (!existsSync(markerPath)) {
    throw conflict(
      `${path} is not a mimir vault — refusing to adopt a non-empty directory`,
      'point the vault at an empty directory, or at an existing mimir vault',
    );
  }
  const marker = parseMarker(readFileSync(markerPath, 'utf8'));
  if (marker === null) {
    throw conflict(
      `${path} has an unreadable ${MARKER_FILE} — refusing to converge`,
      'restore the marker from git history, or fix its schema field',
    );
  }
  if (marker.schema > VAULT_SCHEMA) {
    throw conflict(
      `the vault at ${path} is schema ${String(marker.schema)}, newer than this mimir (schema ${String(VAULT_SCHEMA)})`,
      'upgrade mimir: mimir self-update',
    );
  }

  const changed: string[] = [];
  // Rules first: a data migration's client reads the vault under the new schema,
  // so the regenerated config must already be on disk before it runs.
  const rulesPath = join(path, NORN_CONFIG_FILE);
  if (!existsSync(rulesPath) || readFileSync(rulesPath, 'utf8') !== renderNornConfig()) {
    mkdirSync(dirname(rulesPath), { recursive: true });
    writeFileSync(rulesPath, renderNornConfig());
    changed.push(NORN_CONFIG_FILE);
  }
  if (marker.schema < VAULT_SCHEMA) {
    // Data migrations run BEFORE the marker bump: a crash mid-backfill leaves the
    // marker at the old schema so the next converge retries (each backfill is
    // idempotent). The marker bump is the last, atomic "upgrade complete" step.
    const migrated = (await opts.migrateData?.(path, marker.schema)) ?? [];
    changed.push(...migrated);
    writeFileSync(markerPath, renderMarker());
    changed.push(MARKER_FILE);
  }

  const git = gitAt(path, opts.exec);
  if (!existsSync(join(path, '.git'))) {
    // A restored/copied vault: re-establish history with a full baseline —
    // the one commit that stages everything (there is no history to protect).
    if (await git.run(['init'], 'init failed — the vault works, but has no history')) {
      await commitStaged(git, ['-A'], 'mimir: baseline restored vault');
    }
  } else if (changed.length > 0) {
    await commitStaged(git, changed, `mimir: converge vault to schema ${String(VAULT_SCHEMA)}`);
  }
  return { outcome: 'converged', upgraded: changed.length > 0, warnings: git.warnings };
}
