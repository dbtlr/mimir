import type { SearchHit, SetResult } from '@mimir/contract';

import { projectNotFound, validation } from '../errors';
import { markdownToPlainText } from '../seeds/lede';
import type { Store } from '../store';
import type { SearchStore, SuffixClass, TextHit } from './store';

/**
 * Cross-record search (MMR-447): one query over tasks, containers, projects,
 * seeds, and artifacts, built first as the jump tool behind the console's
 * palette.
 *
 * An ID-like query — a full ID in any case (`mmr-417`, `MMR-s41`), a bare key
 * (`mmr`), or a bare suffix (`417`, `s41`, `a219`) — finds that record and up
 * to {@link LINK_CAP} records linked to it, newest first. With no current
 * project, a bare suffix lists every active project's record with that suffix.
 * An ID-like query that names nothing falls back to text search: titles that
 * contain every term, then descriptions that hold every word as a whole word.
 * When neither finds anything, titles that hold every term as a subsequence
 * are the fuzzy fallback, so an abbreviation or a typo still finds its record.
 */

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 100;
const LINK_CAP = 8;
const SNIPPET_RADIUS = 60;

export type SearchOptions = {
  query: string;
  /** The current project: ranked first, and where a bare suffix resolves. */
  project?: string;
  /** Text hits come only from `project`; a full ID still finds any project. */
  projectOnly?: boolean;
  limit?: number;
};

const FULL_ID = /^([a-z]{2,4})-([as]?)(\d+)$/i;
const BARE_KEY = /^[a-z]{2,4}$/i;
const BARE_SUFFIX = /^([as]?)(\d+)$/i;

/** The largest sequence a store holds (a 32-bit `integer` column on Postgres). */
const MAX_SEQ = 2_147_483_647;

const SUFFIX_CLASS: Record<string, SuffixClass> = { '': 'node', a: 'artifact', s: 'seed' };

export async function searchRecords(
  store: Store,
  opts: SearchOptions,
): Promise<SetResult<SearchHit>> {
  const query = opts.query.trim();
  if (query === '') {
    throw validation('search needs a query');
  }
  const limit = opts.limit ?? DEFAULT_SEARCH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
    throw validation(`limit must be a whole number from 1 to ${String(MAX_SEARCH_LIMIT)}`);
  }
  if (opts.projectOnly === true && opts.project === undefined) {
    throw validation('a project-only search needs a project');
  }
  if (
    opts.project !== undefined &&
    !(await store.loadProjects()).some((project) => project.key === opts.project)
  ) {
    throw projectNotFound(opts.project);
  }
  const byId = await idHits(store.search, query, opts.project);
  if (byId !== undefined) {
    const items = byId.slice(0, limit);
    return { items, returned: items.length, startsAt: 0, total: byId.length };
  }
  return textHits(store.search, query, opts.project, opts.projectOnly === true, limit);
}

/** The hits an ID-like query names, or `undefined` when it names nothing. */
async function idHits(
  search: SearchStore,
  query: string,
  project: string | undefined,
): Promise<SearchHit[] | undefined> {
  const full = FULL_ID.exec(query);
  if (full !== null) {
    const [, key = '', prefix = '', seq = ''] = full;
    return withLinks(search, renderSuffix(key.toUpperCase(), prefix, seq));
  }
  if (BARE_KEY.test(query)) {
    return withLinks(search, query.toUpperCase());
  }
  const bare = BARE_SUFFIX.exec(query);
  if (bare === null) {
    return undefined;
  }
  const [, prefix = '', seq = ''] = bare;
  if (Number(seq) > MAX_SEQ) {
    return undefined;
  }
  if (project !== undefined) {
    return withLinks(search, renderSuffix(project, prefix, seq));
  }
  const records = await search.bySuffix({
    class: SUFFIX_CLASS[prefix.toLowerCase()] ?? 'node',
    seq: Number(seq),
  });
  return records.length === 0
    ? undefined
    : records.map((record) => Object.assign(record, { match: 'id' as const }));
}

/** `KEY` + `a`/`s`/`` + digits → the rendered id (`MMR-a219`); leading zeros drop. */
function renderSuffix(key: string, prefix: string, seq: string): string {
  return `${key}-${prefix.toLowerCase()}${String(Number(seq))}`;
}

/** The record an ID names, then its links newest first; `undefined` when it names nothing. */
async function withLinks(search: SearchStore, id: string): Promise<SearchHit[] | undefined> {
  const [record] = await search.records([id]);
  if (record === undefined) {
    return undefined;
  }
  const links = await search.links(id);
  const linked = new Map(
    (await search.records(links.map((link) => link.id))).map((r) => [r.id, r]),
  );
  const hits: SearchHit[] = [];
  for (const { id: linkedId, link } of links) {
    const found = linked.get(linkedId);
    if (found !== undefined) {
      hits.push({ ...found, link, match: 'link' });
    }
  }
  const newestFirst = hits.toSorted(
    (a, b) => compareText(b.updatedAt, a.updatedAt) || compareText(a.id, b.id),
  );
  return [{ ...record, match: 'id' }, ...newestFirst.slice(0, LINK_CAP)];
}

async function textHits(
  search: SearchStore,
  query: string,
  project: string | undefined,
  projectOnly: boolean,
  limit: number,
): Promise<SetResult<SearchHit>> {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== '');
  // Description words are ASCII alphanumeric runs. A term holding any other
  // letter is left out whole: `résumé` split into `r` and `sum` would find
  // descriptions it never named.
  const words = terms
    .filter((term) => /^[ -~]+$/.test(term))
    .flatMap((term) => term.match(/[a-z0-9]+/g) ?? []);
  const result = await search.text({
    limit,
    terms,
    words,
    ...(project === undefined ? {} : { project, projectOnly }),
  });
  const items = result.items.map((hit) => toTextHit(hit, words));
  return { items, returned: items.length, startsAt: 0, total: result.total };
}

function toTextHit(hit: TextHit, words: readonly string[]): SearchHit {
  const { description, tier, ...record } = hit;
  if (tier !== 3) {
    return { ...record, match: 'title' };
  }
  return { ...record, match: 'description', snippet: snippet(description ?? '', words) };
}

/**
 * Plain text around the first matched word, at most about twice
 * {@link SNIPPET_RADIUS} characters, cut between words where a space allows and
 * marked by an ellipsis. The
 * markup is stripped first, so a word the database found inside markup (a link
 * target, a code block) may not appear: the snippet then starts the text.
 */
export function snippet(description: string, words: readonly string[]): string {
  const text = markdownToPlainText(description).replaceAll(/\s+/g, ' ').trim();
  const at = words
    .map((word) => new RegExp(`(?:^|[^a-z0-9])(${word})(?:[^a-z0-9]|$)`, 'i').exec(text))
    .filter((match) => match !== null)
    .map((match) => match.index + match[0].indexOf(match[1] ?? ''))
    .reduce((first, index) => Math.min(first, index), Number.POSITIVE_INFINITY);
  const centre = Number.isFinite(at) ? at : 0;
  // Each cut moves inward to the nearest space, so no word is shown in part.
  let start = Math.max(0, centre - SNIPPET_RADIUS);
  if (start > 0 && text[start - 1] !== ' ') {
    const space = text.indexOf(' ', start);
    start = space === -1 || space >= centre ? centre : space + 1;
  }
  let end = Math.min(text.length, centre + SNIPPET_RADIUS);
  if (end < text.length && text[end] !== ' ') {
    const space = text.lastIndexOf(' ', end);
    end = space > centre ? space : end;
  }
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}
