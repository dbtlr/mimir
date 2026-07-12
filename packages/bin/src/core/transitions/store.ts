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
 * transition log (ADR 0002/0003): every node/project `## History` section is
 * fanned out of the vault and merged into one {@link TransitionsResult} page.
 *
 * The cursor is opaque — an `(at, stem, index)` composite (there is no global
 * log to number). Callers only ever round-trip the `nextCursor` they were
 * handed.
 *
 * **The feed is `at`-ordered *best-effort*, not true insertion order, by
 * decision (MMR-164, ADR 0016 Refinement).** A markdown vault has no global
 * insertion sequence. Under a non-monotonic `at` (clock step-back, backfill,
 * hand-edited `## History`) the page order diverges, and the `(at, stem,
 * index)` cursor is not truly monotonic — a transition appended after a
 * cursor was issued but stamped with an earlier `at` sorts before it and is
 * skipped. Each Norn `list` also re-fans, validates, and parses the whole
 * vault (no `since`/`limit` push-down — `at` lives per-transition in the
 * body, which `find` cannot filter; the validator pass excludes dropped
 * nodes, MMR-189). These limits are **accepted**: the feed has no live
 * consumer today (the UI timeline is per-node; the `/api/transitions` route
 * is served but no client reads it), and a durable per-transition sequence
 * would reintroduce the
 * cross-doc coordination point this ADR's "markdown = truth, no global sequence"
 * premise rejects. A strict insertion-ordered feed is a consumer-driven
 * follow-up (MMR-168), to be designed against a real consumer's requirements.
 */
export type TransitionsFeed = {
  list: (opts?: TransitionsOptions) => Promise<TransitionsResult>;
};
