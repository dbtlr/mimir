import type { AnnotationView, HistoryEntry } from '@mimir/contract';

/**
 * The body-section read slice (MMR-154, ADR 0016 Phase 3) — a seam after
 * {@link ArtifactStore}. A node's `## History` and `## Annotations` facets are
 * markdown body sections in the vault; this seam yields the output-contract
 * views over them.
 *
 * Node-scoped: project views carry no history/annotations facet, and the
 * cross-node transitions feed is a separate surface. Keyed by BOTH identities —
 * `nodeId` and the `KEY-seq` stem — so the caller passes what it already has
 * from the view set; the read path resolves via the stem alone.
 */
/** Which body-section facets a batched {@link BodySectionStore.readSections}
 * pass should populate. */
export type BodySectionFacets = {
  description?: boolean;
  annotations?: boolean;
  history?: boolean;
};

/** A batched body-section read — only the facets named in the request are set. */
export type BodySections = {
  description?: string | null;
  annotations?: AnnotationView[];
  history?: HistoryEntry[];
};

export type BodySectionStore = {
  readHistory: (nodeId: number, stem: string) => Promise<HistoryEntry[]>;
  readAnnotations: (nodeId: number, stem: string) => Promise<AnnotationView[]>;
  /**
   * A node's full description prose — the `## Task Description` body section,
   * authoritative since MMR-162 (ADR 0016 Refinement), sliced from the
   * document body. Trimmed; empty → null.
   */
  readDescription: (nodeId: number, stem: string) => Promise<string | null>;
  /**
   * Read several body-section facets in one round-trip (MMR-164, F6). A detail
   * `get` assembling `description` + `annotations` + `history` reads one node
   * document; fetches its `.body` **once** and slices each requested section,
   * versus one fetch per facet. Only the facets named in `want` are populated;
   * the single-facet `read*` methods are wrappers over this.
   */
  readSections: (nodeId: number, stem: string, want: BodySectionFacets) => Promise<BodySections>;
  /**
   * Of the given stems, those whose `## Annotations` heading the backend cannot
   * resolve — a hand-edited duplicate (ambiguous) or a missing heading — so a
   * native section read/append degrades silently (ADR 0017, the MMR-239 channel).
   * The triage pass consults this before appending a check-(c) annotation, so a
   * corrupt anchor is quarantined into its `failures[]` (→ `mimir doctor`) rather
   * than blind-appended onto (which would refuse and abort the pass). Queries
   * norn's `section_failures` directly.
   */
  annotationSectionFailures: (stems: string[]) => Promise<Set<string>>;
};
