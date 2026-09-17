import type { HistoryEntry, Scratchpad } from '@mimir/contract';

import type { ArtifactRecord } from './artifacts/store';
import type { NextFacet } from './body-sections/store';
import type { Dependency, Node, Project } from './model';
import type { SeedRecord } from './seeds/store';
import type { NewAnnotationRecord, NewTagRecord, NewTransitionRecord } from './store';

/**
 * The backend-neutral transfer document (ADR 0030 Decision 4) — every STORED
 * FACT one `Store` holds, in one shape both backends export and import with
 * identity (ids, sequences, timestamps) preserved. Migrating between backends is
 * an export/import pair on the seam.
 *
 * **It carries the facts the seam surfaces, and the export refuses when the
 * store holds a document it cannot carry.** A `Store` read is deliberately
 * tolerant of corruption (ADR 0017): it drops an orphaned node, prunes a
 * dangling dependency edge, nulls a dangling scratchpad anchor, and hides an
 * identity collision. Tolerance is right for a read and wrong for a copy — a
 * silently narrower document would be a backup missing the very records the
 * operator most needs. So the export is fail-closed: it enumerates the physical
 * documents, refuses when any of them has no representative in the document, and
 * names the paths. Under that refusal the "portable backup" claim is true, which
 * is the only reason it is made.
 *
 * **Stored facts only.** Nothing derived crosses this boundary: no status word,
 * no rollup, no predicate, no attention state (ADR 0001 — the core recomputes
 * all of it on the target from these same inputs). A fact that a `Store` read
 * synthesizes rather than persists (a vault tag's `created_at`, taken from its
 * document's `created`) is likewise absent: the import restores the fact it was
 * synthesized from, and the target re-synthesizes it identically.
 *
 * **Shapes are the seam's own.** Every collection is typed from the record the
 * `Store` seam already speaks ({@link Project}, {@link Node}, {@link Dependency},
 * {@link NewTagRecord}, {@link NewAnnotationRecord}, {@link ArtifactRecord},
 * {@link SeedRecord}, {@link Scratchpad}, {@link NextFacet},
 * {@link NewTransitionRecord}); a bespoke field appears only where no seam
 * record carries the fact, and is commented where it does.
 */

/** The transfer document's own schema version — bumped on any shape change. */
export const STORE_EXPORT_SCHEMA_VERSION = 1;

/**
 * One project's sequence-allocation state (ADR 0006): the highest sequence
 * handed out per kind, one counter per id grammar (`KEY-N`, `KEY-aN`, `KEY-sN`).
 *
 * Carried explicitly even though Norn derives it — for Norn the counters are
 * implicit in the documents present, so an export could omit them and a Norn
 * import would still allocate correctly. Postgres (MMR-379) stores them as
 * columns and must write them at import, so the document states them rather
 * than making one backend re-derive another's allocator state.
 */
export type ExportedCounters = {
  node: number;
  artifact: number;
  seed: number;
};

/** A project row plus its allocation state. */
export type ExportedProject = Project & {
  counters: ExportedCounters;
};

/**
 * One tag application. `created_at` is deliberately absent: a vault tag set is
 * plain strings (ADR 0005) and the read path synthesizes the timestamp from the
 * owning document's `created`, which the import preserves.
 */
export type ExportedTag = NewTagRecord;

/**
 * An artifact with its frozen content (ADR 0004). `source_scratch` is the one
 * fact no seam record carries — {@link ArtifactRecord} omits it, but
 * `ArtifactStore.findBySourceScratch` reads it back, so it is stored and must
 * survive the round trip.
 *
 * `tags` and `links` are sorted (MMR-380). Both are sets (ADR 0005 for tags;
 * links are anchors), so their order is not a fact, and a vault stores them in
 * authored order while Postgres reads them sorted — the export fixes one order
 * so the two backends emit the same record.
 */
export type ExportedArtifact = ArtifactRecord & {
  content: string;
  source_scratch: string | null;
};

/**
 * A seed with its `## Seed Description` prose and its own `## History`. Seed
 * transitions are NOT in {@link StoreExport.transitions}: that feed is
 * entity-keyed to nodes and projects (ADR 0015), while a seed's log is read
 * through `SeedStore.loadHistory` alone.
 */
export type ExportedSeed = SeedRecord & {
  description: string | null;
  history: readonly HistoryEntry[];
};

/**
 * The owned prose sections of one document, keyed by its canonical stem (a bare
 * `KEY` for a project, `KEY-seq` for a node). `description` is a node's
 * `## Task Description` — body-authoritative since MMR-162, which is why
 * {@link Node.description} reads null off a working set. The `annotations` and
 * `history` body facets are their own top-level collections.
 *
 * `next` is the `## Next` direction narrative (MMR-321) as the whole
 * {@link NextFacet}, prose AND heading presence. Presence is a stored fact the
 * prose cannot carry: a hand-emptied `## Next` is present with null text, and an
 * export of the text alone would drop the heading on import — the section would
 * come back absent, and the next write would INSERT rather than replace it.
 */
