/**
 * The artifact storage seam (MMR-143, ADR 0016 Phase 2a) — the first slice
 * where a second backend exists behind the `Store`. Artifacts are keyed by
 * **canonical identity** (`key` + `seq`, the `KEY-aN` stem): no separate ids
 * cross this boundary, because the Norn backend has none — the file stem is
 * the id (ADR 0016: "the id↔int lookup layer thins").
 *
 * The seam is storage vocabulary only. Behavioral invariants — title
 * non-blank, project active, links stay in-project — remain in the verbs
 * (`attachArtifact`/`updateArtifact`), same altitude as `StoreWriter`.
 *
 * Archived-project hiding (ADR 0015) is the *caller's* concern: the intent
 * layer passes `excludeProjects` where hiding applies, because archived
 * state lives with the node backend, which this seam must not reach into.
 */

/** One artifact's metadata, backend-neutral. `links` are node stems (`KEY-seq`). */
export type ArtifactRecord = {
  key: string;
  seq: number;
  title: string;
  created_at: string;
  tags: string[];
  links: string[];
};

export type ArtifactCreate = {
  /** The owning project's key — existence/active already asserted by the verb. */
  key: string;
  title: string;
  content: string;
  tags: string[];
  /** Linked node stems (`KEY-seq`), already validated same-project by the verb. */
  links: string[];
};

/** Portfolio artifact search (MMR-52). All filters compose with AND. */
export type ArtifactListQuery = {
  project?: string;
  tag?: string;
  since?: string;
  before?: string;
  q?: string;
  limit?: number;
  /** Rows to skip before the window — pages the newest-first list. */
  offset?: number;
  /** Project keys whose artifacts read as absent (archived, ADR 0015). */
  excludeProjects?: string[];
};

export type ArtifactStore = {
  /** Allocate the next seq and persist the artifact; returns its identity. */
  create: (input: ArtifactCreate) => Promise<{ key: string; seq: number }>;
  /** One artifact's record; the frozen body only when `content` is opted in. */
  load: (
    key: string,
    seq: number,
    opts?: { content?: boolean },
  ) => Promise<(ArtifactRecord & { content?: string }) | undefined>;
  /** Retitle (the one mutable field, ADR 0004); false when the artifact doesn't exist. */
  updateTitle: (key: string, seq: number, title: string) => Promise<boolean>;
  /** Artifacts linked to a node (its `artifacts` facet), seq ascending. */
  listForNode: (nodeStem: string) => Promise<ArtifactRecord[]>;
  /** A project's whole inventory (`get KEY --col artifacts`), seq ascending. */
  listForProject: (key: string) => Promise<ArtifactRecord[]>;
  /** The cross-project feed, newest-first; metadata only. */
  list: (query: ArtifactListQuery) => Promise<{ total: number; items: ArtifactRecord[] }>;
  /** Idempotent tag apply. Frontmatter tags are a plain string set (ADR 0005) —
   * a tag application carries no note on any entity. */
  applyTag: (key: string, seq: number, tag: string) => Promise<void>;
  /** Remove tags; returns how many were actually present. */
  removeTags: (key: string, seq: number, tags: string[]) => Promise<number>;
};
