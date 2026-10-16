import type { SearchLink, SearchMatch, StatusWord } from '@mimir/contract';

import type { WireSearchHit } from '../api/types';

/**
 * The jump palette's reading of a search result (MMR-455): hits grouped by how
 * they matched, so the reason a record appears is visible, and title words
 * marked where they occur.
 */

export type HitGroup = { label: string; hits: WireSearchHit[] };

const GROUP_LABEL: Record<SearchMatch, string> = {
  description: 'Descriptions',
  id: 'Record',
  link: 'Linked',
  title: 'Titles',
};

const GROUP_ORDER: readonly SearchMatch[] = ['id', 'link', 'title', 'description'];

/** Hits grouped by match, in {@link GROUP_ORDER}; the search's ranking holds inside each group. */
export function groupHits(hits: readonly WireSearchHit[]): HitGroup[] {
  return GROUP_ORDER.map((match) => ({
    hits: hits.filter((h) => h.match === match),
    label: GROUP_LABEL[match],
  })).filter((group) => group.hits.length > 0);
}

/** What a linked record is to the record an ID query found, in reading words. */
export const LINK_LABEL: Record<SearchLink, string> = {
  artifact: 'artifact',
  attached: 'attached to',
  blocks: 'blocks',
  child: 'child',
  depends_on: 'depends on',
  downstream: 'downstream',
  parent: 'parent',
  spawned: 'spawned',
  upstream: 'upstream',
};

export type Segment = { text: string; mark: boolean };

/**
 * A title cut into plain and marked runs, marking every case-insensitive
 * occurrence of each whitespace-separated query word. A fuzzy hit whose words
 * never appear whole stays unmarked.
 */
export function highlightTerms(title: string, query: string): Segment[] {
  const terms = query.split(/\s+/).filter((t) => t !== '');
  if (terms.length === 0) {
    return [{ mark: false, text: title }];
  }
  const pattern = new RegExp(
    `(${terms.map((t) => t.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)).join('|')})`,
    'gi',
  );
  const marked = new Set(terms.map((t) => t.toLowerCase()));
  return title
    .split(pattern)
    .filter((text) => text !== '')
    .map((text) => ({ mark: marked.has(text.toLowerCase()), text }));
}

/**
 * The status dot a hit can honestly show from its stored lifecycle: work in
 * flight or finished. Open work's derived word (ready, blocked, awaiting) is
 * not computed by search, so it shows none.
 */
export function hitStatus(hit: Pick<WireSearchHit, 'lifecycle'>): StatusWord | undefined {
  switch (hit.lifecycle) {
    case 'in_progress':
    case 'under_review':
    case 'done':
    case 'abandoned': {
      return hit.lifecycle;
    }
    case 'resolved': {
      return 'done';
    }
    case 'rejected': {
      return 'abandoned';
    }
    default: {
      return undefined;
    }
  }
}
