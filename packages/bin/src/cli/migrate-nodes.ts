import type { AnnotationView, HistoryEntry } from '@mimir/contract';

import { createSqliteStore } from '../core';
import type { Db } from '../core/context';
import { renderMigratedNodeBody, renderMigratedProjectBody } from '../core/history-codec';
import { bunExec } from '../exec';
import { NornClient } from '../norn/client';
import { readConfig } from '../service/config';
import { converge } from '../vault/converge';
import { buildSeedDocs } from '../vault/node-seed';
import type { NodeBodies, SeedDoc } from '../vault/node-seed';
import { resolveVault } from '../vault/resolve';
import { ok } from './render';
import type { Io } from './render';

/**
 * Authoritative node/project migration (MMR-155, ADR 0016 Phase 3) — the
 * lossless SQLite→vault projection, the counterpart to the artifact cutover
 * (`./migrate-artifacts`). It reuses the seed's traversal ({@link buildSeedDocs})
 * but reconstructs each document's `## History` and `## Annotations` body
 * sections from the `transition_log` / `annotation` rows the throwaway seed
 * omitted. Frontmatter (created_at included) is written directly by the shared
 * mappers, never through the create-stamping write verbs, so timestamps survive.
 *
 * Pure orchestration + reconstruction here; the live-Norn write (converge,
 * create-exclusive + fingerprint skip) is the command's job, like the artifact
 * migrator. SQLite stays the source of truth until the Phase 4 cutover.
 */

/** Writes one migrated doc; `skipped` = the identical doc is already present. */
export type NodeRestore = (doc: SeedDoc) => Promise<'created' | 'skipped'>;

export type NodeMigrationReport = {
  projects: number;
  nodes: number;
  /** Written this run. */
  created: number;
  /** Already present, identical (idempotent re-run). */
  skipped: number;
  dryRun: boolean;
};

/** Append `value` to the array at `key`, creating it on first hit. */
function pushInto<T>(map: Map<number, T[]>, key: number, value: T): void {
  const list = map.get(key);
  if (list === undefined) {
    map.set(key, [value]);
  } else {
    list.push(value);
  }
}

/**
 * Read the transition log + annotations once and reconstruct the body builders:
 * `## History` from `transition_log` (node- and project-keyed — the `archive`
 * kind is project-keyed) in insertion order, `## Annotations` from `annotation`
 * in created-at order — the same orders the read path preserves.
 */
export async function reconstructNodeBodies(db: Db): Promise<NodeBodies> {
  const historyByNode = new Map<number, HistoryEntry[]>();
  const historyByProject = new Map<number, HistoryEntry[]>();
  const transitions = await db
    .selectFrom('transition_log')
    .select(['node_id', 'project_id', 'kind', 'from_value', 'to_value', 'at', 'reason'])
    .orderBy('id', 'asc')
    .execute();
  for (const row of transitions) {
    const entry: HistoryEntry = {
      at: row.at,
      from: row.from_value,
      kind: row.kind,
      reason: row.reason,
      to: row.to_value,
    };
    if (row.node_id !== null) {
      pushInto(historyByNode, row.node_id, entry);
    } else if (row.project_id !== null) {
      pushInto(historyByProject, row.project_id, entry);
    }
  }

  const annotationsByNode = new Map<number, AnnotationView[]>();
  const annotations = await db
    .selectFrom('annotation')
    .select(['node_id', 'content', 'created_at'])
    .orderBy('created_at', 'asc')
    .execute();
  for (const row of annotations) {
    pushInto(annotationsByNode, row.node_id, { content: row.content, createdAt: row.created_at });
  }

  return {
    node: (node) =>
      renderMigratedNodeBody(
        node.description,
        historyByNode.get(node.id) ?? [],
        annotationsByNode.get(node.id) ?? [],
      ),
    project: (project) => renderMigratedProjectBody(historyByProject.get(project.id) ?? []),
  };
}

/**
 * Write every migrated document through `restore`. Pure — the source docs and
 * the restore write are injected, so it tests without a live norn. `dryRun`
 * counts the inventory and writes nothing.
 */
export async function migrateNodes(
  docs: { projects: SeedDoc[]; nodes: SeedDoc[] },
  restore: NodeRestore,
  opts: { dryRun?: boolean } = {},
): Promise<NodeMigrationReport> {
  const report: NodeMigrationReport = {
    created: 0,
    dryRun: opts.dryRun === true,
    nodes: 0,
    projects: 0,
    skipped: 0,
  };
  if (opts.dryRun === true) {
    report.projects = docs.projects.length;
    report.nodes = docs.nodes.length;
    return report;
  }
  // Projects precede nodes so a relation target is on disk before its dependent.
  for (const doc of docs.projects) {
    report[await restore(doc)] += 1;
    report.projects += 1;
  }
  for (const doc of docs.nodes) {
    report[await restore(doc)] += 1;
    report.nodes += 1;
  }
  return report;
}

