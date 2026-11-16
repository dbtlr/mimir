import { beforeAll, describe, expect, setSystemTime, test } from 'bun:test';

import { createInitiative, createPhase, createProject } from './create';
import { LocalEngine } from './engine';
import { bootPglite } from './store-postgres/testing';
import { backends } from './testing/conformance';

beforeAll(bootPglite);
describe.each(backends)('needs-you reads ($name)', (backend) => {
  test('loads stopped deliveries and provisional decisions across active projects once', async () => {
    const f = await backend.make();
    try {
      const e = new LocalEngine(f.store);
      for (const key of ['NEW', 'OLD']) {
        await createProject(f.store, { key, name: key });
        const i = await createInitiative(f.store, { projectId: key, title: 'Plan' });
        const p = await createPhase(f.store, { parentId: i.id, title: 'Phase' });
        const d = await e.deliveryCreate({ phase: p.id, title: key });
        await e.deliveryBlock({ id: d.id, reason: 'Help' });
        await e.decide({
          class: 'other',
          options: ['A', 'B'],
          project: key,
          question: key,
          recommended: 1,
        });
      }
      const phase = 'NEW-2';
      const paused = await e.deliveryCreate({ phase, tasks: [], title: 'Paused' });
      await e.deliveryPark({ id: paused.id, reason: 'Later' });
      const terminal = await e.deliveryCreate({ phase, tasks: [], title: 'Ended' });
      await e.deliveryAbandon({ id: terminal.id, reason: 'Gone' });
      for (const lifecycle of ['confirmed', 'overturned'] as const) {
        const q = await e.decide({
          class: 'other',
          options: ['A', 'B'],
          project: 'NEW',
          question: lifecycle,
          recommended: 1,
        });
        if (lifecycle === 'confirmed') {
          await e.confirm({ id: q.id });
        } else {
          await e.overturn({ id: q.id, option: 2 });
        }
      }
      await e.archive({ id: 'OLD' });
      expect((await f.store.deliveries.listStopped()).map((d) => d.key)).toEqual(['NEW']);
      expect((await f.store.decisions.listProvisional()).map((d) => d.project_key)).toEqual([
        'NEW',
      ]);
      let deliveries = 0;
      let decisions = 0;
      const stopped = f.store.deliveries.listStopped;
      const provisional = f.store.decisions.listProvisional;
      f.store.deliveries.listStopped = () => {
        deliveries++;
        return stopped();
      };
      f.store.decisions.listProvisional = () => {
        decisions++;
        return provisional();
      };
      const report = await e.console.review({ timeZone: 'UTC' });
      expect(report.needsYou[0]?.rows.map((r) => r.kind)).toEqual(['delivery', 'decision']);
      expect(report.queue).toEqual([
        { id: 'NEW-d1', kind: 'delivery' },
        { id: 'NEW-q1', kind: 'decision' },
      ]);
      expect([deliveries, decisions]).toEqual([1, 1]);
      await e.console.projectWork({ project: 'NEW', timeZone: 'UTC' });
      expect([deliveries, decisions]).toEqual([2, 2]);
    } finally {
      await f.close();
    }
  });
});

