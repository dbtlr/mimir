import type { TransitionView } from '@mimir/contract';

import type { NornClient } from '../../norn/client';
import { validation } from '../errors';
import { HISTORY_HEADING, parseHistorySection, sliceBodySection } from '../history-codec';
import { parseId } from '../ids';
import type { TransitionsFeed } from './store';

/** The document stem (basename without `.md`) — the node's `KEY-seq` identity. */
function stemOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.endsWith('.md') ? base.slice(0, -3) : base;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A `vault.get` record's `path` + `.body`; either absent reads empty. */
function pathAndBody(record: unknown): { path: string; body: string } | null {
  if (typeof record !== 'object' || record === null || !('path' in record)) {
    return null;
  }
  const path = str((record as { path: unknown }).path);
  if (path === null) {
    return null;
  }
  const body = 'body' in record ? str((record as { body: unknown }).body) : null;
  return { body: body ?? '', path };
}

/**
 * The transition entity token a document's `## History` entries belong to — a
 * project doc yields its `KEY` (from frontmatter), a node doc its `KEY-seq`
 * stem. `null` for a malformed doc (dropped, as the read path drops it).
 */
function entityToken(fm: Record<string, unknown> | undefined, path: string): string | null {
  if (fm !== undefined && str(fm.type) === 'project') {
    const key = str(fm.key);
    return key !== null && key !== '' ? key : null;
  }
  const stem = stemOf(path);
  return parseId(stem) === null ? null : stem;
}

/** One entry positioned in the merged feed: its view plus the sort key. */
type Positioned = { view: TransitionView; at: string; stem: string; idx: number };

const SEP = '|';

/** Encode a sort position into the opaque resume cursor. */
function encodeCursor(p: Positioned): string {
  return `${p.at}${SEP}${p.stem}${SEP}${String(p.idx)}`;
}

/** Decode a resume cursor; throws a validation error on a malformed token.
 * `rawIdx === ''` is rejected explicitly — `Number('')` is `0`, so a
 * trailing-separator cursor (`at|stem|`) would otherwise decode as `idx: 0`. */
function decodeCursor(since: string): { at: string; stem: string; idx: number } {
  const [at, stem, rawIdx, ...rest] = since.split(SEP);
  const idx = Number(rawIdx);
  if (
    at === undefined ||
    stem === undefined ||
    rawIdx === undefined ||
    rawIdx === '' ||
    rest.length > 0 ||
    !Number.isInteger(idx)
  ) {
    throw validation(`invalid cursor ${since}`, 'pass back a next_cursor you were given');
  }
  return { at, idx, stem };
}

/** Ascending compare on the `(at, stem, idx)` sort key. */
function cmp(a: Positioned, b: { at: string; stem: string; idx: number }): number {
  if (a.at !== b.at) {
    return a.at < b.at ? -1 : 1;
  }
  if (a.stem !== b.stem) {
    return a.stem < b.stem ? -1 : 1;
  }
  return a.idx - b.idx;
}

/**
 * The Norn transition feed — there is no global log, so every node/project
 * `## History` section is fanned out of the vault (one `find` for the doc set,
 * one bulk `.body` `get`), sliced, parsed, and merged into one chronologically
 * ordered stream keyed by `(at, stem, index)`.
 *
 * A markdown vault carries no global insertion sequence, so this `at`-primary
 * order is a best-effort *approximation* of the SQLite feed's `transition_log.id`
 * (true insertion) order — not a byte-for-byte match. They agree whenever `at`
 * is monotonic in insertion order (the normal case); they diverge when it is
 * not (a clock step-back, a backfilled/imported transition, a hand-edited
 * `## History`), both across nodes on an equal `at` and within one node on a
 * non-monotonic `at`. For the same reason the `(at, stem, index)` resume cursor
 * is not a true monotonic sequence: a transition appended after a cursor was
 * issued but stamped with an earlier `at` sorts before it and is skipped, where
 * SQLite's `id > since` would still deliver it. These are inherent limits of the
 * markdown backend, tracked for the Phase-4 cutover (MMR-160 follow-up); the A/B
 * parity harness therefore compares the two feeds as a *set*, not by page order.
 */
export function createNornTransitionsFeed(client: NornClient): TransitionsFeed {
  return {
    list: async (opts = {}) => {
      if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
        throw validation(`invalid limit ${String(opts.limit)}`);
      }
      // An absent OR empty `since` reads from the start — the SQLite feed accepts
      // `''` (its `Number('') === 0`), so both backends agree on an empty cursor.
      const after =
        opts.since === undefined || opts.since === '' ? undefined : decodeCursor(opts.since);

      const docs = await client.find({
        in: ['type:project,task,phase,initiative'],
        no_limit: true,
      });
      const tokenByPath = new Map<string, string>();
      for (const doc of docs) {
        const token = entityToken(doc.frontmatter, doc.path);
        if (token !== null) {
          tokenByPath.set(doc.path, token);
        }
      }
      // `vault.get` is never called with an empty target list (an empty or
      // all-malformed vault) — its behavior there is unverified, so short-circuit.
      if (tokenByPath.size === 0) {
        return { items: [] };
      }

      const records = await client.get([...tokenByPath.keys()], '.body');
      const positioned: Positioned[] = [];
      for (const record of records) {
        const pb = pathAndBody(record);
        const token = pb === null ? undefined : tokenByPath.get(pb.path);
        if (pb === null || token === undefined) {
          continue;
        }
        const history = parseHistorySection(sliceBodySection(pb.body, HISTORY_HEADING));
        history.forEach((e, idx) => {
          positioned.push({
            at: e.at,
            idx,
            stem: stemOf(pb.path),
            view: { at: e.at, from: e.from, kind: e.kind, node: token, reason: e.reason, to: e.to },
          });
        });
      }

      positioned.sort((a, b) => cmp(a, b));
      const start = after === undefined ? positioned : positioned.filter((p) => cmp(p, after) > 0);
      const page = opts.limit === undefined ? start : start.slice(0, opts.limit);
      const last = page.at(-1);
      const items = page.map((p) => p.view);
      return last === undefined ? { items } : { items, nextCursor: encodeCursor(last) };
    },
  };
}
