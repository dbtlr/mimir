import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { backends } from '../../testing/conformance';
import type { Instance } from '../../testing/conformance';
import { createInitiative, createPhase, createProject, createTask } from '../create';
import { MimirError } from '../errors';
import { archiveProject, attachArtifact, completeTask, depend } from '../mutations';
import type { Store } from '../store';
import { searchRecords } from './intent';

/**
 * Cross-record search (MMR-447) over every backend: the database matches,
 * ranks, and limits, so each behavior is proved on SQLite and Postgres alike.
 *
 * The board, by id:
 *
 *   MMR-1   initiative  Console rebuild                ("…grows record pages.")
 *   MMR-2   phase       Record pages                   (under MMR-1)
 *   MMR-3   task        Seeds open as their own pages  (under MMR-2, done)
 *   MMR-4   task        Cross-record search            (under MMR-2, depends on MMR-3, upstream MMR-s1)
 *   MMR-5   initiative  Loose ends                     (open-ended; MMR-6…10 sit under it)
 *   MMR-6   task        Search ended before the pages  (a subsequence-only title for "seed page")
 *   MMR-7   task        Seed page polish               (older)
 *   MMR-8   task        Palette layout                 ("The seed page layout comes first.")
 *   MMR-9   task        Notes                          ("A seedling pageant." — part words only)
 *   MMR-10  task        Seed pages for artifacts       (newer)
 *   MMR-s1  seed        Fuzzy palette                  (promoted to MMR-4)
 *   MMR-a1  artifact    Search spec                    (summary names the palette, attached to MMR-4)
 *   NOR-1   initiative  Knowledge                      (NOR-2…4 under it; NOR-2 is "Seed pages for knowledge")
 *   OPS-1…2             an archived project, holding "Seed pages archived" — never found
 */
async function seedBoard(store: Store): Promise<void> {
  await createProject(store, { key: 'MMR', name: 'Mimir' });
  await createProject(store, { description: 'The knowledge tool.', key: 'NOR', name: 'Norn' });
  await createProject(store, { key: 'OPS', name: 'Operations' });

  const console_ = await createInitiative(store, {
    description: 'The operator console grows record pages.',
    projectId: 'MMR',
    title: 'Console rebuild',
  });
  const phase = await createPhase(store, { parentId: console_.id, title: 'Record pages' });
  const seedPages = await createTask(store, {
    description: 'Each seed gets a page.',
    parentId: phase.id,
    title: 'Seeds open as their own pages',
  });
  const seed = await store.seeds.create({
    description: 'A palette that jumps to records.',
    key: 'MMR',
    kind: 'idea',
    requester: null,
    title: 'Fuzzy palette',
  });
  const search = await createTask(store, {
    description: 'Search matches the palette query.',
    parentId: phase.id,
    title: 'Cross-record search',
    upstream: 'MMR-s1',
  });
  await depend(store, search.id, [seedPages.id]);
  const loose = await createInitiative(store, {
    openEnded: true,
    projectId: 'MMR',
    title: 'Loose ends',
  });
  await createTask(store, { parentId: loose.id, title: 'Search ended before the pages' });
  const older = await createTask(store, { parentId: loose.id, title: 'Seed page polish' });
  await createTask(store, {
    description: 'The seed page layout comes first.',
    parentId: loose.id,
    title: 'Palette layout',
  });
  await createTask(store, {
    description: 'A seedling pageant.',
    parentId: loose.id,
    title: 'Notes',
  });
  const newer = await createTask(store, { parentId: loose.id, title: 'Seed pages for artifacts' });
  await attachArtifact(store, {
    content: '# spec',
    linkNodeIds: [search.id],
    projectId: 'MMR',
    summary: 'How the palette query ranks records.',
    title: 'Search spec',
  });
  await store.seeds.germinate(seed.key, seed.seq, search.id);
  await completeTask(store, seedPages.id);

  const knowledge = await createInitiative(store, { projectId: 'NOR', title: 'Knowledge' });
  for (const title of ['Seed pages for knowledge', 'Vault', 'Search the vault']) {
    await createTask(store, { parentId: knowledge.id, title });
  }
  const archive = await createInitiative(store, { projectId: 'OPS', title: 'Archive' });
  await createTask(store, { parentId: archive.id, title: 'Seed pages archived' });
  await archiveProject(store, 'OPS');

  // Recency is a ranking input, so the two open MMR title hits get fixed,
  // distinct stamps: the newer one has the larger id, so an id tiebreak alone
  // would put it second.
  await store.transact(async (w) => {
    await w.updateNode(older.id, { updated_at: '2026-01-01T00:00:00.000Z' });
    await w.updateNode(newer.id, { updated_at: '2026-02-01T00:00:00.000Z' });
  });
}

