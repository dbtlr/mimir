import { expect, test } from 'bun:test';

import type { NornDocument } from '../../core/store-norn/client';
import { CappedNornClient } from '../../testing/capped-norn';
import { readDoctorSnapshot } from './snapshot';

const documents: NornDocument[] = [
  {
    body: '',
    document_hash: 'project-hash',
    frontmatter: { key: 'MMR', type: 'project' },
    path: 'MMR/MMR.md',
  },
  ...Array.from({ length: 18 }, (_, index) => ({
    body: `## History\n${'é'.repeat(64 * 1024)}\n## Annotations\n`,
    document_hash: `node-${index}`,
    frontmatter: { hold: 'none', lifecycle: 'todo', project: '[[MMR]]', type: 'task' },
    path: `MMR/MMR-${index + 1}.md`,
  })),
  ...Array.from({ length: 18 }, (_, index) => ({
    body: `## Journal\n${'x'.repeat(128 * 1024)}\n## Agenda\n`,
    document_hash: `scratch-${index}`,
    frontmatter: { project: '[[MMR]]', type: 'scratch' },
    path: `scratch/pad-${index}.md`,
  })),
  {
    body: 'not read'.repeat(100_000),
    frontmatter: { type: 'artifact' },
    path: 'MMR/artifacts/MMR-a1.md',
  },
];

test('doctor reads all large documents and section diagnostics through a capped client', async () => {
  const client = new CappedNornClient(documents, 200_000);
  const snapshot = await readDoctorSnapshot(client);
  expect(snapshot.documents).toHaveLength(19);
  expect(snapshot.scratchpads).toHaveLength(18);
  for (const doc of [...snapshot.documents, ...(snapshot.scratchpads ?? [])]) {
    const original = documents.find((candidate) => candidate.path === doc.path);
    expect(original?.body).toBe(doc.body);
    expect(doc.frontmatter).toEqual(original?.frontmatter);
    expect(original?.document_hash).toBe(doc.documentHash);
  }
  expect(snapshot.graph.nodes).toHaveLength(18);
  expect(snapshot.artifacts).toEqual([
    { frontmatter: { type: 'artifact' }, path: 'MMR/artifacts/MMR-a1.md', stem: 'MMR-a1' },
  ]);
  expect(snapshot.sectionFailures).toEqual([
    { path: 'MMR/MMR.md', section: 'History', stem: 'MMR' },
  ]);
  expect(client.rejected).toContain('get');
  expect(client.rejected).toContain('sections');
  expect(client.finds.every((args) => !args.col?.includes('.body'))).toBe(true);
});

test('doctor keeps body, frontmatter, and hash from the same retrieval despite enumeration drift and reordered results', async () => {
  const before = {
    body: 'old',
    document_hash: 'old-hash',
    frontmatter: { key: 'OLD', type: 'project' },
    path: 'MMR/MMR.md',
  };
  const after = {
    body: '## History\nnew',
    document_hash: 'new-hash',
    frontmatter: { key: 'MMR', type: 'project' },
    path: before.path,
  };
  class ChangedClient extends CappedNornClient {
    override get(targets: string[], col?: string): Promise<unknown[]> {
      return new CappedNornClient(
        [{ body: '', document_hash: 'empty-hash', path: 'MMR/MMR-1.md' }, after],
        10_000,
      ).get(targets, col);
    }
  }
  const snapshot = await readDoctorSnapshot(
    new ChangedClient(
      [before, { body: 'stale', frontmatter: { type: 'task' }, path: 'MMR/MMR-1.md' }],
      10_000,
    ),
  );
  expect(snapshot.documents).toEqual([
    {
      body: after.body,
      documentHash: after.document_hash,
      frontmatter: after.frontmatter,
      path: before.path,
      stem: 'MMR',
    },
    { body: '', documentHash: 'empty-hash', path: 'MMR/MMR-1.md', stem: 'MMR-1' },
  ]);
  expect(snapshot.graph.projectKeys).toEqual(['MMR']);
});

test('doctor refuses an incomplete document read instead of returning partial diagnostics', async () => {
  class MissingClient extends CappedNornClient {
    override get(): Promise<unknown[]> {
      return Promise.resolve([]);
    }
  }
  expect(
    await readDoctorSnapshot(
      new MissingClient(
        [{ body: '', frontmatter: { key: 'MMR', type: 'project' }, path: 'MMR/MMR.md' }],
        10_000,
      ),
    ).catch((error: unknown) => error),
  ).toMatchObject({ message: 'MMR/MMR.md could not be read' });
});

test('doctor names a single document that exceeds the response cap', async () => {
  expect(
    await readDoctorSnapshot(
      new CappedNornClient(
        [
          {
            body: 'x'.repeat(2000),
            frontmatter: { key: 'MMR', type: 'project' },
            path: 'MMR/MMR.md',
          },
        ],
        1000,
      ),
    ).catch((error: unknown) => error),
  ).toMatchObject({ message: 'MMR/MMR.md is too large for the norn transport to return' });
});

test('doctor propagates other read failures without splitting or returning a partial result', async () => {
  const failure = new Error('vault unavailable');
  let calls = 0;
  class FailedClient extends CappedNornClient {
    override get(): Promise<unknown[]> {
      calls += 1;
      return Promise.reject(failure);
    }
  }
  expect(
    await readDoctorSnapshot(new FailedClient(documents, 10_000)).catch((error: unknown) => error),
  ).toBe(failure);
  expect(calls).toBe(1);
});

test('doctor skips body requests for an empty vault', async () => {
  const client = new CappedNornClient([], 1000);
  const snapshot = await readDoctorSnapshot(client);
  expect(snapshot.documents).toEqual([]);
  expect(snapshot.scratchpads).toEqual([]);
  expect(snapshot.sectionFailures).toEqual([]);
  expect(client.reads).toEqual([]);
});
