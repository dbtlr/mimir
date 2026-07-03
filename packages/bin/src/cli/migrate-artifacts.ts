import { restoreArtifact } from '../core/artifacts/norn';
import { createSqliteArtifactStore } from '../core/artifacts/sqlite';
import type { ArtifactRecord, ArtifactStore } from '../core/artifacts/store';
import type { Db } from '../core/context';
import { loadWorkingSet } from '../core/store-sqlite';
import { bunExec } from '../exec';
import { NornClient } from '../norn/client';
import { readConfig } from '../service/config';
import { converge } from '../vault/converge';
import { resolveVault } from '../vault/resolve';
/**
 * Cutover-only (MMR-144, ADR 0016 Phase 2a): copy every artifact from the
 * SQLite table into the Norn vault, preserving each artifact's identity
 * (`KEY-aN` stem), `created` timestamp, links, and tags. SQLite is read-only
 * here and stays the default backend, so the run is non-destructive; it exists
 * to make the vault backend usable on real data before the flag is flipped.
 *
 * Flag-independent by construction: the source is always the SQLite table and
 * the destination is always the vault, regardless of `MIMIR_ARTIFACT_STORE`.
 * Idempotent — a re-run's already-migrated artifacts come back `skipped` via
 * the vault's create-exclusive write. Delete this file, its CLI case, and
 * `restoreArtifact` together once the vault is the sole backend.
 */
import type { Io } from './render';

/** Writes one source artifact into the destination; `skipped` = already present. */
export type ArtifactRestore = (
  record: ArtifactRecord,
  content: string,
) => Promise<'created' | 'skipped'>;

export type MigrationReport = {
  projects: number;
  /** Source artifacts seen. */
  total: number;
  /** Written this run. */
  created: number;
  /** Already present in the vault (idempotent re-run). */
  skipped: number;
  dryRun: boolean;
};

/**
 * Copy every SQLite artifact into the destination through `restore`. Pure
 * orchestration — the source store and the restore write are injected, so it
 * is testable without a live norn. `dryRun` counts the source inventory and
 * writes nothing.
 */
export async function migrateArtifacts(
  source: ArtifactStore,
  keys: string[],
  restore: ArtifactRestore,
  opts: { dryRun?: boolean } = {},
): Promise<MigrationReport> {
  const dryRun = opts.dryRun === true;
  let total = 0;
  let created = 0;
  let skipped = 0;
  for (const key of keys) {
    // listForProject yields identity + metadata (no content/links); load then
    // fetches the frozen body and the anchor links for a faithful copy.
    const inventory = await source.listForProject(key);
    for (const meta of inventory) {
      const full = await source.load(meta.key, meta.seq, { content: true });
      if (full === undefined) {
        continue; // vanished between the list and the load — nothing to copy
      }
      total += 1;
      if (dryRun) {
        continue;
      }
      const outcome = await restore(full, full.content ?? '');
      if (outcome === 'created') {
        created += 1;
      } else {
        skipped += 1;
      }
    }
  }
  return { created, dryRun, projects: keys.length, skipped, total };
}

/** Render the report: structured envelope for machines, one line for humans. */
function render(io: Io, report: MigrationReport, json: boolean): void {
  if (json) {
    io.write(JSON.stringify(report));
    return;
  }
  const glyph = io.plain ? '[ok]' : '\x1b[32m✓\x1b[0m';
  if (report.dryRun) {
    io.write(
      `[dry-run] ${String(report.total)} artifact(s) across ${String(report.projects)} project(s) ` +
        `would migrate into the vault (re-run is idempotent)`,
    );
    return;
  }
  io.write(
    `${glyph} migrated ${String(report.total)} artifact(s) across ${String(report.projects)} ` +
      `project(s): ${String(report.created)} written, ${String(report.skipped)} already present`,
  );
}

/**
 * The `mimir migrate-artifacts` command: builds the SQLite source over the
 * open db, converges + opens the vault destination, runs the migration, and
 * renders the report. The Norn client is closed before returning so its
 * subprocess never outlives the command.
 */
export async function cmdMigrateArtifacts(
  db: Db,
  io: Io,
  opts: { dryRun: boolean; json: boolean },
): Promise<number> {
  const source = createSqliteArtifactStore(db);
  const keys = (await loadWorkingSet(db)).projects.map((p) => p.key);

  const vault = resolveVault({
    configPath: readConfig().vault.path,
    envPath: process.env.MIMIR_VAULT,
  });
  await converge(vault.path, { allowCreate: vault.allowCreate, exec: bunExec });
  const client = new NornClient({ vaultPath: vault.path });
  try {
    const report = await migrateArtifacts(
      source,
      keys,
      (record, content) => restoreArtifact(client, record, content),
      { dryRun: opts.dryRun },
    );
    render(io, report, opts.json);
    return 0;
  } finally {
    await client.close();
  }
}
