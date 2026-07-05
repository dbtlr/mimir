import type { TransitionsResult } from '@mimir/contract';

/** Paging options for the cross-node transition feed. */
export type TransitionsOptions = {
  /** Opaque resume cursor from a prior read — only strictly-newer entries return. */
  since?: string;
  limit?: number;
};

/**
 * The cross-node transition feed slice (MMR-160, ADR 0016 Phase 3) — the third
 * two-backend seam after {@link import('../artifacts/store').ArtifactStore} and
 * {@link import('../body-sections/store').BodySectionStore}. The whole-portfolio
 * transition log (ADR 0002/0003): the SQLite backend reads the append-only
 * `transition_log` table in id order; the Norn backend fans every node/project
 * `## History` section out of the vault and merges them. Both yield the same
 * {@link TransitionsResult} page, so `/api/transitions` renders identically over
 * either backend (parity is the point).
 *
 * The cursor is opaque and backend-specific — an integer id over SQLite, an
 * `(at, stem, index)` composite over Norn (there is no global log to number).
 * Callers only ever round-trip the `nextCursor` they were handed.
 */
export type TransitionsFeed = {
  list: (opts?: TransitionsOptions) => Promise<TransitionsResult>;
};
