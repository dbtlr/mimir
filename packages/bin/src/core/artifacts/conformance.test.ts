import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { backends } from '../../testing/conformance';
import type { Instance } from '../../testing/conformance';
import { createInitiative, createProject } from '../create';
import type { ArtifactStore } from './store';

/**
 * The artifact-seam conformance oracle (MMR-143, ADR 0016): the contract suite
 * every backend's `ArtifactStore` must satisfy, over the shared backend table.
 */
type Harness = {
  artifacts: ArtifactStore;
  /** Linkable node stems under `MMR` — three of them for the tests. */
  nodeStems: string[];
  cleanup: () => Promise<void>;
};

/** A fresh backend instance with project `MMR` and three linkable nodes. */
async function harnessOver(make: () => Promise<Instance>): Promise<Harness> {
  const instance = await make();
  const { store } = instance;
  await createProject(store, { key: 'MMR', name: 'Mimir' });
  const nodeStems: string[] = [];
  for (const title of ['one', 'two', 'three']) {
    nodeStems.push((await createInitiative(store, { projectId: 'MMR', title })).id);
  }
  return { artifacts: store.artifacts, cleanup: instance.close, nodeStems };
}

// One describe block per backend — a plain loop reads clearer than
// describe.each here (each arm carries its own typed harness).
// oxlint-disable-next-line vitest/prefer-each
for (const backend of backends) {
  describe(`ArtifactStore conformance — ${backend.name}`, () => {
    let h: Harness;
    beforeEach(async () => {
      h = await harnessOver(backend.make);
    });
    afterEach(async () => {
      await h?.cleanup();
    });

    test('create allocates KEY-aN and load round-trips metadata + content', async () => {
      const created = await h.artifacts.create({
        content: '# body\n\ntext',
        key: 'MMR',
        links: [h.nodeStems[0] ?? ''],
        tags: ['spec', 'v1'],
        title: 'A spec',
      });
      const { key, seq } = created;
      expect(key).toBe('MMR');
      expect(seq).toBe(1);

      // The held-record echo IS the contract (MMR-283, mirroring seeds):
      // create's own return must equal what a subsequent load reads back —
      // including the normalization edges (unsorted links, multi-trailing-
      // newline content) covered by the dedicated case below.
      expect(await h.artifacts.load('MMR', 1, { content: true })).toEqual(created);

      const meta = await h.artifacts.load('MMR', 1);
      expect(meta).toMatchObject({
        key: 'MMR',
        links: [h.nodeStems[0] ?? ''],
        seq: 1,
        tags: ['spec', 'v1'],
        title: 'A spec',
      });
      expect(meta?.content).toBeUndefined(); // not opted in

      const withBody = await h.artifacts.load('MMR', 1, { content: true });
      expect(withBody?.content).toBe('# body\n\ntext');
    });

    test('the create echo equals a load through the normalization edges (MMR-283)', async () => {
      // Unsorted links and a multi-trailing-newline body — the two places the
      // held-record echo could drift from a read-back: links sort on read, and
      // content sheds exactly one trailing newline.
      const created = await h.artifacts.create({
        content: 'line a\n\n\n',
        key: 'MMR',
        links: [h.nodeStems[1] ?? '', h.nodeStems[0] ?? ''],
        tags: ['spec'],
        title: 'edge echo',
      });
      expect(await h.artifacts.load('MMR', 1, { content: true })).toEqual(created);
      expect(created.content).toBe('line a\n\n');
    });

    test('seq increments per project; load of a missing artifact is undefined', async () => {
      const a = await h.artifacts.create({
        content: 'a',
        key: 'MMR',
        links: [],
        tags: [],
        title: 'a',
      });
      const b = await h.artifacts.create({
        content: 'b',
        key: 'MMR',
        links: [],
        tags: [],
        title: 'b',
      });
      expect([a.seq, b.seq]).toEqual([1, 2]);
      expect(await h.artifacts.load('MMR', 99)).toBeUndefined();
    });

    test('source_scratch provenance round-trips through the dedicated recovery lookup', async () => {
      const sourceScratch = '123e4567-e89b-42d3-a456-426614174000';
      const created = await h.artifacts.create({
        content: 'complete scratch body',
        key: 'MMR',
        links: [h.nodeStems[0] ?? ''],
        sourceScratch,
        summary: 'frozen episode',
        tags: ['scratchpad'],
        title: 'episode',
      });
      expect(await h.artifacts.findBySourceScratch(sourceScratch)).toEqual(created);
      expect(
        await h.artifacts.findBySourceScratch('223e4567-e89b-42d3-a456-426614174000'),
      ).toBeUndefined();
    });

    test('updateMetadata patches title, leaves content frozen; false for a missing artifact', async () => {
      await h.artifacts.create({
        content: 'body',
        key: 'MMR',
        links: [],
        tags: [],
        title: 'old',
      });
      expect(await h.artifacts.updateMetadata('MMR', 1, { title: 'new' })).toBe(true);
      const loaded = await h.artifacts.load('MMR', 1, { content: true });
      expect(loaded?.title).toBe('new');
      expect(loaded?.content).toBe('body');
      expect(await h.artifacts.updateMetadata('MMR', 99, { title: 'x' })).toBe(false);
    });

    // The lede round-trip (MMR-319): absent on create reads as null, added by a
    // metadata patch, replaced in place, and cleared back to absent — the whole
    // add/set/remove field-op cycle against a real store.
    test('updateMetadata adds, replaces, and clears the summary lede; create carries it through', async () => {
      await h.artifacts.create({
        content: 'body',
        key: 'MMR',
        links: [],
        tags: [],
        title: 'no lede',
      });
      expect((await h.artifacts.load('MMR', 1))?.summary).toBeNull();

      expect(await h.artifacts.updateMetadata('MMR', 1, { summary: 'the lede' })).toBe(true);
      expect((await h.artifacts.load('MMR', 1))?.summary).toBe('the lede');

      expect(await h.artifacts.updateMetadata('MMR', 1, { summary: 'a better lede' })).toBe(true);
      expect((await h.artifacts.load('MMR', 1))?.summary).toBe('a better lede');

      expect(await h.artifacts.updateMetadata('MMR', 1, { summary: null })).toBe(true);
      const cleared = await h.artifacts.load('MMR', 1, { content: true });
      expect(cleared?.summary).toBeNull();
      expect(cleared?.content).toBe('body');

      const born = await h.artifacts.create({
        content: 'body',
        key: 'MMR',
        links: [],
        summary: 'born with one',
        tags: [],
        title: 'with lede',
      });
      expect(born.summary).toBe('born with one');
      expect((await h.artifacts.load('MMR', born.seq))?.summary).toBe('born with one');
    });

    test('listForNode returns artifacts anchored to a node stem', async () => {
      const [a, b] = h.nodeStems;
      await h.artifacts.create({
        content: '',
        key: 'MMR',
        links: [a ?? ''],
        tags: [],
        title: 'one',
      });
      await h.artifacts.create({
        content: '',
        key: 'MMR',
        links: [b ?? ''],
        tags: [],
        title: 'two',
      });
      await h.artifacts.create({
        content: '',
        key: 'MMR',
        links: [a ?? ''],
        tags: [],
        title: 'three',
      });
      const forA = await h.artifacts.listForNode(a ?? '');
      expect(forA.map((r) => r.title).toSorted()).toEqual(['one', 'three']);
    });

    test('listForProject returns the whole inventory in seq order', async () => {
      await h.artifacts.create({ content: '', key: 'MMR', links: [], tags: [], title: 'first' });
      await h.artifacts.create({ content: '', key: 'MMR', links: [], tags: [], title: 'second' });
      const all = await h.artifacts.listForProject('MMR');
      expect(all.map((r) => r.title)).toEqual(['first', 'second']);
    });

    test('list filters by tag and project', async () => {
      await h.artifacts.create({
        content: '',
        key: 'MMR',
        links: [],
        tags: ['spec'],
        title: 'a spec',
      });
      await h.artifacts.create({
        content: '',
        key: 'MMR',
        links: [],
        tags: ['log'],
        title: 'a log',
      });
      const specs = await h.artifacts.list({ tag: 'spec' });
      expect(specs.items.map((r) => r.title)).toEqual(['a spec']);
      expect(specs.total).toBe(1);
      const all = await h.artifacts.list({ project: 'MMR' });
      expect(all.total).toBe(2);
    });

    test('list is newest-first and honors the created window + limit', async () => {
      for (const t of ['a1', 'a2', 'a3']) {
        await h.artifacts.create({ content: '', key: 'MMR', links: [], tags: [], title: t });
      }
      const all = await h.artifacts.list({});
      expect(all.items.map((r) => r.seq)).toEqual([3, 2, 1]); // newest-first, seq tiebreak

      // The core resolves a filter to this window shape; the backend only
      // compares against the edges it is handed (ADR 0029).
      const mid = all.items[1]?.created_at ?? '';
      const midMs = Date.parse(mid);
      const atOrAfterMid = { at: mid, epochMs: midMs, inclusive: true };
      const from = await h.artifacts.list({ created: { from: atOrAfterMid, until: null } });
      expect(from.items.every((r) => r.created_at >= mid)).toBe(true);
      const until = await h.artifacts.list({ created: { from: null, until: atOrAfterMid } });
      expect(until.items.every((r) => r.created_at <= mid)).toBe(true);

      const limited = await h.artifacts.list({ limit: 2 });
      expect(limited.items).toHaveLength(2);
      expect(limited.total).toBe(3); // pre-limit total

      // offset pages the same newest-first order past the window.
      const paged = await h.artifacts.list({ limit: 2, offset: 2 });
      expect(paged.items.map((r) => r.seq)).toEqual([1]);
      expect(paged.total).toBe(3); // pre-window total, unchanged by paging
    });

    test('applyTag adds; removeTags removes and counts', async () => {
      await h.artifacts.create({ content: '', key: 'MMR', links: [], tags: ['a'], title: 't' });
      await h.artifacts.applyTag('MMR', 1, 'b');
      await h.artifacts.applyTag('MMR', 1, 'a'); // idempotent
      expect((await h.artifacts.load('MMR', 1))?.tags.toSorted()).toEqual(['a', 'b']);
      const removed = await h.artifacts.removeTags('MMR', 1, ['a', 'nope']);
      expect(removed).toBe(1);
      expect((await h.artifacts.load('MMR', 1))?.tags).toEqual(['b']);
    });
  });
}
