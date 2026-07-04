import type { AnnotationView, HistoryEntry } from '@mimir/contract';

/**
 * The body-section read slice (MMR-154, ADR 0016 Phase 3) — the second
 * two-backend seam after {@link ArtifactStore}. A node's `## History` and
 * `## Annotations` facets are markdown body sections in the vault but structured
 * rows (`transition_log`, `annotation`) in SQLite; this seam yields the same
 * output-contract views from either, so a node view assembles identically over
 * both backends (parity is the point).
 *
 * Node-scoped: project views carry no history/annotations facet, and the
 * cross-node transitions feed is a separate surface. Keyed by BOTH identities —
 * the SQLite backend reads by the surrogate `nodeId`, the Norn backend by the
 * `KEY-seq` stem — so the caller passes what it already has from the view set.
 */
export type BodySectionStore = {
  readHistory: (nodeId: number, stem: string) => Promise<HistoryEntry[]>;
  readAnnotations: (nodeId: number, stem: string) => Promise<AnnotationView[]>;
};
