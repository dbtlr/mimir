import { beforeAll, describe, expect, test } from 'bun:test';

import { createProject } from './create';
import type { ExportedBodySections, StoreExport } from './export';
import { bootPglite } from './store-postgres/testing';
import {
  backends,
  refusalOf,
  seedWorkingSet,
  sharedSeededStore,
  sqliteInstance,
  withoutStamp,
} from './testing/conformance';

beforeAll(bootPglite);

// Which documents the parse refuses, and how it reads an older version, are
// pure tables on `parseTransferDocument` (transfer-validate.test.ts,
// transfer-schema.test.ts). The cases here prove what the store does around it.
describe.each(backends)('$name', (backend) => {
  // Every case imports a copy of one seeded store's export into a target of
  // its own, so the source is seeded once per backend.
  const source = sharedSeededStore(backend, seedWorkingSet);
  // How a resume compares prose and remotes, and how a read normalizes a seed
  // description, is decided in JS over what both backends read through the
  // same SQL, so those cases run on SQLite alone.
  const testOnSqlite = (name: string, body: () => Promise<void>): void => {
    if (backend.name === 'sqlite') {
      test(name, body);
    }
  };
  // One malformed document stands for every fault the parse refuses: the store
  // parses before it opens a write, in preview and apply, fresh and resume.
  test('a malformed transfer document refuses in every mode without changing the target', async () => {
    const malformed = structuredClone(source.document);
    const target = await backend.make();
    try {
      for (const node of malformed.nodes) {
        if (node.type === 'task') {
          node.parent_id = 'MMR-999';
        }
      }
      await createProject(target.store, { description: null, key: 'KEEP', name: 'Untouched' });
      const before = withoutStamp(await target.store.export());
      const refusal = await refusalOf(
        target.store.import(malformed, { dryRun: true, mode: 'fresh' }),
      );
      expect(refusal).toContain('invalid transfer document');
      expect(refusal).toContain('parent_id references missing node MMR-999');
      for (const mode of ['fresh', 'resume'] as const) {
        for (const dryRun of [true, false]) {
          const label = `${mode}, dryRun ${String(dryRun)}`;
          expect(await refusalOf(target.store.import(malformed, { dryRun, mode })), label).toBe(
            refusal,
          );
          expect(withoutStamp(await target.store.export()), label).toEqual(before);
        }
      }
    } finally {
      await target.close();
    }
  });
  // The seeded blocked task is owned by `others`; a store must write the owner
  // `you` as given too. Which owner the parse derives is transfer-schema.test.ts.
  test('an import keeps a blocked task owned by you', async () => {
    const document = structuredClone(source.document);
    const blocked = document.nodes.find((node) => node.hold === 'blocked');
    if (blocked === undefined) {
      throw new Error('the fixture has no blocked task');
    }
    blocked.block_owner = 'you';
    const target = await backend.make();
    try {
      await target.store.import(document, { dryRun: false, mode: 'fresh' });
      const imported = (await target.store.export()).nodes.find((n) => n.id === blocked.id);
      expect(imported).toMatchObject({ block_owner: 'you', hold: 'blocked' });
    } finally {
      await target.close();
    }
  });
  // `staged` (MMR-675) is a stored lifecycle both backends' node checks admit,
  // so a document carrying one imports and exports it unchanged.
  test('an import keeps a staged task staged', async () => {
    const document = structuredClone(source.document);
    const reviewed = document.nodes.find((node) => node.lifecycle === 'under_review');
    if (reviewed === undefined) {
      throw new Error('the fixture has no task under review');
    }
    reviewed.lifecycle = 'staged';
    const target = await backend.make();
    try {
      await target.store.import(document, { dryRun: false, mode: 'fresh' });
      const imported = (await target.store.export()).nodes.find((n) => n.id === reviewed.id);
      expect(imported).toMatchObject({ lifecycle: 'staged', rank: null });
    } finally {
      await target.close();
    }
  });
  // Transfer version 8 (MMR-675) keeps version 7 readable: a version-7 document
  // imports and re-exports at the current version.
  test('a version-7 document still imports', async () => {
    const document = { ...structuredClone(source.document), schema_version: 7 };
    const target = await backend.make();
    try {
      await target.store.import(document, { dryRun: false, mode: 'fresh' });
      const exported = await target.store.export();
      expect(exported.schema_version).toBe(8);
      expect(exported.nodes.map((n) => n.id)).toEqual(source.document.nodes.map((n) => n.id));
    } finally {
      await target.close();
    }
  });
  // A project description reads trimmed, blank as none (MMR-607), and a remote
  // is stored normalized (MMR-609), so a resume must compare both by that same
  // read, or a document carrying them as written refuses its own fresh import.
  testOnSqlite(
    'a resume accepts its own fresh import when a project description or remote is not in stored form',
    async () => {
      const document = structuredClone(source.document);
      const [first, second] = document.projects;
      if (first === undefined || second === undefined) {
        throw new Error('the fixture seeds two projects');
      }
      first.description = ' \n\t ';
      first.remote = '  git@github.com:dbtlr/mimir.git  ';
      second.description = '  The ops board.\n';
      second.remote = '   ';

      const target = await backend.make();
      try {
        await target.store.import(document, { dryRun: false, mode: 'fresh' });
        const resumed = await target.store.import(document, { dryRun: false, mode: 'resume' });
        expect(resumed.created).toBe(0);
        const projects = (await target.store.export()).projects;
        expect(projects.map((p) => p.description)).toEqual([null, 'The ops board.']);
        expect(projects.map((p) => p.remote)).toEqual(['github.com/dbtlr/mimir', null]);

        // A resume compares the target's remotes as stored, so whatever form a
        // write stored stays comparable, even on a project the document does not
        // carry: a path with a space. (A write can no longer store a host the
        // stored form refuses, MMR-612; store-sql/transfer.test.ts plants one.)
        await createProject(target.store, {
          description: null,
          key: 'OTH',
          name: 'Other',
          remote: 'https://github.com/org/my repo',
        });
        const again = await target.store.import(document, { dryRun: false, mode: 'resume' });
        expect(again.created).toBe(0);
      } finally {
        await target.close();
      }
    },
  );

  // `## Next` text and a node description read trimmed, blank as none, too, so
  // a resume compares them by that read (MMR-609). Presence is its own stored
  // fact (ADR 0034): a present `## Next` whose text is blank stays present.
  testOnSqlite(
    'a resume accepts its own fresh import when ## Next or a node description is blank or padded',
    async () => {
      const exported = structuredClone(source.document);
      const [project] = exported.projects;
      const [padded, blank, bare] = exported.nodes;
      if (
        project === undefined ||
        padded === undefined ||
        blank === undefined ||
        bare === undefined
      ) {
        throw new Error('the fixture seeds a project and three nodes');
      }
      // `bare` has a blank description and no `## Next`, so it reads as no
      // prose at all and its re-export omits the stem.
      const prose: ExportedBodySections[] = [
        { description: '  ', next: { present: false, text: null }, stem: bare.id },
        { description: ' \n\t ', next: { present: true, text: ' \n' }, stem: blank.id },
        {
          description: '  Fix the import.\n',
          next: { present: true, text: '\tThen ship.  ' },
          stem: padded.id,
        },
        { next: { present: true, text: 'Go.\n' }, stem: project.key },
      ];
      const replaced = new Set(prose.map((sections) => sections.stem));
      const document: StoreExport = {
        ...exported,
        bodySections: [
          ...exported.bodySections.filter((sections) => !replaced.has(sections.stem)),
          ...prose,
        ],
      };

      const target = await backend.make();
      try {
        await target.store.import(document, { dryRun: false, mode: 'fresh' });
        const resumed = await target.store.import(document, { dryRun: false, mode: 'resume' });
        expect(resumed.created).toBe(0);
        const read = new Map(
          (await target.store.export()).bodySections.map((sections) => [sections.stem, sections]),
        );
        expect(read.get(project.key)?.next).toEqual({ present: true, text: 'Go.' });
        expect(read.get(padded.id)).toMatchObject({
          description: 'Fix the import.',
          next: { present: true, text: 'Then ship.' },
        });
        expect(read.get(blank.id)).toMatchObject({
          description: null,
          next: { present: true, text: null },
        });
        expect(read.has(bare.id)).toBe(false);
      } finally {
        await target.close();
      }
    },
  );

  // The other half of MMR-609: comparing prose as the target reads it must not
  // accept prose the target does not hold. A present `## Next` with blank text
  // is not an absent one (ADR 0034).
  testOnSqlite(
    'a resume refuses a document whose ## Next or node description differs from the target',
    async () => {
      const exported = structuredClone(source.document);
      const [project] = exported.projects;
      const [described, headed] = exported.nodes;
      if (project === undefined || described === undefined || headed === undefined) {
        throw new Error('the fixture seeds a project and two nodes');
      }
      const prose: ExportedBodySections[] = [
        { description: 'A', next: { present: true, text: null }, stem: described.id },
        { next: { present: true, text: null }, stem: headed.id },
        { next: { present: true, text: null }, stem: project.key },
      ];
      const withProse = (sections: readonly ExportedBodySections[]): StoreExport => {
        const replaced = new Set(prose.map((row) => row.stem));
        return {
          ...exported,
          bodySections: [
            ...exported.bodySections.filter((row) => !replaced.has(row.stem)),
            ...sections,
          ],
        };
      };
      const without = (stem: string) => prose.filter((row) => row.stem !== stem);
      const variants: Record<string, ExportedBodySections[]> = {
        'a different node description': [
          { description: 'B', next: { present: true, text: null }, stem: described.id },
          ...without(described.id),
        ],
        'a node ## Next absent beside its description': [
          { description: 'A', next: { present: false, text: null }, stem: described.id },
          ...without(described.id),
        ],
        'a node ## Next absent with no other prose': without(headed.id),
        'a node ## Next with text': [
          { next: { present: true, text: 'Go.' }, stem: headed.id },
          ...without(headed.id),
        ],
        'a project ## Next absent': without(project.key),
        'a project ## Next with text': [
          { next: { present: true, text: 'Go.' }, stem: project.key },
          ...without(project.key),
        ],
      };

      const target = await backend.make();
      try {
        await target.store.import(withProse(prose), { dryRun: false, mode: 'fresh' });
        for (const [name, sections] of Object.entries(variants)) {
          const refusal = await refusalOf(
            target.store.import(withProse(sections), { dryRun: false, mode: 'resume' }),
          );
          expect(`${name}: ${refusal}`).toContain('already exists and differs');
        }
      } finally {
        await target.close();
      }
    },
  );

  // A seed write stores its description as `storedProse` does; an import writes
  // it raw, so every read normalizes it, as for project and node prose (MMR-611).
  testOnSqlite(
    'an imported seed description reads as a written one does, and resumes onto its own import',
    async () => {
      const exported = structuredClone(source.document);
      const [seed] = exported.seeds;
      if (seed === undefined) {
        throw new Error('the fixture seeds one seed');
      }
      const cases: [written: string, read: string | null][] = [
        ['  ', null],
        [' \t\n', null],
        ['  Look at the cutover. \n', 'Look at the cutover.'],
      ];
      // One seed per case, in one document.
      const seeds = cases.map(([written], index) => ({
        ...seed,
        description: written,
        seq: index + 1,
      }));
      const document: StoreExport = { ...exported, seeds };
      const target = await backend.make();
      try {
        await target.store.import(document, { dryRun: false, mode: 'fresh' });
        const described = await target.store.seeds.loadDescriptions(seeds);
        const reexported = (await target.store.export()).seeds;
        for (const [index, [written, read]] of cases.entries()) {
          const label = JSON.stringify(written);
          const ref = { key: seed.key, seq: index + 1 };
          const loaded = await target.store.seeds.load(ref.key, ref.seq, { content: true });
          expect([label, loaded?.description]).toEqual([label, read]);
          expect([label, described.get(`${ref.key}-s${ref.seq}`)]).toEqual([label, read]);
          expect([label, reexported.at(index)?.description]).toEqual([label, read]);
        }

        const resumed = await target.store.import(document, { dryRun: false, mode: 'resume' });
        expect(resumed.created).toBe(0);
        for (const [index, row] of seeds.entries()) {
          const changed = seeds.with(index, { ...row, description: 'Something else.' });
          const different = { ...document, seeds: changed };
          const refusal = await refusalOf(
            target.store.import(different, { dryRun: false, mode: 'resume' }),
          );
          expect(`${JSON.stringify(row.description)}: ${refusal}`).toContain(
            'already exists and differs',
          );
        }
      } finally {
        await target.close();
      }
    },
  );

  test('imports cross-project dependencies and preserves legacy facts', async () => {
    const document = structuredClone(source.document);
    const target = await backend.make();
    try {
      const task = document.nodes.find((node) => node.type === 'task');
      if (task === undefined) {
        throw new Error('fixture needs a task');
      }
      const compatible: StoreExport = {
        ...document,
        artifacts: document.artifacts.map((artifact) => ({
          ...artifact,
          source_scratch: '123e4567-e89b-42d3-a456-426614174099',
          updated_at: '',
        })),
        edges: [{ depends_on_node_id: 'OPS-1', node_id: 'MMR-3' }, ...document.edges],
        nodes: [
          ...document.nodes,
          {
            ...task,
            id: 'OPS-1',
            parent_id: null,
            project_id: 'OPS',
            seq: 1,
            upstream: 'OLD-s1',
          },
        ],
        projects: document.projects.map((project) =>
          project.key === 'OPS'
            ? { ...project, counters: { ...project.counters, node: 1 } }
            : project,
        ),
        seeds: document.seeds.map((seed) => Object.assign(seed, { requester: 'OLD' })),
      };
      await target.store.import(compatible, { dryRun: false, mode: 'fresh' });
      expect(withoutStamp(await target.store.export())).toEqual(withoutStamp(compatible));
      expect(
        (await target.store.import(compatible, { dryRun: false, mode: 'resume' })).created,
      ).toBe(0);
    } finally {
      await target.close();
    }
  });
});

// The import stores a project remote as a write does (MMR-543): normalized, a
// blank as none, and a value that is not a Git remote refused. The rule is
// decided in JS by the shared SQL import, so it runs on SQLite alone.
test('sqlite: an imported project remote is normalized, and one that is not a Git remote is refused', async () => {
  const source = await sqliteInstance();
  try {
    await seedWorkingSet(source.store);
    const document = await source.store.export();
    const target = await sqliteInstance();
    try {
      const before = withoutStamp(await target.store.export());
      const bad = {
        ...document,
        projects: document.projects.map((project) => ({ ...project, remote: 'not a remote' })),
      };
      expect(await refusalOf(target.store.import(bad, { dryRun: false, mode: 'fresh' }))).toContain(
        'not a Git remote',
      );
      expect(withoutStamp(await target.store.export())).toEqual(before);

      for (const project of document.projects) {
        project.remote = project.key === 'MMR' ? 'https://github.com/dbtlr/mimir.git' : '';
      }
      await target.store.import(document, { dryRun: false, mode: 'fresh' });
      expect((await target.store.export()).projects.map((project) => project.remote)).toEqual([
        'github.com/dbtlr/mimir',
        null,
      ]);
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
});