/** Rows of ids and labels in a fixed order, for links whose order is not the point. */
const sorted = (rows: (string | undefined)[][]): (string | undefined)[][] =>
  rows.toSorted((a, b) => a.join(',').localeCompare(b.join(',')));

const ids = (result: { items: { id: string }[] }): string[] => result.items.map((hit) => hit.id);

// One describe block per backend — a plain loop reads clearer than
// describe.each here (each arm carries its own instance).
// oxlint-disable-next-line vitest/prefer-each
for (const backend of backends) {
  describe(`cross-record search — ${backend.name}`, () => {
    let instance: Instance;
    let store: Store;
    beforeEach(async () => {
      instance = await backend.make();
      store = instance.store;
      await seedBoard(store);
    });
    afterEach(async () => {
      await instance?.close();
    });

    describe('ID-like queries', () => {
      test('a full ID in any case finds the record, then its labelled links', async () => {
        const result = await searchRecords(store, { query: 'mmr-4' });

        expect(result.items[0]).toMatchObject({
          finished: false,
          id: 'MMR-4',
          kind: 'task',
          lifecycle: 'todo',
          match: 'id',
          project: 'MMR',
          title: 'Cross-record search',
        });
        const links = result.items.slice(1).map((hit) => [hit.id, hit.match, hit.link]);
        expect(sorted(links)).toEqual([
          ['MMR-2', 'link', 'parent'],
          ['MMR-3', 'link', 'depends_on'],
          ['MMR-a1', 'link', 'artifact'],
          ['MMR-s1', 'link', 'upstream'],
        ]);
        expect(result.total).toBe(5);
      });

      test('links come newest first', async () => {
        const result = await searchRecords(store, { query: 'MMR-4' });
        const stamps = result.items.slice(1).map((hit) => hit.updatedAt);
        expect(stamps).toEqual(stamps.toSorted().toReversed());
      });

      test('a seed links the task it was promoted to', async () => {
        const result = await searchRecords(store, { query: 'mmr-S1' });
        expect(result.items.map((hit) => [hit.id, hit.match, hit.link])).toEqual([
          ['MMR-s1', 'id', undefined],
          ['MMR-4', 'link', 'spawned'],
        ]);
      });

      test('an artifact links the tasks it is attached to', async () => {
        const result = await searchRecords(store, { query: 'MMR-A1' });
        expect(result.items.map((hit) => [hit.id, hit.match, hit.link])).toEqual([
          ['MMR-a1', 'id', undefined],
          ['MMR-4', 'link', 'attached'],
        ]);
      });

      test('a container links its parent and children', async () => {
        const result = await searchRecords(store, { query: 'MMR-2' });
        expect(result.items[0]).toMatchObject({ id: 'MMR-2', kind: 'phase', match: 'id' });
        expect(sorted(result.items.slice(1).map((hit) => [hit.id, hit.link]))).toEqual([
          ['MMR-1', 'parent'],
          ['MMR-3', 'child'],
          ['MMR-4', 'child'],
        ]);
      });

      test('a bare key finds the project and its top-level children', async () => {
        const result = await searchRecords(store, { query: 'nor' });
        expect(result.items[0]).toMatchObject({
          finished: false,
          id: 'NOR',
          kind: 'project',
          match: 'id',
          title: 'Norn',
        });
        expect(result.items.slice(1).map((hit) => [hit.id, hit.link])).toEqual([
          ['NOR-1', 'child'],
        ]);
      });

      test('the links stop at eight', async () => {
        // MMR already has two top-level children; seven more make nine.
        for (let n = 1; n <= 7; n++) {
          await createInitiative(store, { projectId: 'MMR', title: `Extra ${String(n)}` });
        }
        // The oldest child is the one left out.
        await store.transact(async (w) => {
          await w.updateNode('MMR-1', { updated_at: '2000-01-01T00:00:00.000Z' });
        });
        const result = await searchRecords(store, { query: 'MMR' });
        expect(result.items[0]?.id).toBe('MMR');
        expect(result.items).toHaveLength(9);
        expect(ids(result)).not.toContain('MMR-1');
      });

      test('a number too large for a sequence falls back to text search', async () => {
        for (const query of ['3000000000', 'a3000000000', '99999999999999999999']) {
          const result = await searchRecords(store, { query });
          expect(result.items.filter((hit) => hit.match === 'id')).toEqual([]);
        }
      });

      test('an unknown current project is refused', async () => {
        const error = await searchRecords(store, { project: 'NOPE', query: '1' }).catch(
          (e: unknown) => e,
        );
        expect((error as MimirError).code).toBe('not_found');
      });

      test('a bare suffix resolves in the current project', async () => {
        const node = await searchRecords(store, { project: 'NOR', query: '4' });
        expect(node.items[0]).toMatchObject({ id: 'NOR-4', match: 'id' });
        const artifact = await searchRecords(store, { project: 'MMR', query: 'A1' });
        expect(artifact.items[0]).toMatchObject({ id: 'MMR-a1', kind: 'artifact', match: 'id' });
        const seed = await searchRecords(store, { project: 'MMR', query: 's1' });
        expect(seed.items[0]).toMatchObject({ id: 'MMR-s1', kind: 'seed', match: 'id' });
      });

      test('with no current project, a bare suffix lists it in every active project', async () => {
        const result = await searchRecords(store, { query: '1' });
        expect(result.items.map((hit) => [hit.id, hit.match])).toEqual([
          ['MMR-1', 'id'],
          ['NOR-1', 'id'],
        ]);
        expect(result.total).toBe(2);
      });

      test('an ID in an archived project is not found', async () => {
        // Each falls back to text search, which never reaches OPS either.
        for (const query of ['OPS-1', 'OPS', 'ops-2']) {
          const result = await searchRecords(store, { query });
          expect(result.items.filter((hit) => hit.project === 'OPS' || hit.match === 'id')).toEqual(
            [],
          );
        }
      });

      test('an ID-like query with no record falls back to text search', async () => {
        const result = await searchRecords(store, { project: 'MMR', query: 'seed' });
        expect(result.items.length).toBeGreaterThan(0);
        expect(result.items.every((hit) => hit.match !== 'id')).toBe(true);
      });
    });

    describe('text queries', () => {
      test('title hits rank above whole-word description hits', async () => {
        const result = await searchRecords(store, { project: 'MMR', query: 'Seed page' });
        expect(result.items.map((hit) => [hit.id, hit.match])).toEqual([
          // Titles holding every term: the current project's open hits newest
          // first, its finished hit, then another project's.
          ['MMR-10', 'title'],
          ['MMR-7', 'title'],
          ['MMR-3', 'title'],
          ['NOR-2', 'title'],
          // A description holding both words whole; MMR-9's "seedling
          // pageant" holds them only as parts of words, and MMR-6's title
          // holds them only as subsequences, which a precise hit outranks.
          ['MMR-8', 'description'],
        ]);
        expect(result.total).toBe(5);
      });

      test('with no precise hit, titles holding every term as a subsequence are found', async () => {
        const result = await searchRecords(store, { project: 'MMR', query: 'srch' });
        expect(result.items.every((hit) => hit.match === 'title')).toBe(true);
        // The current project's hits first (their recency order is not the point).
        expect(ids(result).slice(0, 3).toSorted()).toEqual(['MMR-4', 'MMR-6', 'MMR-a1']);
        expect(ids(result).slice(3)).toEqual(['NOR-4']);
      });

      test('with no current project, open hits come first across projects', async () => {
        const result = await searchRecords(store, { query: 'seed page' });
        expect(ids(result).slice(0, 4)).toEqual(['NOR-2', 'MMR-10', 'MMR-7', 'MMR-3']);
      });

      test('a description hit carries a plain-text snippet', async () => {
        const result = await searchRecords(store, { query: 'seed page' });
        const hit = result.items.find((item) => item.id === 'MMR-8');
        expect(hit?.snippet).toBe('The seed page layout comes first.');
        expect(result.items.find((item) => item.id === 'MMR-7')?.snippet).toBeUndefined();
      });

      test('hits span every record kind', async () => {
        const result = await searchRecords(store, { project: 'MMR', query: 'palette' });
        expect(sorted(result.items.map((hit) => [hit.id, hit.kind, hit.match]))).toEqual([
          ['MMR-4', 'task', 'description'],
          ['MMR-8', 'task', 'title'],
          ['MMR-a1', 'artifact', 'description'],
          ['MMR-s1', 'seed', 'title'],
        ]);
        const project = await searchRecords(store, { query: 'knowledge tool' });
        expect(project.items.map((hit) => [hit.id, hit.kind, hit.match])).toEqual([
          ['NOR', 'project', 'description'],
        ]);
      });

      test('the limit caps the hits while the total counts them all', async () => {
        const result = await searchRecords(store, { limit: 2, project: 'MMR', query: 'seed page' });
        expect(ids(result)).toEqual(['MMR-10', 'MMR-7']);
        expect(result.returned).toBe(2);
        expect(result.total).toBe(5);
      });

      test('a word with non-ASCII letters is not split into ASCII fragments', async () => {
        await createTask(store, {
          description: 'The sum of r values.',
          parentId: 'MMR-5',
          title: 'Totals',
        });
        const result = await searchRecords(store, { query: 'résumé' });
        expect(result.items.filter((hit) => hit.match === 'description')).toEqual([]);
      });

      test('LIKE wildcards in a query match only themselves', async () => {
        for (const query of ['_', '%']) {
          expect((await searchRecords(store, { query })).total).toBe(0);
        }
        // Descriptions still match the words either side of the `%`.
        const result = await searchRecords(store, { query: 'seed%page' });
        expect(result.items.filter((hit) => hit.match === 'title')).toEqual([]);
      });

      test('a limit outside 1 to 100 is a validation error', async () => {
        for (const limit of [0, 101, 1.5]) {
          const error = await searchRecords(store, { limit, query: 'seed' }).catch(
            (e: unknown) => e,
          );
          expect((error as MimirError).code).toBe('validation');
        }
      });
    });

    describe('finished', () => {
      test('a container is finished once every task beneath it is', async () => {
        const before = await searchRecords(store, { query: 'MMR-2' });
        expect(before.items[0]).toMatchObject({ finished: false, id: 'MMR-2' });

        await completeTask(store, 'MMR-4');
        const after = await searchRecords(store, { query: 'MMR-2' });
        expect(after.items[0]).toMatchObject({ finished: true, id: 'MMR-2' });
        // The initiative above the phase counts the same tasks.
        expect(after.items.find((hit) => hit.id === 'MMR-1')).toMatchObject({ finished: true });
      });

      test('an open-ended container never finishes', async () => {
        for (const id of ['MMR-6', 'MMR-7', 'MMR-8', 'MMR-9', 'MMR-10']) {
          await completeTask(store, id);
        }
        const result = await searchRecords(store, { query: 'MMR-5' });
        expect(result.items[0]).toMatchObject({ finished: false, id: 'MMR-5' });
      });

      test('a finished seed and a done task read as finished', async () => {
        await store.seeds.transition('MMR', 1, 'resolved', 'shipped');
        const seed = await searchRecords(store, { query: 'MMR-s1' });
        expect(seed.items[0]).toMatchObject({ finished: true, lifecycle: 'resolved' });
        const task = await searchRecords(store, { query: 'MMR-3' });
        expect(task.items[0]).toMatchObject({ finished: true, lifecycle: 'done' });
      });
    });
  });
}

test('an empty query is a validation error', async () => {
  const instance = await backends[1]?.make();
  if (instance === undefined) {
    throw new Error('the SQLite backend is missing');
  }
  try {
    const error = await searchRecords(instance.store, { query: '   ' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MimirError);
    expect((error as MimirError).code).toBe('validation');
  } finally {
    await instance.close();
  }
});