export type ExportedBodySections = {
  stem: string;
  description?: string | null;
  next: NextFacet;
};

/**
 * One whole store's stored facts. Each collection is justified against "what
 * would a `Store` read surface that this omits?".
 */
export type StoreExport = {
  schema_version: typeof STORE_EXPORT_SCHEMA_VERSION;
  /** When this document was produced — the only field a re-export may differ in. */
  exported_at: string;
  /** Every project, archived included, with its per-kind sequence counters. */
  projects: readonly ExportedProject[];
  /** Every node. `description` is null here; the prose rides `bodySections`. */
  nodes: readonly Node[];
  /** The prerequisite edges — whole-store, because they cross project bounds. */
  edges: readonly Dependency[];
  /** Node and project tag applications. An artifact's tags ride its own record
   * ({@link ExportedArtifact} is an {@link ArtifactRecord}); a second copy here
   * would be two sources for one fact. Seeds carry no tags. */
  tags: readonly ExportedTag[];
  /** The `## Annotations` notes. Node-only — projects carry no such section. */
  annotations: readonly NewAnnotationRecord[];
  /** Artifacts with their frozen bodies. */
  artifacts: readonly ExportedArtifact[];
  /** Seeds with their description prose and lifecycle history. */
  seeds: readonly ExportedSeed[];
  /** Temporary episode documents, whole (their body sections are typed state). */
  scratchpads: readonly Scratchpad[];
  /** The owned prose sections of projects and nodes. */
  bodySections: readonly ExportedBodySections[];
  /** The `## History` rows of projects and nodes, entity-keyed (ADR 0015), with
   * their resume-handle echoes, in {@link canonicalTransitionOrder}. */
  transitions: readonly NewTransitionRecord[];
};

/**
 * The one order every backend emits {@link StoreExport.transitions} in
 * (MMR-380): project rows first, by key; then node rows, by project key and
 * numeric sequence; within an entity, the rows in the order given — which each
 * backend supplies as its document order (the `## History` order on a vault,
 * insert order on Postgres). That per-entity order is the stored fact
 * (ADR 0015); the grouping across entities is a convention, fixed here so two
 * backends holding the same facts emit byte-identical collections. A global
 * timestamp order was rejected: it is not a stored fact, a hand-edited or
 * clock-skewed history need not be monotonic, and sorting on it would reorder
 * a `## History` section on the way through.
 *
 * Stable: ties (same entity) keep their input order.
 */
export function canonicalTransitionOrder(
  rows: readonly NewTransitionRecord[],
): NewTransitionRecord[] {
  return rows
    .map((row, index) => ({ index, key: entityRank(row), row }))
    .toSorted((a, b) => compareEntityRank(a.key, b.key) || a.index - b.index)
    .map((entry) => entry.row);
}

type EntityRank = { kind: 0 | 1; project: string; seq: number };

/** Projects rank before nodes; a node's rank is its project key then sequence. */
function entityRank(row: NewTransitionRecord): EntityRank {
  if (row.node_id === undefined || row.node_id === null) {
    return { kind: 0, project: row.project_id ?? '', seq: 0 };
  }
  const dash = row.node_id.lastIndexOf('-');
  return {
    kind: 1,
    project: dash === -1 ? row.node_id : row.node_id.slice(0, dash),
    seq: dash === -1 ? 0 : Number(row.node_id.slice(dash + 1)),
  };
}

function compareEntityRank(a: EntityRank, b: EntityRank): number {
  return a.kind - b.kind || a.project.localeCompare(b.project) || a.seq - b.seq;
}

/**
 * How an import treats the target (ADR 0030 Decision 4).
 *
 * - `fresh` — the target holds none of the imported projects. Refused, before
 *   anything is written, when any imported project key already exists.
 * - `resume` — re-run of the same document after a partial import (the Norn
 *   failure contract is partial success, ADR 0023). Every document already
 *   present at its canonical path with content identical to what this import
 *   would write is skipped; a present document whose content differs refuses,
 *   naming the path.
 */
export type ImportMode = 'fresh' | 'resume';

export type ImportOptions = {
  mode: ImportMode;
  /**
   * Preview (MMR-380): run every check and decision an apply would run —
   * schema version, single-valued identities, the fresh-mode project fence,
   * the resume-mode skip-or-refuse per record — and report the outcome, but
   * write nothing. The default for the operator command is a preview; `--apply`
   * clears this. Absent means apply, so a seam caller that predates the flag
   * keeps writing.
   */
  dryRun?: boolean;
};

/** What one import did — or, on a preview, what an apply would do. */
export type ImportReport = {
  mode: ImportMode;
  /** False on a preview: the counts describe an apply that did not happen. */
  applied: boolean;
  /** Documents this run wrote (or would write). */
  created: number;
  /** Documents already present and identical, left untouched (`resume` only). */
  skipped: number;
};
