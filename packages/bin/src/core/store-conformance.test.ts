import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';

import type { Instance } from '../testing/conformance';
import {
  backends,
  byPath,
  observe,
  refusalOf,
  seedWorkingSet,
  withoutStamp,
} from '../testing/conformance';
import { createProject, createTask } from './create';
import type { StoreExport } from './export';

/**
 * The `Store`-seam conformance oracle (MMR-378, ADR 0030) — the contract suite
 * every backend must satisfy, starting with export/import (Decision 4). It is
 * the thing that holds two backends behaviorally identical, so it is written
 * against the seam alone: the harness (backend table, fixture, observation)
 * lives in `testing/conformance.ts`, and MMR-379 adds the `postgres` arm by
 * adding one row there.
 *
 * The Norn arm needs a real `norn` binary and is skipped when it is off PATH.
 */

// Every case builds one or two whole temp vaults over a `norn mcp` subprocess
// and exercises most of the write surface against them, which runs well past
// bun's 5s default on a loaded runner (the same budget the other
// subprocess-backed suites take).
setDefaultTimeout(60_000);

// One describe-free loop per backend; each arm carries its own skip.
// oxlint-disable-next-line vitest/prefer-each
for (const backend of backends) {
  const instances: Instance[] = [];
  const fresh = async (): Promise<Instance> => {
    const instance = await backend.make();
    instances.push(instance);
    return instance;
  };
  afterEach(async () => {
    while (instances.length > 0) {
      await instances.pop()?.close();
    }
  });

  test.skipIf(backend.skip)(
    `${backend.name}: export → import into a fresh store round-trips every collection`,
    async () => {
      const source = await fresh();
      await seedWorkingSet(source.store);
      const document = await source.store.export();

      const target = await fresh();
      const report = await target.store.import(document, { mode: 'fresh' });
      expect(report.mode).toBe('fresh');
      expect(report.skipped).toBe(0);
      expect(report.created).toBeGreaterThan(0);

      expect(await observe(target.store)).toEqual(await observe(source.store));

      // A re-export of the target is the same document but for its stamp.
      const second = await target.store.export();
      expect(withoutStamp(second)).toEqual(withoutStamp(document));
      expect(second.exported_at).not.toBe('');

      // The counters state the allocation high-water mark per kind (ADR 0006).
      const mmr = document.projects.find((project) => project.key === 'MMR');
      expect(mmr?.counters).toEqual({ artifact: 2, node: 4, seed: 1 });

      // Byte-identity where the backend has documents: an imported body must
      // equal the one the normal write path grew, or the round trip is visible.
      if (source.bodies !== undefined && target.bodies !== undefined) {
        expect(byPath(target.bodies())).toEqual(byPath(source.bodies()));
      }
    },
  );

  test.skipIf(backend.skip)(
    `${backend.name}: a create after an import never collides with an imported identity`,
    async () => {
      const source = await fresh();
      await seedWorkingSet(source.store);
      const document = await source.store.export();
      const target = await fresh();
      await target.store.import(document, { mode: 'fresh' });

      const importedNodes = new Set(document.nodes.map((node) => node.id));
      const importedArtifacts = new Set(
        document.artifacts.map((artifact) => `${artifact.key}-a${String(artifact.seq)}`),
      );
      const importedSeeds = new Set(
        document.seeds.map((seed) => `${seed.key}-s${String(seed.seq)}`),
      );

      const phase = document.nodes.find((node) => node.type === 'phase');
      expect(phase).toBeDefined();
      const task = await createTask(target.store, {
        parentId: phase?.id ?? '',
        title: 'after the import',
      });
      const artifact = await target.store.artifacts.create({
        content: 'later',
        key: 'MMR',
        links: [],
        tags: [],
        title: 'Later',
      });
      const seed = await target.store.seeds.create({
        description: null,
        key: 'MMR',
        kind: 'idea',
        requester: null,
        title: 'Later seed',
      });

      expect(importedNodes.has(task.id)).toBe(false);
      expect(importedArtifacts.has(`${artifact.key}-a${String(artifact.seq)}`)).toBe(false);
      expect(importedSeeds.has(`${seed.key}-s${String(seed.seq)}`)).toBe(false);
      // Not merely distinct — past the imported high-water mark of each kind.
      expect(task.seq).toBeGreaterThan(document.projects[0]?.counters.node ?? 0);
    },
  );

  test.skipIf(backend.skip)(
    `${backend.name}: a create after an import clears the sequences even when the document's counters lag`,
    async () => {
      // A hand-edited or foreign-backend document can carry a counter BELOW the
      // highest sequence it also carries. A backend that stored the counter
      // verbatim would then re-hand an identity the same import just wrote, and
      // the next create would collide (MMR-379).
      const source = await fresh();
      await seedWorkingSet(source.store);
      const document = await source.store.export();
      const lowered: StoreExport = {
        ...document,
        projects: document.projects.map((project) => ({
          ...project,
          counters: { artifact: 0, node: 0, seed: 0 },
        })),
      };

      const target = await fresh();
      await target.store.import(lowered, { mode: 'fresh' });

      const phase = document.nodes.find((node) => node.type === 'phase');
      const task = await createTask(target.store, {
        parentId: phase?.id ?? '',
        title: 'after the lowered import',
      });
      const artifact = await target.store.artifacts.create({
        content: 'later',
        key: 'MMR',
        links: [],
        tags: [],
        title: 'Later',
      });
      const seed = await target.store.seeds.create({
        description: null,
        key: 'MMR',
        kind: 'idea',
        requester: null,
        title: 'Later seed',
      });

      const mmr = document.projects.find((project) => project.key === 'MMR');
      expect(task.seq).toBeGreaterThan(mmr?.counters.node ?? 0);
      expect(artifact.seq).toBeGreaterThan(mmr?.counters.artifact ?? 0);
      expect(seed.seq).toBeGreaterThan(mmr?.counters.seed ?? 0);
      // And nothing was lost to the collision the stored counter would have made.
      expect(await observe(target.store)).not.toEqual(await observe(source.store));
      expect((await target.store.loadWorkingSet()).nodes.length).toBe(document.nodes.length + 1);
    },
  );

  test.skipIf(backend.skip)(
    `${backend.name}: a fresh import refuses when an imported project already exists`,
    async () => {
      const source = await fresh();
      await seedWorkingSet(source.store);
      const document = await source.store.export();

      const target = await fresh();
      await createProject(target.store, { description: null, key: 'MMR', name: 'Occupied' });
      const before = await observe(target.store);

      expect(await refusalOf(target.store.import(document, { mode: 'fresh' }))).toContain('MMR');
      // Refused BEFORE writing anything.
      expect(await observe(target.store)).toEqual(before);
    },
  );

  test.skipIf(backend.skip)(
    `${backend.name}: the export refuses a store holding a record it cannot carry`,
    async () => {
      const source = await fresh();
      await seedWorkingSet(source.store);
      if (source.seedDocument === undefined) {
        return;
      }
      // An orphan: a task whose `parent` names a node that does not exist. The
      // tolerant read nulls that edge and hands back a root-level task (ADR
      // 0017), so an export that trusted the read would ship a DIFFERENT
      // hierarchy than the vault holds.
      await source.seedDocument('MMR/MMR-9.md', {
        created: '2026-09-01T00:00:00.000Z',
        lifecycle: 'active',
        parent: '[[MMR-99]]',
        project: '[[MMR]]',
        title: 'Orphan',
        type: 'task',
        updated_at: '2026-09-01T00:00:00.000Z',
      });

      const refusal = await refusalOf(source.store.export());
      expect(refusal).toContain('MMR/MMR-9.md');
      expect(refusal).toContain('mimir doctor');
    },
  );

  test.skipIf(backend.skip)(
    `${backend.name}: the export refuses an identity claimed by two records`,
    async () => {
      const source = await fresh();
      await seedWorkingSet(source.store);
      if (source.seedDocument === undefined) {
        return;
      }
      // Two documents resolving to one `KEY-a1`. Every seam read hides both, so
      // an export could only ship one of them — and would be choosing a winner
      // the store itself declines to choose.
      await source.seedDocument(
        'MMR/artifacts/spare/MMR-a1.md',
        {
          created: '2026-09-01T00:00:00.000Z',
          project: '[[MMR]]',
          title: 'Collider',
          type: 'artifact',
          updated_at: '2026-09-01T00:00:00.000Z',
        },
        'other content',
      );

      expect(await refusalOf(source.store.export())).toContain('MMR-a1.md');
    },
  );

  test.skipIf(backend.skip)(
    `${backend.name}: an import refuses a document claiming one identity twice`,
    async () => {
      const source = await fresh();
      await seedWorkingSet(source.store);
      const document = await source.store.export();
      const first = document.artifacts.at(0);
      if (first === undefined) {
        throw new Error('the fixture must export at least one artifact');
      }
      const doubled: StoreExport = {
        ...document,
        artifacts: [...document.artifacts, { ...first, title: 'Impostor' }],
      };

      const target = await fresh();
      const before = await observe(target.store);
      expect(await refusalOf(target.store.import(doubled, { mode: 'fresh' }))).toContain('MMR-a1');
      // Refused BEFORE writing anything — the alternative is a half-written
      // target for a fault that was visible in the document all along.
      expect(await observe(target.store)).toEqual(before);
    },
  );

  test.skipIf(backend.skip)(
    `${backend.name}: a fresh import refuses a project document that lost its key`,
    async () => {
      const source = await fresh();
      await seedWorkingSet(source.store);
      const document = await source.store.export();

      const target = await fresh();
      if (target.seedDocument === undefined) {
        return;
      }
      // The project's canonical path is occupied, but the document no longer
      // carries the `key` field the occupancy read keys off. The path is the
      // identity the import is about to claim, so it must refuse on that alone —
      // otherwise the fence passes and the write refuses mid-import.
      await target.seedDocument('MMR/MMR.md', {
        created: '2026-09-01T00:00:00.000Z',
        name: 'Nameless',
        type: 'project',
        updated_at: '2026-09-01T00:00:00.000Z',
      });

      expect(await refusalOf(target.store.import(document, { mode: 'fresh' }))).toContain('MMR');
    },
  );

  test.skipIf(backend.skip)(
    `${backend.name}: resume skips identical documents and refuses a differing one`,
    async () => {
      const source = await fresh();
      await seedWorkingSet(source.store);
      const document = await source.store.export();

      const target = await fresh();
      const first = await target.store.import(document, { mode: 'fresh' });

      const resumed = await target.store.import(document, { mode: 'resume' });
      expect(resumed).toEqual({ created: 0, mode: 'resume', skipped: first.created });
      expect(await observe(target.store)).toEqual(await observe(source.store));

      // A half-written target — the state a partial import actually leaves
      // (ADR 0023) — is finished by the same resume: the missing documents are
      // written and every present one is skipped.
      if (target.removeDocument !== undefined) {
        target.removeDocument('MMR/artifacts/MMR-a1.md');
        target.removeDocument('MMR/seeds/MMR-s1.md');
        const finished = await target.store.import(document, { mode: 'resume' });
        expect(finished).toEqual({
          created: 2,
          mode: 'resume',
          skipped: first.created - 2,
        });
        expect(await observe(target.store)).toEqual(await observe(source.store));
      }

      if (target.corruptDocument === undefined) {
        return;
      }
      target.corruptDocument('MMR/MMR-4.md', (raw) => raw.replace('Import', 'Imported'));
      expect(await refusalOf(target.store.import(document, { mode: 'resume' }))).toContain(
        'MMR/MMR-4.md',
      );
    },
  );
}
