import { expect, test } from 'bun:test';

import type { HistoryEntry } from '@mimir/contract';

import type { NornClient } from '../../norn/client';
import { renderHistoryRecord } from '../history-codec';
import { createNornTransitionsFeed } from './norn';

type Doc = { path: string; fm?: Record<string, unknown>; history: HistoryEntry[] };

/** A fake client backing the feed: `find` yields the doc set, `getSections` their
 * `## History` sections (the heading line included, as norn returns it). */
function fakeClient(docs: Doc[]): NornClient {
  return {
    find: () => Promise.resolve(docs.map((d) => ({ frontmatter: d.fm, path: d.path }))),
    getSections: (targets: string[], headings: string[]) => {
      expect(headings).toEqual(['History']);
      return Promise.resolve(
        docs
          .filter((d) => targets.includes(d.path))
          .map((d) => ({
            path: d.path,
            sections: {
              History: `## History\n${d.history.map((h) => renderHistoryRecord(h)).join('')}`,
            },
          })),
      );
    },
  } as unknown as NornClient;
}

const entry = (at: string, to: string): HistoryEntry => ({
  at,
  from: null,
  kind: 'lifecycle',
  reason: null,
  to,
});

/** A surviving project doc (present `key`) so its node children clear the
 * missing-project drop; empty history contributes no feed entries of its own. */
const projectDoc = (key: string): Doc => ({
  fm: { key, type: 'project' },
  history: [],
  path: `${key}/${key}.md`,
});

/** A valid node doc (a `task` with a legal `lifecycle`) — the validator keeps it,
 * so its `## History` surfaces. Override `fm` to model a node the validator drops. */
const nodeDoc = (
  stem: string,
  history: HistoryEntry[],
  fm: Record<string, unknown> = { lifecycle: 'todo', type: 'task' },
): Doc => ({ fm, history, path: `MMR/${stem}.md` });

test('merges every node/project ## History into one at-ordered stream', async () => {
  const feed = createNornTransitionsFeed(
    fakeClient([
      projectDoc('MMR'),
      nodeDoc('MMR-3', [entry('2026-07-04T10:00:00.000Z', 'a')]),
      nodeDoc('MMR-4', [entry('2026-07-04T09:00:00.000Z', 'b')]),
    ]),
  );
  const { items } = await feed.list();
  expect(items.map((i) => [i.node, i.to])).toEqual([
    ['MMR-4', 'b'],
    ['MMR-3', 'a'],
  ]);
});

test('a project doc renders its KEY as the transition entity', async () => {
  const feed = createNornTransitionsFeed(
    fakeClient([
      {
        fm: { key: 'MMR', type: 'project' },
        history: [entry('2026-07-04T08:00:00.000Z', 'archived')],
        path: 'MMR/MMR.md',
      },
    ]),
  );
  const { items } = await feed.list();
  expect(items).toEqual([
    {
      at: '2026-07-04T08:00:00.000Z',
      from: null,
      kind: 'lifecycle',
      node: 'MMR',
      reason: null,
      to: 'archived',
    },
  ]);
});

test('colliding project documents withhold every ambiguous project history', async () => {
  const collisionHistory = [entry('2026-07-04T08:00:00.000Z', 'archived')];
  const feed = createNornTransitionsFeed(
    fakeClient([
      { fm: { key: 'MMR', type: 'project' }, history: collisionHistory, path: 'a/MMR.md' },
      { fm: { key: 'MMR', type: 'project' }, history: collisionHistory, path: 'b/MMR.md' },
    ]),
  );

  expect((await feed.list()).items).toEqual([]);
});

test('the cursor resumes strictly after the last returned entry', async () => {
  const feed = createNornTransitionsFeed(
    fakeClient([
      projectDoc('MMR'),
      nodeDoc('MMR-3', [
        entry('2026-07-04T09:00:00.000Z', 'a'),
        entry('2026-07-04T10:00:00.000Z', 'b'),
      ]),
    ]),
  );
  const first = await feed.list({ limit: 1 });
  expect(first.items.map((i) => i.to)).toEqual(['a']);
  expect(first.nextCursor).toBeDefined();
  const second = await feed.list({ since: first.nextCursor });
  expect(second.items.map((i) => i.to)).toEqual(['b']);
  const drained = await feed.list({ since: second.nextCursor });
  expect(drained.items).toEqual([]);
  expect(drained.nextCursor).toBeUndefined();
});

