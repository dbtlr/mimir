import type { HistoryEntry, Scratchpad } from '@mimir/contract';

import type { ArtifactRecord } from './artifacts/store';
import type { BodySections } from './body-sections/store';
import type { Dependency, Node, Project } from './model';
import type { SeedRecord } from './seeds/store';
import type { NewAnnotationRecord, NewTagRecord, NewTransitionRecord } from './store';

/**
 * The backend-neutral transfer document (ADR 0030 Decision 4) — every STORED
 * FACT one `Store` holds, in one shape both backends export and import with
 * identity (ids, sequences, timestamps) preserved. It doubles as a portable
 * backup, and migrating between backends is an export/import pair on the seam.
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
 * {@link SeedRecord}, {@link Scratchpad}, {@link BodySections},
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
 * {@link Node.description} reads null off a working set — and `next` is the
 * `## Next` direction narrative (MMR-321). The `annotations` and `history`
 * facets of {@link BodySections} are their own top-level collections.
 */
export type ExportedBodySections = { stem: string } & Pick<BodySections, 'description' | 'next'>;

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
   * their resume-handle echoes, in document order per entity. */
  transitions: readonly NewTransitionRecord[];
};

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

export type ImportOptions = { mode: ImportMode };

/** What one import did. */
export type ImportReport = {
  mode: ImportMode;
  /** Documents this run wrote. */
  created: number;
  /** Documents already present and identical, left untouched (`resume` only). */
  skipped: number;
};
