/* oxlint-disable no-map-spread -- each fixture is an independent copy of valid history. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { DecisionView } from '@mimir/contract';

import { createProject, createInitiative, createTask, createPhase } from './create';
import { decisionFaults } from './decisions/validate';
import { LocalEngine } from './engine';
import { bootPglite } from './store-postgres/testing';
import { backends, refusalOf, withoutStamp } from './testing/conformance';

beforeAll(bootPglite);
describe.each(backends)('decision transfer ($name)', (backend) => {
  // One source store holds every record the cases read; each test then imports
  // into its own target, so no test pays for building the fixture again.
  let source: Awaited<ReturnType<typeof backend.make>>;
  let document: Awaited<ReturnType<typeof source.store.export>>;
  let task: Awaited<ReturnType<typeof createTask>>;
  let parent: Awaited<ReturnType<typeof createInitiative>>;
  let otherTask: Awaited<ReturnType<typeof createTask>>;
  let otherDelivery: Awaited<ReturnType<LocalEngine['deliveryCreate']>>;

  beforeAll(async () => {
    source = await backend.make();
    const e = new LocalEngine(source.store);
    await createProject(source.store, { key: 'DEC', name: 'Decisions' });
    parent = await createInitiative(source.store, { projectId: 'DEC', title: 'Plan' });
    task = await createTask(source.store, { parentId: parent.id, title: 'Build' });
    const d = await e.decide({
      class: 'other',
      options: ['Here', 'There'],
      project: 'DEC',
      question: 'Where?',
      recommended: 1,
      tasks: [task.id],
    });
    await e.overturn({ id: d.id, note: 'Move', option: 2 });
    await createProject(source.store, { key: 'OTH', name: 'Other' });
    const otherParent = await createInitiative(source.store, {
      projectId: 'OTH',
      title: 'Other',
    });
    otherTask = await createTask(source.store, {
      parentId: otherParent.id,
      title: 'Other task',
    });
    const otherPhase = await createPhase(source.store, {
      parentId: otherParent.id,
      title: 'Other phase',
    });
    otherDelivery = await e.deliveryCreate({
      phase: otherPhase.id,
      tasks: [],
      title: 'Other delivery',
    });
    document = await source.store.export();
  });

  afterAll(async () => {
    await source.close();
  });

  test('round trip preserves decisions, ordered history and allocation', async () => {
    const target = await backend.make();
    try {
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
    } finally {
      await target.close();
    }
  });

  test('each invalid document is refused alone and writes nothing', async () => {
    const fresh = await backend.make();
    try {
      const original = document.decisions[0];
      if (!original) {
        throw new Error('missing decision');
      }
      const provisional: DecisionView = {
        ...original,
        history: original.history.filter((h) => h.kind !== 'lifecycle'),
        lifecycle: 'provisional',
        outcome_note: null,
        overturn_option: null,
      };
      const confirmed: DecisionView = {
        ...original,
        history: original.history.map((h) =>
          h.kind === 'lifecycle' ? { ...h, to_value: 'confirmed' } : h,
        ),
        lifecycle: 'confirmed',
        overturn_option: null,
      };
      const history = (patch: Partial<DecisionView['history'][number]>) =>
        provisional.history.map((h) => ({ ...h, ...patch }));
      const cases: [string, DecisionView, string][] = [
        [
          'blank question',
          { ...provisional, question: ' ' },
          'requires a question and at least two nonblank options',
        ],
        [
          'one option',
          { ...provisional, options: ['One'] },
          'requires a question and at least two nonblank options',
        ],
        [
          'blank option',
          { ...provisional, options: ['One', ' '] },
          'requires a question and at least two nonblank options',
        ],
        ['blank why', { ...provisional, why: ' ' }, 'blank optional text must be null'],
        [
          'blank outcome note',
          {
            ...confirmed,
            history: confirmed.history.map((h) =>
              h.kind === 'lifecycle' ? { ...h, reason: ' ' } : h,
            ),
            outcome_note: ' ',
          },
          'blank optional text must be null',
        ],
        ['recommend range', { ...provisional, recommended: 0 }, 'option out of range'],
        ['taken range', { ...provisional, taken: 3 }, 'option out of range'],
        [
          'other project delivery',
          { ...provisional, delivery: otherDelivery.id },
          'delivery missing or in another project',
        ],
        [
          'other project task',
          { ...provisional, tasks: [otherTask.id] },
          `link ${otherTask.id} must name a same-project task`,
        ],
        [
          'non-task link',
          { ...provisional, tasks: [parent.id] },
          `link ${parent.id} must name a same-project task`,
        ],
        [
          'duplicate link pair',
          { ...provisional, tasks: [task.id, task.id] },
          'duplicate task link',
        ],
        [
          'non-link history task',
          {
            ...confirmed,
            history: confirmed.history.map((h) =>
              h.kind === 'lifecycle' ? { ...h, task: task.id } : h,
            ),
          },
          'only link history names a task',
        ],
        [
          'link without task',
          { ...provisional, history: history({ task: null }) },
          'invalid link history',
        ],
        [
          'tasks disagree with link history',
          { ...provisional, tasks: [] },
          'tasks disagree with link history',
        ],
        [
          'link history naming another project task',
          {
            ...provisional,
            history: provisional.history.map((h) =>
              h.kind === 'link' ? { ...h, task: otherTask.id } : h,
            ),
          },
          'invalid link history',
        ],
        [
          'link with from value',
          { ...provisional, history: history({ from_value: 'linked' }) },
          'invalid link history',
        ],
        ...['DEC-d999', otherDelivery.id].map((id): [string, DecisionView, string] => [
          `invalid delivery history ${id}`,
          {
            ...provisional,
            history: [
              ...provisional.history,
              {
                at: original.created_at,
                from_value: null,
                kind: 'delivery',
                reason: null,
                task: null,
                to_value: id,
              },
            ],
          },
          'invalid delivery history',
        ]),
        [
          'confirmed overturn option',
          { ...confirmed, overturn_option: 2 },
          'confirmed decision has overturn_option',
        ],
        [
          'overturn taken',
          { ...original, overturn_option: original.taken },
          'invalid overturn answer',
        ],
        [
          'overturn without answer',
          {
            ...original,
            history: original.history.map((h) =>
              h.kind === 'lifecycle' ? { ...h, reason: null } : h,
            ),
            outcome_note: null,
            overturn_option: null,
          },
          'invalid overturn answer',
        ],
        [
          'provisional lifecycle',
          {
            ...provisional,
            history: [
              ...provisional.history,
              {
                at: original.created_at,
                from_value: 'provisional',
                kind: 'lifecycle',
                reason: null,
                task: null,
                to_value: 'confirmed',
              },
            ],
          },
          'provisional decision has outcome or lifecycle history',
        ],
        [
          'terminal no lifecycle',
          { ...original, history: provisional.history },
          'terminal decision requires exactly one matching lifecycle history row',
        ],
        [
          'terminal two lifecycle rows',
          {
            ...original,
            history: [
              ...original.history,
              ...original.history.filter((h) => h.kind === 'lifecycle'),
            ],
          },
          'terminal decision requires exactly one matching lifecycle history row',
        ],
        [
          'different lifecycle reason',
          {
            ...original,
            history: original.history.map((h) =>
              h.kind === 'lifecycle' ? { ...h, reason: 'Different' } : h,
            ),
          },
          'terminal decision requires exactly one matching lifecycle history row',
        ],
        [
          'sequence above counter',
          { ...provisional, id: 'DEC-q2', seq: 2 },
          'sequence exceeds project counter',
        ],
      ];
      for (const [name, decision, message] of cases) {
        const invalid = { ...document, decisions: [decision] };
        expect(decisionFaults(invalid), name).toEqual([{ id: decision.id, message }]);
        const refusal = await refusalOf(
          fresh.store.import(invalid, { dryRun: false, mode: 'fresh' }),
        );
        expect(refusal, name).toContain(`${decision.id} ${message}`);
        expect(refusal).toContain('repair the document before importing it');
        expect(refusal).not.toContain('unexpected error');
        expect((await fresh.store.export()).projects, name).toEqual([]);
      }
    } finally {
      await fresh.close();
    }
  });

  test('a resume matches a decision whose links the document lists out of order', async () => {
    const own = await backend.make();
    const target = await backend.make();
    try {
      await createProject(own.store, { key: 'ORD', name: 'Order' });
      const root = await createInitiative(own.store, { projectId: 'ORD', title: 'Plan' });
      const first = await createTask(own.store, { parentId: root.id, title: 'First' });
      const second = await createTask(own.store, { parentId: root.id, title: 'Second' });
      await new LocalEngine(own.store).decide({
        class: 'other',
        options: ['A', 'B'],
        project: 'ORD',
        question: 'Which?',
        recommended: 1,
        tasks: [first.id, second.id],
      });
      const reversed = structuredClone(await own.store.export());
      for (const decision of reversed.decisions) {
        decision.tasks.reverse();
      }
      await target.store.import(reversed, { dryRun: false, mode: 'fresh' });
      await target.store.import(reversed, { dryRun: false, mode: 'resume' });
      expect((await target.store.export()).decisions[0]?.tasks).toEqual([first.id, second.id]);
    } finally {
      await own.close();
      await target.close();
    }
  });

  test('an export from before decisions imports with none and a zero counter', async () => {
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
  });
});
