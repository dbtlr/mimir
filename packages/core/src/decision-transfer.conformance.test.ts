import { beforeAll, describe, expect, test } from 'bun:test';

import type { DecisionView } from '@mimir/contract';

import { createProject, createInitiative, createTask } from './create';
import { LocalEngine } from './engine';
import { bootPglite } from './store-postgres/testing';
import { backends, refusalOf, withoutStamp } from './testing/conformance';

beforeAll(bootPglite);
describe.each(backends)('decision transfer ($name)', (backend) => {
  test('round trip preserves decisions, ordered history and allocation; invalid documents write nothing', async () => {
    const source = await backend.make();
    const target = await backend.make();
    try {
      const e = new LocalEngine(source.store);
      await createProject(source.store, { key: 'DEC', name: 'Decisions' });
      const parent = await createInitiative(source.store, { projectId: 'DEC', title: 'Plan' });
      const task = await createTask(source.store, { parentId: parent.id, title: 'Build' });
      const d = await e.decide({
        class: 'other',
        options: ['Here', 'There'],
        project: 'DEC',
        question: 'Where?',
        recommended: 1,
        tasks: [task.id],
      });
      await e.overturn({ id: d.id, note: 'Move', option: 2 });
      const document = await source.store.export();
      await target.store.import(document, { dryRun: false, mode: 'fresh' });
      expect(withoutStamp(await target.store.export())).toEqual(withoutStamp(document));
      expect(
        (
          await new LocalEngine(target.store).decide({
            class: 'product',
            options: ['Yes', 'No'],
            project: 'DEC',
            question: 'Next?',
            recommended: 2,
          })
        ).id,
      ).toBe('DEC-q2');
      const original = document.decisions[0];
      if (!original) {
        throw new Error('missing decision');
      }
      const mutations: Partial<DecisionView>[] = [
        { question: ' ' },
        { options: ['One'] },
        { options: ['One', ' '] },
        { why: ' ' },
        { recommended: 0 },
        { taken: 3 },
        { delivery: 'DEC-d999' },
        { tasks: ['DEC-999'] },
        { tasks: [parent.id] },
        { tasks: [task.id, task.id] },
        { overturn_option: 1 },
        { outcome_note: null, overturn_option: null },
        { outcome_note: ' ' },
        { history: [] },
        { lifecycle: 'provisional' },
        { lifecycle: 'confirmed' },
        { history: original.history.map((h) => ({ ...h, task: null })) },
        {
          history: original.history.map((h) =>
            h.kind === 'lifecycle' ? { ...h, reason: 'Different' } : h,
          ),
        },
        { id: 'DEC-q2', seq: 2 },
      ];
      for (const patch of mutations) {
        const fresh = await backend.make();
        try {
          expect(
            await refusalOf(
              fresh.store.import(
                { ...document, decisions: [{ ...original, ...patch }] },
                { dryRun: false, mode: 'fresh' },
              ),
            ),
          ).toBeTruthy();
          expect((await fresh.store.export()).projects).toEqual([]);
        } finally {
          await fresh.close();
        }
      }
      const legacy = await backend.make();
      try {
        const { decisions: _decisions, ...old } = document;
        await legacy.store.import(
          {
            ...old,
            projects: old.projects.map((p) => {
              const copy = structuredClone(p);
              return Object.assign(copy, {
                counters: {
                  artifact: p.counters.artifact,
                  delivery: p.counters.delivery,
                  node: p.counters.node,
                  seed: p.counters.seed,
                },
              });
            }),
            schema_version: 10,
          },
          { dryRun: false, mode: 'fresh' },
        );
        expect((await legacy.store.export()).decisions).toEqual([]);
        expect((await legacy.store.export()).projects[0]?.counters.decision).toBe(0);
      } finally {
        await legacy.close();
      }
    } finally {
      await source.close();
      await target.close();
    }
  }, 30000);
});
