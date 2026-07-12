import type { TransitionView } from '@mimir/contract';

import type { NornClient } from '../../norn/client';
import { pathAndSections, stemOf } from '../../norn/decode';
import { validation } from '../errors';
import { HISTORY_HEADING, parseHistorySection, sectionBody } from '../history-codec';
import { vaultGraphFromDocs } from '../store-norn';
import { validate } from '../validate';
import type { TransitionsFeed } from './store';

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * The transition entity token a document's `## History` entries belong to — a
 * project doc yields its `KEY` (from frontmatter), a node doc its `KEY-seq`
 * stem. A project is never dropped by the validator, so its `KEY` always
 * surfaces (parity with the reader, which shows every project doc). A node's
 * stem yields `null` unless it is a validator SURVIVOR, so the feed shows a
 * node's transitions iff the working-set reader shows the node (ADR 0017,
 * MMR-189): a NODE drop (missing project, invalid `lifecycle`/`hold`, absent/
 * unparseable frontmatter) yields `null`; a CYCLE drop is edge-only — the node
 * survives, so its stem is in `surviving` and its transitions still surface.
 */
function entityToken(
  fm: Record<string, unknown> | undefined,
  path: string,
  surviving: ReadonlySet<string>,
): string | null {
  if (fm !== undefined && str(fm.type) === 'project') {
    const key = str(fm.key);
    return key !== null && key !== '' ? key : null;
  }
  const stem = stemOf(path);
  return surviving.has(stem) ? stem : null;
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
 * one bulk `vault.get { section: ['History'] }`), parsed, and merged into one
 * chronologically ordered stream keyed by `(at, stem, index)`.
 *
 * A markdown vault carries no global insertion sequence, so this `at`-primary
 * order is a best-effort *approximation* of true insertion order — not a
 * byte-for-byte match. It agrees with insertion order whenever `at` is
 * monotonic (the normal case); it diverges when it is not (a clock step-back,
 * a backfilled/imported transition, a hand-edited `## History`), both across
 * nodes on an equal `at` and within one node on a non-monotonic `at`. For the
 * same reason the `(at, stem, index)` resume cursor is not a true monotonic
 * sequence: a transition appended after a cursor was issued but stamped with
 * an earlier `at` sorts before it and is skipped. These are inherent limits of
 * the markdown backend (MMR-160 follow-up), tracked as MMR-168.
 */
export function createNornTransitionsFeed(client: NornClient): TransitionsFeed {
  return {
    list: async (opts = {}) => {
      if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
        throw validation(`invalid limit ${String(opts.limit)}`);
      }
      // An absent OR empty `since` reads from the start (`Number('') === 0`).
      const after =
        opts.since === undefined || opts.since === '' ? undefined : decodeCursor(opts.since);

      const docs = await client.find({
        in: ['type:project,task,phase,initiative'],
        no_limit: true,
      });
      // Derive the surviving node stems from this SAME snapshot via the shared
      // validator the working-set reader uses (`vaultGraphFromDocs` is the pure
      // core of `readVaultGraph`) — one find, no second scan and no A/B snapshot
      // skew, no drop rules re-implemented here (ADR 0017, MMR-189). A cycle
      // drop is edge-only, so its node stays in `nodes` and still surfaces.
      const surviving = new Set(validate(vaultGraphFromDocs(docs)).nodes.map((n) => n.stem));
      const tokenByPath = new Map<string, string>();
      for (const doc of docs) {
        const token = entityToken(doc.frontmatter, doc.path, surviving);
        if (token !== null) {
          tokenByPath.set(doc.path, token);
        }
      }
      // `vault.get` is never called with an empty target list (an empty or
      // all-malformed vault) — its behavior there is unverified, so short-circuit.
      if (tokenByPath.size === 0) {
        return { items: [] };
      }

      const records = await client.getSections([...tokenByPath.keys()], [HISTORY_HEADING]);
      const positioned: Positioned[] = [];
      for (const record of records) {
        const ps = pathAndSections(record);
        const token = ps === null ? undefined : tokenByPath.get(ps.path);
        if (ps === null || token === undefined) {
          continue;
        }
        const history = parseHistorySection(sectionBody(ps.sections[HISTORY_HEADING] ?? ''));
        history.forEach((e, idx) => {
          positioned.push({
            at: e.at,
            idx,
            stem: stemOf(ps.path),
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
