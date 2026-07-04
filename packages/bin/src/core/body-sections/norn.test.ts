import { expect, test } from 'bun:test';

import type { NornClient } from '../../norn/client';
import { renderAnnotationRecord, renderHistoryRecord, renderNodeBody } from '../history-codec';
import { createNornBodySectionStore } from './norn';

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
