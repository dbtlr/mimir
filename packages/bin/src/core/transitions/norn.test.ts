import { expect, test } from 'bun:test';

import type { HistoryEntry } from '@mimir/contract';

import type { NornClient } from '../../norn/client';
import { renderHistoryRecord } from '../history-codec';
import { createNornTransitionsFeed } from './norn';

type Doc = { path: string; fm?: Record<string, unknown>; history: HistoryEntry[] };

/** A fake client backing the feed: `find` yields the doc set, `get` their bodies. */
function fakeClient(docs: Doc[]): NornClient {
  return {
    find: () => Promise.resolve(docs.map((d) => ({ frontmatter: d.fm, path: d.path }))),
    get: (targets: string[], col?: string) => {
      expect(col).toBe('.body');
      return Promise.resolve(
        docs
          .filter((d) => targets.includes(d.path))
          .map((d) => ({
            body: `## History\n${d.history.map((h) => renderHistoryRecord(h)).join('')}`,
            path: d.path,
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

test('merges every node/project ## History into one at-ordered stream', async () => {
  const feed = createNornTransitionsFeed(
    fakeClient([
      { history: [entry('2026-07-04T10:00:00.000Z', 'a')], path: 'MMR/MMR-3.md' },
      { history: [entry('2026-07-04T09:00:00.000Z', 'b')], path: 'MMR/MMR-4.md' },
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
    { at: '2026-07-04T08:00:00.000Z', from: null, kind: 'lifecycle', node: 'MMR', reason: null, to: 'archived' },
  ]);
});

test('the cursor resumes strictly after the last returned entry', async () => {
  const feed = createNornTransitionsFeed(
    fakeClient([
      {
        history: [entry('2026-07-04T09:00:00.000Z', 'a'), entry('2026-07-04T10:00:00.000Z', 'b')],
        path: 'MMR/MMR-3.md',
      },
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

test('a bad cursor and a bad limit are rejected', async () => {
  const feed = createNornTransitionsFeed(fakeClient([]));
  expect(feed.list({ since: 'not-a-cursor' })).rejects.toThrow(/cursor/);
  expect(feed.list({ limit: 0 })).rejects.toThrow(/limit/);
});
