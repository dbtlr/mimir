import type { SearchHit, SearchLink } from '@mimir/contract';

/**
 * The search slice of the store seam (MMR-447) — the database does the
 * matching, ranking, and limiting, so a search never loads the store into the
 * process. Every read sees active projects only: an archived project's records
 * are never found.
 */

/** A searchable record as the store reads it — a hit before it knows how it matched. */
export type SearchRecord = Omit<SearchHit, 'match' | 'link' | 'snippet'>;

/**
 * A text search. Matching folds case with the database's own `lower()`, which
 * on SQLite folds ASCII letters only: there a title's non-ASCII capitals (`É`)
 * match only a query typed the same way. `terms` are the query's lowercased
 * whitespace-separated tokens, matched against titles; `words` are its lowercased ASCII
 * alphanumeric runs, matched as whole words against descriptions (an
 * artifact's summary). `project` is ranked first when given.
 */
export type TextSearch = {
  terms: readonly string[];
  words: readonly string[];
  project?: string;
  limit: number;
};

/**
 * How a text hit matched: the title contains every term (1), the title holds
 * every term as a subsequence (2), the description holds every word as a whole
 * word (3). Tiers 1 and 3 are the precise hits, ranked 1 before 3; tier 2 is
 * the fuzzy fallback, found only when there is no precise hit.
 */
export type MatchTier = 1 | 2 | 3;

/** A text hit, with the description a tier-3 hit's snippet is cut from. */
export type TextHit = SearchRecord & { tier: MatchTier; description: string | null };

/** The ID classes a bare suffix names: `417` a node, `s41` a seed, `a219` an artifact. */
export type SuffixClass = 'node' | 'seed' | 'artifact';

export type SearchStore = {
  /**
   * Ranked text hits: the precise tiers, or the fuzzy tier when they find
   * nothing; then `project` first, open before finished, and most recently
   * updated. `total` counts every hit, not just the `limit` returned.
   */
  text: (query: TextSearch) => Promise<{ total: number; items: TextHit[] }>;
  /** The named records (any kind, by rendered id), in no particular order. */
  records: (ids: readonly string[]) => Promise<SearchRecord[]>;
  /** Every record of the class carrying this sequence number, project-key ordered. */
  bySuffix: (suffix: { class: SuffixClass; seq: number }) => Promise<SearchRecord[]>;
  /**
   * The ids directly linked to one record, labelled by what each is to it.
   * A record linked twice keeps its first label in {@link SearchLink} order.
   */
  links: (id: string) => Promise<{ id: string; link: SearchLink }[]>;
};
