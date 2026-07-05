import { expect, test } from 'bun:test';

import type { NornClient } from '../../norn/client';
import { renderAnnotationRecord, renderHistoryRecord, renderNodeBody } from '../history-codec';
import { createNornBodySectionStore, readAllNodeDocs } from './norn';

/** A fake client whose `get` returns one document with the given `.body`. */
function clientWithBody(body: string | undefined): NornClient {
  return {
    get: (targets: string[], col?: string) => {
      expect(col).toBe('.body');
      expect(targets).toEqual(['MMR-9']);
      return Promise.resolve(body === undefined ? [] : [{ body, path: 'MMR/MMR-9.md' }]);
    },
  } as unknown as NornClient;
}

const HISTORY = {
  at: '2026-07-04T10:00:00.000Z',
  from: 'todo',
  kind: 'lifecycle',
  reason: 'shipped',
  to: 'done',
} as const;
const ANNOTATION = { content: 'a load-bearing note', createdAt: '2026-07-04T10:01:00.000Z' };

/** A realistic node body: the seeded shape with one record under each anchor. */
function nodeBody(): string {
  const base = renderNodeBody('a task');
  return base
    .replace('## History\n', `## History\n${renderHistoryRecord(HISTORY)}`)
    .replace('## Annotations\n', `## Annotations\n${renderAnnotationRecord(ANNOTATION)}`);
}

test('readHistory slices + parses the ## History section from the document body', async () => {
  const store = createNornBodySectionStore(clientWithBody(nodeBody()));
  expect(await store.readHistory(9, 'MMR-9')).toEqual([HISTORY]);
});

test('readAnnotations slices + parses the ## Annotations section from the document body', async () => {
  const store = createNornBodySectionStore(clientWithBody(nodeBody()));
  expect(await store.readAnnotations(9, 'MMR-9')).toEqual([ANNOTATION]);
});

test('a freshly-seeded node (empty sections) reads back as no records', async () => {
  const store = createNornBodySectionStore(clientWithBody(renderNodeBody('a task')));
  expect(await store.readHistory(9, 'MMR-9')).toEqual([]);
  expect(await store.readAnnotations(9, 'MMR-9')).toEqual([]);
});

test('a missing document (no records returned) reads back empty, not a throw', async () => {
  const store = createNornBodySectionStore(clientWithBody(undefined));
  expect(await store.readHistory(9, 'MMR-9')).toEqual([]);
  expect(await store.readAnnotations(9, 'MMR-9')).toEqual([]);
});

test('readSections fetches the document body once for all requested facets (MMR-164 F6)', async () => {
  // A detail `get` wanting description + annotations + history must cost ONE
  // `.body` fetch, not three — the whole point of the batched read.
  let gets = 0;
  const client = {
    get: (targets: string[], col?: string) => {
      gets += 1;
      expect(col).toBe('.body');
      expect(targets).toEqual(['MMR-9']);
      return Promise.resolve([{ body: nodeBody(), path: 'MMR/MMR-9.md' }]);
    },
  } as unknown as NornClient;
  const store = createNornBodySectionStore(client);
  const sections = await store.readSections(9, 'MMR-9', {
    annotations: true,
    description: true,
    history: true,
  });
  expect(gets).toBe(1);
  expect(sections.description).toBe('a task');
  expect(sections.annotations).toEqual([ANNOTATION]);
  expect(sections.history).toEqual([HISTORY]);
});

test('readSections populates only the requested facets (MMR-164)', async () => {
  const store = createNornBodySectionStore(clientWithBody(nodeBody()));
  const sections = await store.readSections(9, 'MMR-9', { history: true });
  expect(sections.history).toEqual([HISTORY]);
  expect(sections.annotations).toBeUndefined();
  expect(sections.description).toBeUndefined();
});

test('annotations sort by created-at, not document order (parity with SQLite)', async () => {
  // Two notes appended out of chronological order (a backfill / clock-skew shape)
  // must read back in created-at order, matching the SQLite `order by created_at`.
  const later = { content: 'later note', createdAt: '2026-07-04T12:00:00.000Z' };
  const earlier = { content: 'earlier note', createdAt: '2026-07-04T09:00:00.000Z' };
  const body = `## Annotations\n${renderAnnotationRecord(later)}${renderAnnotationRecord(earlier)}`;
  const store = createNornBodySectionStore(clientWithBody(body));
  expect(await store.readAnnotations(9, 'MMR-9')).toEqual([earlier, later]);
});

// ── readAllNodeDocs (MMR-166): the `mimir doctor` raw-body reader ─────────

/** A fake client whose `find` yields the doc paths and `get` their `.body`. */
function fakeVault(docs: { path: string; body: string }[]): NornClient {
  return {
    find: () => Promise.resolve(docs.map((d) => ({ path: d.path }))),
    get: (targets: string[], col?: string) => {
      expect(col).toBe('.body');
      return Promise.resolve(docs.filter((d) => targets.includes(d.path)));
    },
  } as unknown as NornClient;
}

test('readAllNodeDocs returns every doc as { stem, body }, stem stripped of dir + .md', async () => {
  const docs = await readAllNodeDocs(
    fakeVault([
      { body: nodeBody(), path: 'MMR/MMR-9.md' },
      { body: renderNodeBody('a project'), path: 'MMR/MMR.md' },
    ]),
  );
  expect(docs).toEqual([
    { body: nodeBody(), stem: 'MMR-9' },
    { body: renderNodeBody('a project'), stem: 'MMR' },
  ]);
});

test('readAllNodeDocs short-circuits an empty vault without calling get', async () => {
  const client = {
    find: () => Promise.resolve([]),
    get: () => {
      throw new Error('get must not be called for an empty vault');
    },
  } as unknown as NornClient;
  expect(await readAllNodeDocs(client)).toEqual([]);
});
