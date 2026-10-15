import type { TransitionsResult } from '@mimir/contract';

/** Paging options for the cross-node transition feed. */
export type TransitionsOptions = {
  /** Opaque resume cursor from a prior read — only strictly-newer entries return. */
  since?: string;
  limit?: number;
};

/**
 * The cross-node transition feed slice (MMR-160, ADR 0016 Phase 3) — a seam
 * after {@link import('../artifacts/store').ArtifactStore} and
 * {@link import('../body-sections/store').BodySectionStore}. The whole-portfolio
 * transition log (ADR 0002/0003): every node/project transition, merged into
 * one {@link TransitionsResult} page.
 *
 * The cursor is opaque — callers only ever round-trip the `nextCursor` they
 * were handed. The SQL store reads one append-only table ordered by `at` and a
 * real insertion sequence, so the cursor is monotonic.
 */
export type TransitionsFeed = {
  list: (opts?: TransitionsOptions) => Promise<TransitionsResult>;
};