test('a malformed (non-KEY-seq, non-project) doc is dropped', async () => {
  const feed = createNornTransitionsFeed(
    fakeClient([{ history: [entry('2026-07-04T10:00:00.000Z', 'a')], path: 'MMR/notes.md' }]),
  );
  expect((await feed.list()).items).toEqual([]);
});

test('a node whose project is absent surfaces no transitions (validator drop)', async () => {
  // No `projectDoc('MMR')` → the node is dropped by the missing-project rule, so
  // its `## History` must not appear (parity with the reader's dropped node).
  const feed = createNornTransitionsFeed(
    fakeClient([nodeDoc('MMR-3', [entry('2026-07-04T10:00:00.000Z', 'a')])]),
  );
  expect((await feed.list()).items).toEqual([]);
});

test('a node with an invalid lifecycle surfaces no transitions (validator drop)', async () => {
  // Project present, but the task's `lifecycle` is foreign → an invalid-lifecycle
  // node drop, so the feed excludes it exactly as the reader hides it.
  const feed = createNornTransitionsFeed(
    fakeClient([
      projectDoc('MMR'),
      nodeDoc('MMR-3', [entry('2026-07-04T10:00:00.000Z', 'a')], {
        lifecycle: 'bogus',
        type: 'task',
      }),
    ]),
  );
  expect((await feed.list()).items).toEqual([]);
});

test('a cycle-affected node (edge drop, node survives) still surfaces its transitions', async () => {
  // MMR-3 ⇄ MMR-4 is a depends_on cycle: the validator drops a back EDGE but keeps
  // both NODES, so both nodes' transitions must still appear.
  const feed = createNornTransitionsFeed(
    fakeClient([
      projectDoc('MMR'),
      nodeDoc('MMR-3', [entry('2026-07-04T10:00:00.000Z', 'a')], {
        depends_on: ['MMR-4'],
        lifecycle: 'todo',
        type: 'task',
      }),
      nodeDoc('MMR-4', [entry('2026-07-04T09:00:00.000Z', 'b')], {
        depends_on: ['MMR-3'],
        lifecycle: 'todo',
        type: 'task',
      }),
    ]),
  );
  const { items } = await feed.list();
  expect(items.map((i) => [i.node, i.to])).toEqual([
    ['MMR-4', 'b'],
    ['MMR-3', 'a'],
  ]);
});

test('a bad cursor and a bad limit are rejected', async () => {
  const feed = createNornTransitionsFeed(fakeClient([]));
  expect(feed.list({ since: 'not-a-cursor' })).rejects.toThrow(/cursor/);
  expect(feed.list({ limit: 0 })).rejects.toThrow(/limit/);
});

test('a trailing-separator cursor (empty idx) is rejected, not decoded as idx 0', async () => {
  const feed = createNornTransitionsFeed(fakeClient([]));
  // `2026-07-04T10:00:00.000Z|MMR-3|`.split('|') → [..., ''] and Number('') === 0,
  // which would silently resume from position 0 without the explicit reject.
  expect(feed.list({ since: '2026-07-04T10:00:00.000Z|MMR-3|' })).rejects.toThrow(/cursor/);
});

test('an empty `since` reads from the start', async () => {
  const feed = createNornTransitionsFeed(
    fakeClient([projectDoc('MMR'), nodeDoc('MMR-3', [entry('2026-07-04T10:00:00.000Z', 'a')])]),
  );
  expect((await feed.list({ since: '' })).items.map((i) => i.to)).toEqual(['a']);
});

test('an empty vault returns no items without calling get([]) with empty targets', async () => {
  let getCalledWith: string[] | undefined;
  const client = {
    find: () => Promise.resolve([]),
    get: (targets: string[]) => {
      getCalledWith = targets;
      return Promise.resolve([]);
    },
  } as unknown as NornClient;
  const feed = createNornTransitionsFeed(client);
  expect(await feed.list()).toEqual({ items: [] });
  expect(getCalledWith).toBeUndefined(); // guarded — get is never called with []
});