test('five kinds use their own clocks; abandoned-only links carry no work; work scopes include delivery-only decisions', async () => {
  const f = await backends.find((b) => b.name === 'sqlite')!.make();
  try {
    const e = new LocalEngine(f.store);
    await createProject(f.store, { key: 'SET', name: 'Set' });
    const i = await createInitiative(f.store, { projectId: 'SET', title: 'I' });
    const p = await createPhase(f.store, { parentId: i.id, title: 'P' });
    const other = await createPhase(f.store, { parentId: i.id, title: 'Other' });
    const task = await e.create({ parent: p.id, title: 'Blocked', type: 'task' });
    const ask = await e.create({ parent: p.id, title: 'Question', type: 'task' });
    const abandoned = await e.create({ parent: p.id, title: 'Abandoned', type: 'task' });
    await e.abandon({ id: abandoned.id, reason: 'Gone' });
    await e.block({ id: task.id, on: 'you', reason: 'Help' });
    await e.groom({ ids: [ask.id], note: 'Which path?', state: 'needs_answers' });
    const d = await e.deliveryCreate({ phase: p.id, tasks: [], title: 'Stopped' });
    await e.deliveryBlock({ id: d.id, reason: 'Help' });
    const running = await e.deliveryCreate({ phase: p.id, tasks: [], title: 'No members' });
    let tick = 0;
    const decide = (question: string, tasks?: string[], delivery?: string) => {
      setSystemTime(new Date(1800000000000 + tick++ * 1000));
      return e.decide({
        class: 'other',
        delivery,
        options: ['A', 'B'],
        project: 'SET',
        question,
        recommended: 1,
        tasks,
      });
    };
    const empty = await decide('No work');
    const risk = await decide('Work at risk', [task.id], d.id);
    const gone = await decide('Only abandoned', [abandoned.id]);
    const scoped = await decide('Delivery only', [], running.id);
    const confirmed = await decide('Confirmed');
    await e.confirm({ id: confirmed.id });
    const overturned = await decide('Overturned');
    await e.overturn({ id: overturned.id, option: 2 });
    const paused = await e.deliveryCreate({ phase: other.id, tasks: [], title: 'Paused' });
    await e.deliveryPark({ id: paused.id, reason: 'Later' });
    const ended = await e.deliveryCreate({ phase: other.id, tasks: [], title: 'Ended' });
    await e.deliveryAbandon({ id: ended.id, reason: 'Gone' });
    const report = await e.console.review({ timeZone: 'UTC' });
    expect(report.queue.map((r) => r.id)).toEqual([
      d.id,
      risk.id,
      task.id,
      ask.id,
      scoped.id,
      gone.id,
      empty.id,
    ]);
    const rows = report.needsYou.flatMap((g) => g.rows);
    expect(
      rows.filter((r) => r.kind === 'decision').map((r) => [r.decision.id, r.workBuiltOnIt]),
    ).toEqual([
      [risk.id, true],
      [scoped.id, false],
      [gone.id, false],
      [empty.id, false],
    ]);
    for (const id of [p.id, i.id, 'SET']) {
      const work =
        id === 'SET'
          ? await e.console.projectWork({ project: id, timeZone: 'UTC' })
          : await e.console.nodeWork({ id, timeZone: 'UTC' });
      expect(work.needsYou).toEqual(
        id === 'SET'
          ? rows
          : rows.filter((r) => r.kind !== 'decision' || r.decision.id !== empty.id),
      );
    }
    expect((await e.console.nodeWork({ id: other.id, timeZone: 'UTC' })).needsYou).toEqual([]);
    const page = await e.console.deliveryPage({ id: d.id });
    expect(page.decisions.map((q) => q.id)).toEqual([risk.id]);
  } finally {
    setSystemTime();
    await f.close();
  }
});

test('project urgency uses leading kind, its clock, then project key', async () => {
  const f = await backends.find((b) => b.name === 'sqlite')!.make();
  try {
    const e = new LocalEngine(f.store);
    for (const [key, day] of [
      ['AAA', 1],
      ['EEE', 2],
      ['BBB', 2],
      ['CCC', 3],
    ] as const) {
      setSystemTime(new Date(`2026-11-0${day}T12:00:00Z`));
      await createProject(f.store, { key, name: key });
      const i = await createInitiative(f.store, { projectId: key, title: 'I' });
      const p = await createPhase(f.store, { parentId: i.id, title: 'P' });
      if (key === 'CCC') {
        const t = await e.create({ parent: p.id, title: 'Work', type: 'task' });
        await e.decide({
          class: 'other',
          options: ['A', 'B'],
          project: key,
          question: 'At risk',
          recommended: 1,
          tasks: [t.id],
        });
      } else {
        const d = await e.deliveryCreate({ phase: p.id, tasks: [], title: 'Run' });
        await e.deliveryBlock({ id: d.id, reason: 'Help' });
      }
    }
    expect(
      (await e.console.review({ timeZone: 'UTC' })).needsYou.map((g) => g.project.key),
    ).toEqual(['BBB', 'EEE', 'AAA', 'CCC']);
  } finally {
    setSystemTime();
    await f.close();
  }
});
