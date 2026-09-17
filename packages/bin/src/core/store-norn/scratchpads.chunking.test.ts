import { expect, test } from 'bun:test';

import type { Scratchpad } from '@mimir/contract';

import { CappedNornClient } from '../../testing/capped-norn';
import { createNornScratchpadStore, scratchpadDocument } from './scratchpads';

const AT = '2026-08-03T12:00:00.000Z';

const pads: Scratchpad[] = Array.from({ length: 18 }, (_, index) => ({
  agenda: [{ content: 'Open question', number: 1, reason: null, state: 'open' }],
  anchors: [],
  createdAt: AT,
  freezingAt: index === 0 ? AT : null,
  id: `123e4567-e89b-42d3-a456-${String(index).padStart(12, '0')}`,
  journal: [{ at: AT, content: `${index}: ${'é'.repeat(64 * 1024)}`, number: 1 }],
  project: index === 0 ? 'OTH' : 'MMR',
  title: `Pad ${index}`,
  updatedAt: index === 17 ? '2026-08-03T12:05:00.000Z' : AT,
}));

const docs = [
  { frontmatter: { key: 'MMR', type: 'project' }, path: 'MMR/MMR.md' },
  { frontmatter: { key: 'OTH', type: 'project' }, path: 'OTH/OTH.md' },
  ...pads.map(scratchpadDocument).toReversed(),
  {
    body: 'not a scratchpad',
    frontmatter: {
      created: AT,
      project: '[[MMR]]',
      title: 'Corrupt',
      type: 'scratch',
      updated_at: AT,
    },
    path: 'scratch/123e4567-e89b-42d3-a456-999999999999.md',
  },
];

test('scratchpad listing preserves complete journals, filtering, quarantine, and ordering under the response cap', async () => {
  const client = new CappedNornClient(docs, 200_000);
  const store = createNornScratchpadStore(client, '/test/vault');
  expect(await store.list('MMR')).toEqual([...pads.slice(17), ...pads.slice(1, 17)]);
  expect(client.reads.flat()).not.toContain(`scratch/${pads[0]?.id}.md`);
  expect(await store.list()).toEqual([...pads.slice(17), ...pads.slice(0, 17)]);
  expect(client.rejected).toContain('get');
  expect(client.finds.every((args) => !args.col?.includes('.body'))).toBe(true);
});

test('scratchpad listing names an oversized pad and skips body requests when no pads match', async () => {
  const client = new CappedNornClient(docs, 10_000);
  const store = createNornScratchpadStore(client, '/test/vault');
  expect(await store.list('NONE')).toEqual([]);
  expect(client.reads).toEqual([]);
  expect(await store.list('OTH').catch((error: unknown) => error)).toMatchObject({
    message: `scratch/${pads[0]?.id}.md is too large for the norn transport to return`,
  });
});

test('scratchpad listing reapplies the project filter when ownership changes after enumeration', async () => {
  const original = pads[1];
  if (original === undefined) {
    throw new Error('missing scratchpad fixture');
  }
  const changed = scratchpadDocument({ ...original, project: 'OTH' });
  class ChangedClient extends CappedNornClient {
    override get(targets: string[], col?: string): Promise<unknown[]> {
      return new CappedNornClient([changed], 200_000).get(targets, col);
    }
  }
  const client = new ChangedClient(
    [
      { frontmatter: { key: 'MMR', type: 'project' }, path: 'MMR/MMR.md' },
      { frontmatter: { key: 'OTH', type: 'project' }, path: 'OTH/OTH.md' },
      scratchpadDocument(original),
    ],
    200_000,
  );
  expect(await createNornScratchpadStore(client, '/test/vault').list('MMR')).toEqual([]);
});
