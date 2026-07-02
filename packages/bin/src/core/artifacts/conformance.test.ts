import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTestDb } from '../../db/testing';
import { bunExec } from '../../exec';
import { NornClient } from '../../norn/client';
import { converge } from '../../vault/converge';
import type { Db } from '../context';
import { createInitiative, createProject, createTask } from '../create';
import { renderNodeId } from '../lookup';
import { createSqliteStore } from '../store-sqlite';
import { createNornArtifactStore } from './norn';
import type { ArtifactStore } from './store';

/**
 * The artifact-seam conformance oracle (MMR-143, ADR 0016): the SAME contract
 * suite runs against both backends, so the Norn implementation is held to the
 * SQLite behavior it replaces. The Norn arm needs a real `norn` binary and is
 * skipped when it's off PATH (CI) — the SQLite arm always runs.
 *
 * Documented, intentional deltas (asserted in the Norn arm, not the shared
 * suite): `q` matches title only (not content), and a tag `note` is rejected.
 */
const NORN = Bun.which('norn') !== null;

type Harness = {
  artifacts: ArtifactStore;
  /** Real, linkable node stems under `MMR` — three of them for the tests. */
  nodeStems: string[];
  cleanup: () => Promise<void>;
};

/**
 * SQLite enforces `artifact_link`'s FK, so link targets must be real nodes;
 * Norn allows dangling wikilinks. To hold both to the same contract, seed
 * real nodes in SQLite and reuse their stems for Norn (where they're just
 * links). Three tasks under one initiative gives the tests distinct anchors.
 */
async function sqliteHarness(): Promise<Harness> {
  const db: Db = await createTestDb();
  const store = createSqliteStore(db);
  const project = await createProject(store, { key: 'MMR', name: 'MMR' });
  const init = await createInitiative(store, { projectId: project.id, title: 'i' });
  const stems: string[] = [];
  for (const title of ['n1', 'n2', 'n3']) {
    const task = await createTask(store, { parentId: init.id, title });
    stems.push((await renderNodeId(db, task.id)) ?? 'unknown');
  }
  return {
    artifacts: store.artifacts,
    async cleanup() {
      await db.destroy();
    },
    nodeStems: stems,
  };
}

async function nornHarness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'mimir-conf-'));
  await converge(join(root, 'vault'), { allowCreate: true, exec: bunExec });
  const client = new NornClient({ vaultPath: join(root, 'vault') });
  return {
    artifacts: createNornArtifactStore(client),
    async cleanup() {
      await client.close();
      rmSync(root, { force: true, recursive: true });
    },
    // Dangling wikilinks are allowed (nodes live in SQLite until Phase 3), so
    // the same stems the SQLite arm seeded are valid links here without nodes.
    nodeStems: ['MMR-2', 'MMR-3', 'MMR-4'],
  };
}

const backends: { name: string; make: () => Promise<Harness>; skip: boolean }[] = [
  { make: sqliteHarness, name: 'sqlite', skip: false },
  { make: nornHarness, name: 'norn', skip: !NORN },
];

// One describe block per backend — a plain loop reads clearer than
// describe.each here (each arm carries its own skip + typed harness).
// oxlint-disable-next-line vitest/prefer-each
for (const backend of backends) {
  describe(`ArtifactStore conformance — ${backend.name}`, () => {
    let h: Harness;
    beforeEach(async () => {
      if (backend.skip) {
        return;
      }
      h = await backend.make();
    });
    afterEach(async () => {
      await h?.cleanup();
    });

    test.skipIf(backend.skip)(
      'create allocates KEY-aN and load round-trips metadata + content',
      async () => {
        const { key, seq } = await h.artifacts.create({
          content: '# body\n\ntext',
          key: 'MMR',
          links: [h.nodeStems[0] ?? ''],
          tags: ['spec', 'v1'],
          title: 'A spec',
        });
        expect(key).toBe('MMR');
        expect(seq).toBe(1);

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
      },
    );

    test.skipIf(backend.skip)(
      'seq increments per project; load of a missing artifact is undefined',
      async () => {
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
      },
    );

    test.skipIf(backend.skip)(
      'updateTitle patches title, leaves content frozen; false for a missing artifact',
      async () => {
        await h.artifacts.create({
          content: 'body',
          key: 'MMR',
          links: [],
          tags: [],
          title: 'old',
        });
        expect(await h.artifacts.updateTitle('MMR', 1, 'new')).toBe(true);
        const loaded = await h.artifacts.load('MMR', 1, { content: true });
        expect(loaded?.title).toBe('new');
        expect(loaded?.content).toBe('body');
        expect(await h.artifacts.updateTitle('MMR', 99, 'x')).toBe(false);
      },
    );

    test.skipIf(backend.skip)('listForNode returns artifacts anchored to a node stem', async () => {
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

    test.skipIf(backend.skip)(
      'listForProject returns the whole inventory in seq order',
      async () => {
        await h.artifacts.create({ content: '', key: 'MMR', links: [], tags: [], title: 'first' });
        await h.artifacts.create({ content: '', key: 'MMR', links: [], tags: [], title: 'second' });
        const all = await h.artifacts.listForProject('MMR');
        expect(all.map((r) => r.title)).toEqual(['first', 'second']);
      },
    );

    test.skipIf(backend.skip)('list filters by tag and project', async () => {
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

    test.skipIf(backend.skip)('list is newest-first and honors since/before + limit', async () => {
      for (const t of ['a1', 'a2', 'a3']) {
        await h.artifacts.create({ content: '', key: 'MMR', links: [], tags: [], title: t });
      }
      const all = await h.artifacts.list({});
      expect(all.items.map((r) => r.seq)).toEqual([3, 2, 1]); // newest-first, seq tiebreak

      const mid = all.items[1]?.created_at ?? '';
      expect((await h.artifacts.list({ since: mid })).items.every((r) => r.created_at >= mid)).toBe(
        true,
      );
      expect(
        (await h.artifacts.list({ before: mid })).items.every((r) => r.created_at <= mid),
      ).toBe(true);

      const limited = await h.artifacts.list({ limit: 2 });
      expect(limited.items).toHaveLength(2);
      expect(limited.total).toBe(3); // pre-limit total
    });

    test.skipIf(backend.skip)('applyTag adds; removeTags removes and counts', async () => {
      await h.artifacts.create({ content: '', key: 'MMR', links: [], tags: ['a'], title: 't' });
      await h.artifacts.applyTag('MMR', 1, 'b', null);
      await h.artifacts.applyTag('MMR', 1, 'a', null); // idempotent
      expect((await h.artifacts.load('MMR', 1))?.tags.toSorted()).toEqual(['a', 'b']);
      const removed = await h.artifacts.removeTags('MMR', 1, ['a', 'nope']);
      expect(removed).toBe(1);
      expect((await h.artifacts.load('MMR', 1))?.tags).toEqual(['b']);
    });
  });
}

describe('Norn backend — documented deltas from SQLite', () => {
  let h: Harness;
  beforeEach(async () => {
    if (!NORN) {
      return;
    }
    h = await nornHarness();
  });
  afterEach(async () => {
    await h?.cleanup();
  });

  test.skipIf(!NORN)('a tag note is rejected (frontmatter tags are plain)', async () => {
    await h.artifacts.create({ content: '', key: 'MMR', links: [], tags: [], title: 't' });
    expect(h.artifacts.applyTag('MMR', 1, 'x', 'a note')).rejects.toThrow(/note/i);
  });
});
