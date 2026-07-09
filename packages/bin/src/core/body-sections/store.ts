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
   * authoritative since MMR-162 (ADR 0016 Refinement). The SQLite backend reads
   * the transitional `node.description` column; the Norn backend slices the
   * section from the document body. Trimmed; empty → null. Both trim so the two
   * backends agree byte-for-byte on the read surface.
   */
  readDescription: (nodeId: number, stem: string) => Promise<string | null>;
  /**
   * Read several body-section facets in one backend round-trip (MMR-164, F6).
   * A detail `get` assembling `description` + `annotations` + `history` reads
   * one node document; the Norn backend fetches its `.body` **once** and slices
   * each requested section, versus one fetch per facet. Only the facets named in
   * `want` are populated; the single-facet `read*` methods are wrappers over
   * this. SQLite reads its per-facet sources (no shared body to batch), so it
   * gains nothing here but honors the same seam.
   */
  readSections: (nodeId: number, stem: string, want: BodySectionFacets) => Promise<BodySections>;
  /**
   * Of the given stems, those whose `## Annotations` heading the backend cannot
   * resolve — a hand-edited duplicate (ambiguous) or a missing heading — so a
   * native section read/append degrades silently (ADR 0017, the MMR-239 channel).
   * The triage pass consults this before appending a check-(c) annotation, so a
   * corrupt anchor is quarantined into its `failures[]` (→ `mimir doctor`) rather
   * than blind-appended onto (which would refuse and abort the pass). The Norn
   * backend queries norn's `section_failures`; SQLite (typed `annotation` rows,
   * nothing malformable) always returns an empty set.
   */
  annotationSectionFailures: (stems: string[]) => Promise<Set<string>>;
};
