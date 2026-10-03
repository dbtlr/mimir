import type {
  ExecutionHandles,
  Hold,
  Lifecycle,
  NodeType,
  Priority,
  ScratchpadAgendaItem,
  ScratchpadJournalEntry,
  SeedKind,
  SeedLifecycle,
  Size,
  TagEntityType,
  TransitionKind,
} from '@mimir/contract';
import type {
  ColumnType,
  Generated,
  Insertable,
  Kysely,
  Selectable,
  Transaction,
  Updateable,
} from 'kysely';

/**
 * The relational shape of the shared SQL store (ADR 0030, ADR 0032) — the
 * Kysely table types every dialect's backend is written against.
 *
 * Three representational commitments, all deliberate:
 *
 * - **The external stem is the primary key.** `KEY`, `KEY-seq`, `KEY-aN`,
 *   `KEY-sN`, and a scratchpad's UUID are the identities the `Store` seam
 *   speaks, so they are the identities the rows carry. There is no surrogate
 *   integer id to translate at the boundary, and the primary key is therefore
 *   what makes `hasIdentityCollision` structurally false.
 * - **Timestamps are `text`, never `timestamptz`.** Every instant the core
 *   writes is a canonical ISO-8601 UTC string (`core/time.ts`), the transfer
 *   document carries it verbatim, and lexical comparison of two stored values
 *   is chronological by that invariant. A `timestamptz` round trip would
 *   reformat the value and make a Norn export and a Postgres export of the same
 *   store differ.
 * - **A column whose JS shape differs by driver is {@link Stored}.** A boolean,
 *   a list of text, and a JSON document each come back from one driver as the
 *   value and from another as an encoding of it, so their row types are opaque
 *   and only the dialect's codec reads or writes them (see `./dialect`).
 */

/** Either a pooled handle or an open transaction — every read takes both. */
export type Executor = Kysely<DB> | Transaction<DB>;

declare const stored: unique symbol;

/**
 * A `T` in the form one dialect's driver stores it — opaque on purpose. The
 * only way in or out is that dialect's codec, so a query that forgets to encode
 * a write or decode a read does not compile.
 */
export type Stored<T> = { readonly [stored]: T };

/**
 * Brand a driver value as the stored form of a `T`. A codec's encode half —
 * nothing else — calls this, and the claim it makes is the codec's to keep.
 */
export function toStored<T>(driverValue: unknown): Stored<T> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the brand exists only at compile time; the codec calling this owns the claim.
  return driverValue as Stored<T>;
}

/**
 * Read a stored value as the `T` the driver already yields — the decode half of
 * a codec whose driver speaks the store's shape natively.
 */
export function fromStored<T>(value: Stored<T>): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the brand exists only at compile time; the codec calling this owns the claim.
  return value as unknown as T;
}

/**
 * An auto-incrementing surrogate key (`bigserial` on Postgres) — the one place
 * this schema uses a machine id, for the append-only logs whose ORDER is the
 * fact. Drivers disagree on its shape (`string` from node-postgres, `number`
 * from PGlite), so the read path normalizes with {@link toRowId}.
 */
type RowId = ColumnType<string | number, undefined, never>;

export type ProjectTable = {
  key: string;
  name: string;
  description: string | null;
  archived_at: string | null;
  last_seq: Generated<number>;
  last_artifact_seq: Generated<number>;
  last_seed_seq: Generated<number>;
  next_present: Generated<Stored<boolean>>;
  next_text: string | null;
  created_at: string;
  updated_at: string;
};

export type NodeTable = {
  /** `KEY-seq`. */
  id: string;
  project_key: string;
  type: NodeType;
  parent_id: string | null;
  seq: number;
  title: string;
  description: string | null;
  summary: string | null;
  lifecycle: Lifecycle | null;
  hold: Hold | null;
  hold_reason: string | null;
  priority: Priority | null;
  size: Size | null;
  rank: number | null;
  external_ref: string | null;
  upstream: string | null;
  host: string | null;
  harness: string | null;
  session: string | null;
  branch: string | null;
  completed_at: string | null;
  target: string | null;
  open_ended: Stored<boolean> | null;
  next_present: Generated<Stored<boolean>>;
  next_text: string | null;
  created_at: string;
  updated_at: string;
};

export type DependencyTable = {
  node_id: string;
  depends_on_node_id: string;
};

export type AnnotationTable = {
  id: RowId;
  node_id: string;
  content: string;
  created_at: string;
};

export type ArtifactTable = {
  /** `KEY-aN`. */
  id: string;
  project_key: string;
  seq: number;
  title: string;
  summary: string | null;
  /** Stored WITHOUT a trailing newline — the seam's read-back form. */
  content: string;
  source_scratch: string | null;
  created_at: string;
  updated_at: string;
};

export type ArtifactLinkTable = {
  artifact_id: string;
  node_id: string;
};

/**
 * One tag application. There is no `created_at`: the seam synthesizes a tag's
 * timestamp from the owning entity's own `created_at` (ADR 0005, Norn parity),
 * and storing a second copy would be two sources for one fact.
 */
export type TagTable = {
  entity_type: TagEntityType;
  /** A project key, a node stem, or an artifact stem. */
  entity_id: string;
  tag: string;
};

export type TransitionLogTable = {
  id: RowId;
  node_id: string | null;
  project_key: string | null;
  kind: TransitionKind;
  from_value: string | null;
  to_value: string | null;
  reason: string | null;
  handles: Stored<ExecutionHandles> | null;
  at: string;
};

export type SeedTable = {
  /** `KEY-sN`. */
  id: string;
  project_key: string;
  seq: number;
  title: string;
  kind: SeedKind;
  lifecycle: SeedLifecycle;
  requester: string | null;
  description: string | null;
  spawned: Generated<Stored<string[]>>;
  created_at: string;
  updated_at: string;
};

export type SeedHistoryTable = {
  id: RowId;
  seed_id: string;
  kind: TransitionKind;
  from_value: string | null;
  to_value: string | null;
  reason: string | null;
  at: string;
};

export type ScratchpadTable = {
  /** A canonical lowercase UUIDv4. */
  id: string;
  project_key: string;
  title: string;
  anchors: Generated<Stored<string[]>>;
  journal: Stored<ScratchpadJournalEntry[]>;
  agenda: Stored<ScratchpadAgendaItem[]>;
  freezing_at: string | null;
  created_at: string;
  updated_at: string;
};

export type SchemaVersionTable = {
  version: number;
  applied_at: string;
};

export type DB = {
  annotation: AnnotationTable;
  artifact: ArtifactTable;
  artifact_link: ArtifactLinkTable;
  dependency: DependencyTable;
  node: NodeTable;
  project: ProjectTable;
  schema_version: SchemaVersionTable;
  scratchpad: ScratchpadTable;
  seed: SeedTable;
  seed_history: SeedHistoryTable;
  tag: TagTable;
  transition_log: TransitionLogTable;
};

export type ProjectRow = Selectable<ProjectTable>;
export type NodeRow = Selectable<NodeTable>;
export type ArtifactRow = Selectable<ArtifactTable>;
export type SeedRow = Selectable<SeedTable>;
export type ScratchpadRow = Selectable<ScratchpadTable>;
export type NodeUpdate = Updateable<NodeTable>;
export type ProjectUpdate = Updateable<ProjectTable>;
export type NodeInsert = Insertable<NodeTable>;

/** Normalize a `bigserial` surrogate key, whichever shape the driver yields. */
export function toRowId(value: string | number): number {
  return typeof value === 'number' ? value : Number(value);
}