/** `field=<json>` entries for `vault.new` — the newDoc shape of a frontmatter record. */
function toFieldJson(frontmatter: Record<string, unknown>): string[] {
  return Object.entries(frontmatter).map(([key, value]) => `${key}=${JSON.stringify(value)}`);
}

function isPathCollision(error: unknown): boolean {
  return error instanceof Error && /already exists/i.test(error.message);
}

/** The `.body` of a `vault.get` record; missing/absent bodies read empty. */
function bodyOf(record: unknown): string {
  if (typeof record === 'object' && record !== null && 'body' in record) {
    const { body } = record;
    if (typeof body === 'string') {
      return body;
    }
  }
  return '';
}

/**
 * Whether the document already at `path` is byte-for-byte the one this migration
 * would write, judged by its BODY — the reconstructed `## History`/
 * `## Annotations`/description, which is deterministic from SQLite and round-trips
 * verbatim (unlike frontmatter, which Norn may reformat). Trailing whitespace is
 * ignored. A frontmatter-only Phase-2b seed doc, a stale doc whose source gained
 * a transition/annotation, or a foreign doc all differ here and are NOT skipped.
 */
async function alreadyMigrated(client: NornClient, doc: SeedDoc): Promise<boolean> {
  const existing = await client.get([doc.path], '.body');
  return bodyOf(existing[0]).trimEnd() === doc.body.trimEnd();
}

/**
 * Write one migrated doc at its literal `KEY-seq` stem — create-exclusive, so a
 * re-run collides. A collision is idempotent (`skipped`) ONLY if the document
 * already there has this exact reconstructed body — a prior run of THIS
 * migration. Any other doc at the stem (an empty seed, a diverged source, a
 * foreign doc) rethrows rather than falsely reporting `skipped` — the migration
 * is a cutover into a fresh or copied vault, so a body mismatch is a real
 * conflict the operator must resolve, never silent data loss.
 */
export function restoreNodeDoc(client: NornClient): NodeRestore {
  return async (doc) => {
    try {
      await client.newDoc({
        body: doc.body,
        confirm: true,
        field_json: toFieldJson(doc.frontmatter),
        parents: true,
        path: doc.path,
      });
      return 'created';
    } catch (error) {
      if (isPathCollision(error) && (await alreadyMigrated(client, doc))) {
        return 'skipped';
      }
      throw error;
    }
  };
}

/** Render the report: a structured envelope for machines, one line for humans. */
function render(io: Io, report: NodeMigrationReport, json: boolean): void {
  if (json) {
    io.write(JSON.stringify(report));
    return;
  }
  const scope = `${String(report.nodes)} node(s) + ${String(report.projects)} project(s)`;
  if (report.dryRun) {
    io.write(`[dry-run] ${scope} would migrate into the vault (re-run is idempotent)`);
    return;
  }
  ok(io, `migrated ${scope}: ${String(report.created)} written, ${String(report.skipped)} present`);
}

/** A restore that is never invoked — the dry-run path counts without writing. */
const restoreNever: NodeRestore = () => {
  throw new Error('dry-run must not write');
};

/**
 * The `mimir migrate nodes` command. The source is always the SQLite store; a
 * dry-run reports the inventory and touches nothing. A real run reconstructs
 * every document, converges + opens the vault, writes idempotently, and closes
 * the Norn client before returning. Re-runnable against a copy: point
 * `MIMIR_VAULT` at a copied vault.
 */
export async function cmdMigrateNodes(
  db: Db,
  io: Io,
  opts: { dryRun: boolean; json: boolean },
): Promise<number> {
  const ws = await createSqliteStore(db).loadWorkingSet();

  // Dry-run needs no destination and no bodies: count the inventory off the
  // working set alone (empty-body docs), never scan the transition/annotation
  // tables, converge the vault, or spawn a Norn subprocess.
  if (opts.dryRun) {
    render(io, await migrateNodes(buildSeedDocs(ws), restoreNever, { dryRun: true }), opts.json);
    return 0;
  }

  const docs = buildSeedDocs(ws, await reconstructNodeBodies(db));
  const vault = resolveVault({
    configPath: readConfig().vault.path,
    envPath: process.env.MIMIR_VAULT,
  });
  await converge(vault.path, { allowCreate: vault.allowCreate, exec: bunExec });
  const client = new NornClient({ vaultPath: vault.path });
  try {
    render(io, await migrateNodes(docs, restoreNodeDoc(client), { dryRun: false }), opts.json);
    return 0;
  } finally {
    await client.close();
  }
}
