import { beforeAll, describe, expect, test } from 'bun:test';

import { createProject, createTask, createInitiative, createPhase } from './create';
import { LocalEngine } from './engine';
import { bootPglite } from './store-postgres/testing';
import { backends, refusalOf } from './testing/conformance';

beforeAll(bootPglite);
describe.each(backends)('decision verbs ($name)', (backend) => {
  test('records an answer, links tasks and overturns atomically', async () => {
    const f = await backend.make();
    try {
      const engine = new LocalEngine(f.store);
      await createProject(f.store, { key: 'DEC', name: 'Decisions' });
      const initiative = await createInitiative(f.store, { projectId: 'DEC', title: 'Plan' });
      const phase = await createPhase(f.store, { parentId: initiative.id, title: 'Phase' });
      const task = await createTask(f.store, { parentId: phase.id, title: 'Build' });
      const d = await engine.decide({
        class: 'architecture',
        options: ['Here', 'There'],
        project: 'DEC',
        question: 'Where?',
        recommended: 1,
        tasks: [task.id],
      });
      expect(d.id).toBe('DEC-q1');
      expect(d.taken).toBe(1);
      expect(Object.keys(d)[0]).toBe('id');
      expect(Object.keys(d)).toEqual(Object.keys(await engine.getDecision({ id: d.id })));
      expect(d.history.map((r) => r.to_value)).toEqual(['linked']);
      expect((await engine.getNode({ id: task.id })).decisions).toEqual([
        { id: d.id, lifecycle: 'provisional' },
      ]);
      expect(await refusalOf(engine.decisionUpdate({ id: d.id, tasks: [task.id] }))).toContain(
        'linked',
      );
      const overturned = await engine.overturn({ id: d.id, note: 'Move', option: 2 });
      expect(overturned.lifecycle).toBe('overturned');
      const node = await engine.getNode({ facets: ['annotations'], id: task.id });
      expect(node.annotations?.map((a) => a.content)).toContain(
        'decision DEC-q1 overturned: option 2 (There): Move',
      );
      expect(await refusalOf(engine.confirm({ id: d.id }))).toContain('decide');
    } finally {
      await f.close();
    }
  });
});

