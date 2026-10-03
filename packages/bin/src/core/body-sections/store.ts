import type { AnnotationView, HistoryEntry } from '@mimir/contract';

/**
 * The body-section read slice (MMR-154). A node's prose and log facets —
 * description, the `## Next` narrative, annotations, and history — keep their
 * section names from the output contract; the store holds them as columns and
 * rows, and this seam yields the output-contract views over them.
 *
 * Node-scoped: project views carry no history/annotations facet, and the
 * cross-node transitions feed is a separate surface. Reads are keyed by the
 * node's canonical `KEY-seq` stem.
 */
/** Which body-section facets a batched {@link BodySectionStore.readSections}
 * pass should populate. */
export type BodySectionFacets = {
  description?: boolean;
  /** The `## Next` direction narrative (MMR-321) — project/container records only. */
  next?: boolean;
  annotations?: boolean;
  history?: boolean;
};

/**
 * The `## Next` facet as a read yields it: the parsed prose PLUS whether the
 * section is set at all.
 *
 * Presence is a stored fact the prose cannot carry: a section re-authored to
 * whitespace is present with null text. The write path reads it to detect a
 * no-op rewrite (MMR-321), and the store export carries it, so presence
 * survives a round trip (ADR 0030 Decision 4).
 */
export type NextFacet = {
  /** The record carries a `## Next` section. */
  present: boolean;
  text: string | null;
};

/** A batched body-section read — only the facets named in the request are set. */
export type BodySections = {
  description?: string | null;
  next?: NextFacet;
  annotations?: AnnotationView[];
  history?: HistoryEntry[];
};

export type BodySectionStore = {
  readHistory: (stem: string) => Promise<HistoryEntry[]>;
  readAnnotations: (stem: string) => Promise<AnnotationView[]>;
  /** A node's full description prose (MMR-162). Trimmed; empty → null. */
  readDescription: (stem: string) => Promise<string | null>;
  /**
   * The `## Next` direction narrative WITH its presence (MMR-321). The read
   * facet goes through {@link readSections}; this single-stem probe mirrors
   * the write path's in-transaction `StoreWriter.readNextSection`.
   */
  readNext: (stem: string) => Promise<NextFacet>;
  /**
   * Read several body-section facets in one call (MMR-164, F6). A detail `get`
   * assembling `description` + `annotations` + `history` reads them together
   * rather than one call per facet. Only the facets named in `want` are
   * populated; the single-facet `read*` methods are wrappers over this.
   */
  readSections: (stem: string, want: BodySectionFacets) => Promise<BodySections>;
  /**
   * The same facets across MANY stems in one batch (MMR-322) — `readSections`'
   * fan-out sibling, keyed back by `KEY-seq` stem (a project's stem is its
   * bare `KEY`).
   *
   * A separate method rather than a `Promise.all` over `readSections` so the
   * store answers with one query per facet instead of one per stem: `overview`
   * composes sections over up-to-20 tasks plus every live container on the
   * session-boot hot path.
   *
   * A stem with no record is simply absent from the map (never a throw);
   * callers treat absence as "no sections", exactly as `readSections` yields
   * empty facets for a missing record. Duplicate stems collapse.
   */
  readSectionsMany: (
    stems: readonly string[],
    want: BodySectionFacets,
  ) => Promise<Map<string, BodySections>>;
};
