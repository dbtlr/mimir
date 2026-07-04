import type { AnnotationView, HistoryEntry } from '@mimir/contract';

import type { Db } from '../core/context';
import { renderMigratedNodeBody, renderMigratedProjectBody } from '../core/history-codec';
import type { NodeBodies, SeedDoc } from '../vault/node-seed';

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
