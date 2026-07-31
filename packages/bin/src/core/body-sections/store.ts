import type { AnnotationView, HistoryEntry } from '@mimir/contract';

/**
 * The body-section read slice (MMR-154, ADR 0016 Phase 3) — a seam after
 * {@link ArtifactStore}. A node's `## History` and `## Annotations` facets are
 * markdown body sections in the vault; this seam yields the output-contract
 * views over them.
 *
 * Node-scoped: project views carry no history/annotations facet, and the
 * cross-node transitions feed is a separate surface. Reads are keyed by the
 * node's canonical `KEY-seq` stem.
 */
/** Which body-section facets a batched {@link BodySectionStore.readSections}
 * pass should populate. */
export type BodySectionFacets = {
  description?: boolean;
  /** The `## Next` direction narrative (MMR-321) — project/container docs only. */
  next?: boolean;
  annotations?: boolean;
  history?: boolean;
};

/** A batched body-section read — only the facets named in the request are set. */
export type BodySections = {
  description?: string | null;
  next?: string | null;
  annotations?: AnnotationView[];
  history?: HistoryEntry[];
};

/**
 * The `## Next` section as the WRITE path needs it (MMR-321): whether the
 * heading resolves at all, alongside its parsed prose. Presence is what picks
 * the section op — a document with no `## Next` gets one inserted, one that has
 * it gets its body replaced, and clearing removes the heading outright — and it
 * cannot be inferred from `text` alone (a hand-emptied section is present but
 * parses to null).
 */
export type NextSection = {
  /** norn resolved exactly one `## Next` heading on the document. */
  present: boolean;
  text: string | null;
  /**
   * The document carries a `## Next` heading norn could NOT resolve to a single
   * section — a hand-edited duplicate. Reads degrade to empty like every other
   * ambiguous section (ADR 0017), but a WRITE must refuse: `present` reads false
   * for a duplicate exactly as it does for a missing heading, so a write that
   * trusted it would INSERT a further copy on every run, and a clear would
   * report success having removed nothing.
   */
  ambiguous: boolean;
  /**
   * How many `## History` anchors the document carries — the heading a FIRST
   * `## Next` write splices the section in above. Consulted only on that insert
   * (a replace or a clear targets `## Next` itself), and reported as `1`
   * whenever no insert can follow.
   *
   * A COUNT rather than a boolean because zero and several are different faults
   * with opposite repairs: norn refuses an ambiguous anchor as surely as a
   * missing one, but "add the heading" and "delete the duplicate" are contrary
   * instructions, and a refusal that conflates them sends the operator the wrong
   * way. Either state is degraded vault state `mimir doctor` reports as
   * `section-history-unreadable`; carrying the count here (it rides the same
   * read that proves the section absent) turns norn's opaque whole-batch refusal
   * into one that names the actual fault.
   */
  insertAnchors: number;
};

export type BodySectionStore = {
  readHistory: (stem: string) => Promise<HistoryEntry[]>;
  readAnnotations: (stem: string) => Promise<AnnotationView[]>;
  /**
   * A node's full description prose — the `## Task Description` body section,
   * authoritative since MMR-162 (ADR 0016 Refinement), sliced from the
   * document body. Trimmed; empty → null.
   */
  readDescription: (stem: string) => Promise<string | null>;
  /**
   * The `## Next` direction narrative WITH its heading presence (MMR-321) — the
   * read the write path takes before re-authoring the section, so it can tell an
   * absent heading from an empty one, spot a duplicate it must refuse, and
   * detect a no-op rewrite. The read facet goes through {@link readSections}
   * instead; this is the write-side probe.
   */
  readNext: (stem: string) => Promise<NextSection>;
  /**
   * Read several body-section facets in one round-trip (MMR-164, F6). A detail
   * `get` assembling `description` + `annotations` + `history` reads one node
   * document; fetches its `.body` **once** and slices each requested section,
   * versus one fetch per facet. Only the facets named in `want` are populated;
   * the single-facet `read*` methods are wrappers over this.
   */
  readSections: (stem: string, want: BodySectionFacets) => Promise<BodySections>;
  /**
   * The same facets across MANY stems in ONE backend round-trip (MMR-322) —
   * `readSections`' fan-out sibling, keyed back by `KEY-seq` stem (a project's
   * stem is its bare `KEY`).
   *
   * A separate method rather than a `Promise.all` over `readSections` because
   * the backend client serializes its calls: N per-stem reads are N sequential
   * IPC hops that no concurrency wrapper can overlap. `overview` composes
   * sections over up-to-20 tasks plus every live container, so the difference is
   * one hop versus ~25 on the session-boot hot path.
   *
   * A stem whose document doesn't resolve is simply absent from the map (never a
   * throw); callers treat absence as "no sections", exactly as `readSections`
   * yields empty facets for a missing document. Duplicate stems collapse.
   */
  readSectionsMany: (
    stems: readonly string[],
    want: BodySectionFacets,
  ) => Promise<Map<string, BodySections>>;
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