describe.each(backends)('decision rules ($name)', (backend) => {
  async function fixture() {
    const f = await backend.make();
    const e = new LocalEngine(f.store);
    await createProject(f.store, { key: 'DEC', name: 'Decisions' });
    await createProject(f.store, { key: 'OTH', name: 'Other' });
    const parent = await createInitiative(f.store, { projectId: 'DEC', title: 'Plan' });
    const phase = await createPhase(f.store, { parentId: parent.id, title: 'Phase' });
    const a = await createTask(f.store, { parentId: phase.id, title: 'A' });
    const b = await createTask(f.store, { parentId: phase.id, title: 'B' });
    const delivery = await e.deliveryCreate({ phase: phase.id, tasks: [], title: 'Attempt' });
    const input = {
      class: 'product' as const,
      options: ['Here', 'There'],
      project: 'DEC',
      question: 'Where?',
      recommended: 1,
    };
    return { ...f, a, b, delivery, e, input, phase };
  }
  test('decide validates the entire input without allocating on refusal', async () => {
    const f = await fixture();
    try {
      const calls = [
        { ...f.input, question: ' ' },
        { ...f.input, options: ['One'] },
        { ...f.input, options: ['One', ' '] },
        { ...f.input, recommended: 0 },
        { ...f.input, taken: 3 },
        { ...f.input, project: undefined },
        { ...f.input, tasks: [f.a.id, f.a.id] },
        { ...f.input, tasks: [f.phase.id] },
        { ...f.input, tasks: [f.a.id, 'DEC-999'] },
        { ...f.input, delivery: f.delivery.id, project: 'OTH' },
        { ...f.input, delivery: 'DEC-d999' },
      ];
      const faults = [
        ['a decision requires a nonblank question', 'pass a question'],
        ['a decision requires at least two options', 'add another --option'],
        ['an option is blank', 'pass nonblank --option text'],
        ['option number is out of range', 'name a listed option'],
        ['option number is out of range', 'name a listed option'],
        ['a decision requires a project', 'pass --project KEY or --delivery KEY-dN'],
        ['a task is named twice', 'name each --task or --untask once'],
        [`${f.phase.id} must name a task in DEC`, 'pass a task in the decision project'],
        ['DEC-999 must name a task in DEC', 'pass a task in the decision project'],
        [
          `${f.delivery.id} must name a delivery in the same project`,
          'pass a same-project --delivery',
        ],
        ['DEC-d999 must name a delivery in the same project', 'pass a same-project --delivery'],
      ];
      for (const [i, input] of calls.entries()) {
        const refusal = await refusalOf(f.e.decide(input));
        expect(refusal).toEqual(faults[i]?.join(' — ') ?? 'missing expected refusal');
        expect(refusal).not.toContain('unexpected error');
      }
      expect((await f.store.export()).decisions).toEqual([]);
      const d = await f.e.decide({
        ...f.input,
        delivery: 'DEC-d01',
        project: undefined,
        tasks: [f.b.id, f.a.id],
        why: ' ',
      });
      for (const row of (await f.e.list({ project: 'DEC' })).items) {
        expect(row).not.toHaveProperty('decisions');
      }
      for (const row of (await f.e.next({ project: 'DEC' })).items) {
        expect(row).not.toHaveProperty('decisions');
      }
      expect(await f.e.status({ id: f.a.id })).not.toHaveProperty('decisions');
      expect(d.id).toBe('DEC-q1');
      expect(d.why).toBeNull();
      expect(d.tasks).toEqual([f.a.id, f.b.id]);
      expect(d.history.map((h) => [h.kind, h.task, h.from_value, h.to_value])).toEqual([
        ['link', f.a.id, null, 'linked'],
        ['link', f.b.id, null, 'linked'],
        ['delivery', null, null, f.delivery.id],
      ]);
      expect((await f.store.export()).transitions.some((r) => r.to_value === 'provisional')).toBe(
        false,
      );
      await f.e.deliveryAbandon({ id: f.delivery.id, reason: 'Stop' });
      expect(await refusalOf(f.e.decide({ ...f.input, delivery: f.delivery.id }))).toContain(
        'terminal',
      );
    } finally {
      await f.close();
    }
  });
  test('updates validate against the initial links and commit all or nothing', async () => {
    const f = await fixture();
    try {
      const d = await f.e.decide({ ...f.input, tasks: [f.a.id] });
      const faults = [
        ['empty decision update', 'pass --task, --untask, or --delivery'],
        [`${f.a.id} is already linked`, 'omit --task or use --untask'],
        [`${f.b.id} is not linked`, 'omit --untask or use --task'],
        ['a task is named twice', 'name each --task or --untask once'],
        ['a task is named twice', 'name each --task or --untask once'],
        ['task named under both --task and --untask', 'name each task once'],
        ['DEC-d999 must name a delivery in the same project', 'pass a same-project --delivery'],
        ['delivery is already set to that value', 'pass a different --delivery'],
      ];
      for (const [i, fields] of [
        {},
        { tasks: [f.a.id] },
        { untasks: [f.b.id] },
        { tasks: [f.b.id, f.b.id] },
        { untasks: [f.a.id, f.a.id] },
        { tasks: [f.b.id], untasks: [f.b.id] },
        { delivery: 'DEC-d999', tasks: [f.b.id] },
        { delivery: null },
      ].entries()) {
        const refusal = await refusalOf(f.e.decisionUpdate({ id: d.id, ...fields }));
        expect(refusal).toEqual(faults[i]?.join(' — ') ?? 'missing expected refusal');
        expect(refusal).not.toContain('unexpected error');
        expect(await f.e.getDecision({ id: d.id })).toEqual(d);
      }
      const updated = await f.e.decisionUpdate({
        delivery: 'DEC-d01',
        id: d.id,
        tasks: [f.b.id],
        untasks: [f.a.id],
      });
      expect(updated.tasks).toEqual([f.b.id]);
      const loaded = await f.e.getDecision({ id: d.id });
      expect(Object.keys(updated)).toEqual(Object.keys(loaded));
      expect(updated.history.map(Object.keys)).toEqual(loaded.history.map(Object.keys));
      expect(updated.history.slice(1).map((h) => h.to_value)).toEqual([
        'unlinked',
        'linked',
        f.delivery.id,
      ]);
      const refusal = await refusalOf(f.e.decisionUpdate({ delivery: 'DEC-d01', id: d.id }));
      expect(refusal).toBe('delivery is already set to that value — pass a different --delivery');
      expect(refusal).not.toContain('unexpected error');
      expect((await f.e.decisionUpdate({ delivery: null, id: d.id })).delivery).toBeNull();
    } finally {
      await f.close();
    }
  });
  test('confirm stores its note, annotates nothing, and freezes every write', async () => {
    const f = await fixture();
    try {
      const d = await f.e.decide({ ...f.input, tasks: [f.a.id] });
      const confirmed = await f.e.confirm({ id: d.id, note: '  accepted  ' });
      expect(confirmed.outcome_note).toBe('  accepted  ');
      expect(confirmed.history.at(-1)).toMatchObject({
        from_value: 'provisional',
        kind: 'lifecycle',
        reason: '  accepted  ',
        task: null,
        to_value: 'confirmed',
      });
      expect((await f.store.export()).annotations).toEqual([]);
      for (const write of [
        () => f.e.confirm({ id: d.id }),
        () => f.e.overturn({ id: d.id, note: 'No' }),
        () => f.e.decisionUpdate({ id: d.id, tasks: [f.b.id] }),
      ]) {
        expect(await refusalOf(write())).toContain('decide');
      }
    } finally {
      await f.close();
    }
  });
  test('overturn validates the answer and reaches done tasks with ordinary annotations', async () => {
    const f = await fixture();
    try {
      await f.e.start({ id: f.a.id });
      await f.e.done({ id: f.a.id });
      for (const answer of [{ option: 2 }, { note: 'Neither' }, { note: 'Move', option: 2 }]) {
        const d = await f.e.decide({ ...f.input, tasks: [f.b.id, f.a.id] });
        const faults = [
          'overturn requires an answer — pass --option N or a note',
          'overturn requires an answer — pass --option N or a note',
          'option is out of range — name a listed option',
          'option is out of range — name a listed option',
          'that is the answer taken — use confirm for the answer taken',
        ];
        for (const [i, invalid] of [
          {},
          { note: ' ' },
          { option: 0 },
          { option: 3 },
          { option: 1 },
        ].entries()) {
          const refusal = await refusalOf(f.e.overturn({ id: d.id, ...invalid }));
          expect(refusal).toEqual(faults[i] ?? 'missing expected refusal');
          expect(refusal).not.toContain('unexpected error');
        }
        const before = (await f.store.export()).nodes.filter((n) =>
          [f.a.id, f.b.id].includes(n.id),
        );
        await f.e.overturn({ id: d.id, ...answer });
        for (const prior of before) {
          expect(
            (await f.store.export()).nodes.find((n) => n.id === prior.id)?.updated_at,
          ).not.toBe(prior.updated_at);
        }
        expect((await f.e.getNode({ id: f.a.id })).lifecycle).toBe('done');
        expect((await f.e.getNode({ id: f.b.id })).lifecycle).toBe('todo');
        expect(
          (await f.store.export()).annotations.filter((a) =>
            a.content.startsWith(`decision ${d.id} overturned:`),
          ),
        ).toHaveLength(2);
        expect(await refusalOf(f.e.decisionUpdate({ id: d.id, untasks: [f.a.id] }))).toContain(
          'decide',
        );
      }
    } finally {
      await f.close();
    }
  });
  test('archived boards hide reads and refuse decision writes; numeric ids normalize', async () => {
    const f = await fixture();
    try {
      const d = await f.e.decide(f.input);
      expect((await f.e.getDecision({ id: 'DEC-q01' })).id).toBe(d.id);
      expect(await refusalOf(f.e.start({ id: d.id }))).toContain('decision');
      expect(await refusalOf(f.e.annotate({ content: 'note', id: d.id }))).toContain('decision');
      await f.e.archive({ id: 'DEC' });
      for (const write of [
        () => f.e.decide(f.input),
        () => f.e.confirm({ id: d.id }),
        () => f.e.overturn({ id: d.id, note: 'No' }),
        () => f.e.decisionUpdate({ delivery: null, id: d.id }),
      ]) {
        expect(await refusalOf(write())).toContain('archived');
      }
      expect(await refusalOf(f.e.getDecision({ id: d.id }))).toContain("doesn't exist");
    } finally {
      await f.close();
    }
  });
  test('a failure after the first overturn annotation rolls back all effects', async () => {
    const f = await fixture();
    try {
      const d = await f.e.decide({ ...f.input, tasks: [f.a.id, f.b.id] });
      const original = f.store.decisions.transact;
      f.store.decisions.transact = (id, apply) =>
        original(id, async (snapshot, w) => {
          let count = 0;
          const insert = w.insertAnnotation;
          w.insertAnnotation = async (row) => {
            await insert(row);
            if (++count === 2) {
              throw new Error('injected annotation failure');
            }
          };
          return apply(snapshot, w);
        });
      const failure = await f.e.overturn({ id: d.id, option: 2 }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(String(failure)).toContain('injected annotation failure');
      expect(await f.e.getDecision({ id: d.id })).toEqual(d);
      expect((await f.store.export()).annotations).toEqual([]);
    } finally {
      await f.close();
    }
  });
  test('every task lifecycle verb refuses decision ids with a behavioral remedy', async () => {
    const f = await fixture();
    try {
      const d = await f.e.decide(f.input);
      const calls = [
        () => f.e.start({ id: d.id }),
        () => f.e.submit({ id: d.id }),
        () => f.e.stage({ id: d.id }),
        () => f.e.done({ id: d.id }),
        () => f.e.reopen({ id: d.id }),
        () => f.e.return({ id: d.id }),
        () => f.e.abandon({ id: d.id, reason: 'No' }),
        () => f.e.block({ id: d.id, reason: 'No' }),
        () => f.e.unblock({ id: d.id }),
        () => f.e.park({ id: d.id, reason: 'Later' }),
        () => f.e.unpark({ id: d.id }),
        () => f.e.queue({ id: d.id, session: 'run' }),
        () => f.e.unqueue({ id: d.id, reason: 'No' }),
        () => f.e.archive({ id: d.id }),
        () => f.e.unarchive({ id: d.id }),
        () => f.e.groom({ ids: [d.id], state: 'groomed' }),
        () => f.e.tag({ ids: [d.id], tags: ['wrong'] }),
      ];
      for (const call of calls) {
        expect(await refusalOf(call())).toContain('confirm');
      }
    } finally {
      await f.close();
    }
  });
});
