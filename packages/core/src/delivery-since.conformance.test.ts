import { beforeAll, describe, expect, setSystemTime, test } from 'bun:test';

import { createInitiative, createPhase, createProject, createTask } from './create';
import { LocalEngine } from './engine';
import { archiveProject } from './mutations';
import { bootPglite } from './store-postgres/testing';
import { backends, errorOf } from './testing/conformance';

beforeAll(bootPglite);

const BASE = Date.UTC(2026, 10, 16, 9, 0, 0);
/** Move the process clock to `second` seconds past a fixed base, so each step has its own stamp. */
const step = (second: number): void => {
  setSystemTime(new Date(BASE + second * 1000));
};
const at = (second: number): Date => new Date(BASE + second * 1000);
const EPOCH = new Date('2000-01-01T00:00:00.000Z');

/** The one element of a list that must have exactly one. */
const only = <T>(items: T[]): T => {
  expect(items).toHaveLength(1);
  return items[0] as T;
};

describe.each(backends)('the since read ($name)', (backend) => {
  async function fixture() {
    const instance = await backend.make();
    const engine = new LocalEngine(instance.store);
    step(0);
    await createProject(instance.store, { key: 'SNC', name: 'Since' });
    await createProject(instance.store, { key: 'OTH', name: 'Other' });
    const initiative = await createInitiative(instance.store, { projectId: 'SNC', title: 'Plan' });
    const phase = await createPhase(instance.store, { parentId: initiative.id, title: 'Phase' });
    const tasks: string[] = [];
    for (const title of ['A', 'B', 'C']) {
      tasks.push((await createTask(instance.store, { parentId: phase.id, title })).id);
    }
    const [a, b, c] = tasks as [string, string, string];
    const delivery = await engine.deliveryCreate({
      agreement: 'Ship it',
      phase: phase.id,
      tasks: [a, b],
      title: 'Attempt',
    });
    return { ...instance, a, b, c, delivery: delivery.id, engine, phase: phase.id };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const feed = async (f: Fixture, since: Date = EPOCH) =>
    (await f.engine.deliverySince({ id: f.delivery, since })).events;

  /** Every source writes at least one event, each at its own second. */
  async function everySource(f: Fixture) {
    step(10);
    await f.engine.deliveryStart({ id: f.delivery });
    step(11);
    await f.engine.deliveryBlock({ id: f.delivery, reason: 'wait' });
    step(12);
    await f.engine.deliveryUnblock({ id: f.delivery });
    step(13);
    await f.engine.deliveryLimitation({ id: f.delivery, text: 'an edge' });
    step(14);
    await f.engine.deliveryDecline({ finding: 'a finding', id: f.delivery, reason: 'later' });
    step(15);
    await f.engine.start({ harness: 'codex', id: f.a, session: 's' });
    step(16);
    await f.engine.annotate({ content: 'a note', id: f.a });
    step(17);
    await f.engine.itemAdd({ content: 'first', task: f.a });
    await f.engine.itemAdd({ content: 'second', task: f.a });
    step(18);
    await f.engine.itemCheck({ number: 1, task: f.a });
    step(19);
    await f.engine.itemDrop({ number: 2, reason: 'moot', task: f.a });
    step(20);
    const decision = await f.engine.decide({
      class: 'architecture',
      delivery: f.delivery,
      options: ['Here', 'There'],
      project: 'SNC',
      question: 'Where?',
      recommended: 1,
    });
    step(21);
    await f.engine.decisionUpdate({ id: decision.id, tasks: [f.b] });
    step(22);
    await f.engine.confirm({ id: decision.id });
    step(23);
    const pad = await f.engine.scratchCreate({
      anchors: [f.delivery],
      project: 'SNC',
      title: 'Journal',
    });
    const frozen = await f.engine.scratchFreeze({
      expectedUpdatedAt: pad.updatedAt,
      id: pad.id,
      summary: 'run journal',
    });
    return { decision: decision.id, frozen: frozen.id };
  }

  test('every source reports its events, with the kind, fields, and id the contract names', async () => {
    const f = await fixture();
    try {
      const { decision, frozen } = await everySource(f);
      const read = await f.engine.deliverySince({ id: f.delivery, since: EPOCH });
      const byKind = (kind: string, record?: string) =>
        read.events.filter((e) => e.kind === kind && (record === undefined || e.record === record));
      // The delivery's history: joins, then the start and the hold round trip.
      expect(
        byKind('member').map((e) => [e.task, e.to, e.id.startsWith('SNC-d1/history/')]),
      ).toEqual([
        [f.a, 'joined', true],
        [f.b, 'joined', true],
      ]);
      expect(byKind('lifecycle', f.delivery).map((e) => [e.from, e.to])).toEqual([
        ['agreed', 'running'],
      ]);
      expect(byKind('hold').map((e) => [e.from, e.to, e.reason])).toEqual([
        ['none', 'stopped', 'wait'],
        ['stopped', 'none', null],
      ]);
      expect(only(byKind('limitation'))).toMatchObject({
        from: null,
        id: 'SNC-d1/finding/1',
        number: 1,
        reason: null,
        record: f.delivery,
        task: null,
        text: 'an edge',
        to: null,
      });
      expect(only(byKind('declined'))).toMatchObject({
        id: 'SNC-d1/finding/2',
        number: 2,
        reason: 'later',
        text: 'a finding',
      });
      // A member task's own rows.
      expect(only(byKind('lifecycle', f.a))).toMatchObject({
        from: 'todo',
        id: expect.stringMatching(new RegExp(`^${f.a}/transition/\\d+$`)),
        to: 'in_progress',
      });
      expect(only(byKind('note'))).toMatchObject({
        id: expect.stringMatching(new RegExp(`^${f.a}/note/\\d+$`)),
        record: f.a,
        text: 'a note',
      });
      expect(byKind('item').map((e) => [e.id, e.number, e.from, e.to, e.text, e.reason])).toEqual([
        [`${f.a}/item/1/added`, 1, null, 'open', 'first', null],
        [`${f.a}/item/2/added`, 2, null, 'open', 'second', null],
        [`${f.a}/item/1/settled`, 1, 'open', 'checked', 'first', null],
        [`${f.a}/item/2/settled`, 2, 'open', 'dropped', 'second', 'moot'],
      ]);
      // A decision, its history, and the frozen journal.
      expect(only(byKind('decided'))).toMatchObject({
        id: `${decision}/decided`,
        record: decision,
        text: 'Where?',
      });
      expect(byKind('lifecycle', decision).map((e) => [e.from, e.to])).toEqual([
        ['provisional', 'confirmed'],
      ]);
      expect(only(byKind('link'))).toMatchObject({ record: decision, task: f.b });
      expect(only(byKind('delivery'))).toMatchObject({
        from: null,
        record: decision,
        to: f.delivery,
      });
      expect(only(byKind('journal'))).toMatchObject({
        id: `${frozen}/journal`,
        record: frozen,
        text: 'Journal',
      });
      // Time order, with the delivery's snapshot as `get` reads it.
      const times = read.events.map((e) => e.at.getTime());
      expect(times).toEqual(times.toSorted((x, y) => x - y));
      expect(read.delivery).toEqual(await f.engine.getDelivery({ id: f.delivery }));
      expect(read.since).toEqual(EPOCH);
      expect(new Set(read.events.map((e) => e.id)).size).toBe(read.events.length);
    } finally {
      setSystemTime();
      await f.close();
    }
  });

  test('selection is strictly after since, and the cursor lags the clock by five seconds', async () => {
    const f = await fixture();
    try {
      step(10);
      await f.engine.deliveryLimitation({ id: f.delivery, text: 'one' });
      step(20);
      await f.engine.deliveryLimitation({ id: f.delivery, text: 'two' });
      const [one, two] = (await feed(f)).filter((e) => e.kind === 'limitation');
      expect(one?.kind).toBe('limitation');
      // An event exactly at since is not after it.
      const atOne = await feed(f, one?.at);
      expect(atOne.map((e) => e.id)).toEqual([two?.id as string]);
      expect((await feed(f, two?.at)).filter((e) => e.kind === 'limitation')).toEqual([]);
      step(60);
      const read = await f.engine.deliverySince({ id: f.delivery, since: at(0) });
      // as_of is the clock less the settle window.
      expect(Math.abs(read.as_of.getTime() - at(55).getTime())).toBeLessThan(2000);
      // ... and never earlier than since.
      const late = await f.engine.deliverySince({ id: f.delivery, since: at(59) });
      expect(late.as_of.getTime()).toBe(at(59).getTime());
      const ahead = await f.engine.deliverySince({ id: f.delivery, since: at(600) });
      expect(ahead.as_of.getTime()).toBe(at(600).getTime());
    } finally {
      setSystemTime();
      await f.close();
    }
  });

  test('an event stamped later than the reader’s clock is included, and as_of does not move past it', async () => {
    const f = await fixture();
    try {
      step(3600);
      await f.engine.deliveryLimitation({ id: f.delivery, text: 'from a fast clock' });
      step(30);
      const read = await f.engine.deliverySince({ id: f.delivery, since: at(5) });
      expect(read.events.map((e) => e.kind)).toEqual(['limitation']);
      expect(read.as_of.getTime()).toBeLessThan(at(3600).getTime());
    } finally {
      setSystemTime();
      await f.close();
    }
  });

  test('an event before a task joined and one after it left are excluded; a rejoin gives two spans', async () => {
    const f = await fixture();
    try {
      step(5);
      await f.engine.annotate({ content: 'while a member (before the leave)', id: f.a });
      step(10);
      await f.engine.update({ delivery: null, id: f.a });
      step(15);
      await f.engine.annotate({ content: 'not a member', id: f.a });
      step(20);
      await f.engine.update({ delivery: f.delivery, id: f.a });
      step(25);
      await f.engine.annotate({ content: 'a member again', id: f.a });
      step(30);
      // A task that never joined adds nothing.
      await f.engine.annotate({ content: 'stranger', id: f.c });
      const notes = (await feed(f)).filter((e) => e.kind === 'note').map((e) => e.text);
      expect(notes).toEqual(['while a member (before the leave)', 'a member again']);
      // Its join and leave rows still read, as the delivery's own history.
      expect((await feed(f)).filter((e) => e.kind === 'member').map((e) => [e.task, e.to])).toEqual(
        [
          [f.a, 'joined'],
          [f.b, 'joined'],
          [f.a, 'left'],
          [f.a, 'joined'],
        ],
      );
    } finally {
      setSystemTime();
      await f.close();
    }
  });

  test('a delivery abandon releases its members; their later events are not in the feed', async () => {
    const f = await fixture();
    try {
      step(5);
      await f.engine.deliveryAbandon({ id: f.delivery, reason: 'drop it' });
      step(10);
      await f.engine.annotate({ content: 'after the release', id: f.a });
      const events = await feed(f);
      expect(events.filter((e) => e.kind === 'member').map((e) => e.to)).toEqual([
        'joined',
        'joined',
        'released',
        'released',
      ]);
      expect(events.some((e) => e.kind === 'note')).toBe(false);
    } finally {
      setSystemTime();
      await f.close();
    }
  });

  test('a task abandon reads with its abandon row and reason, and nothing after it', async () => {
    const f = await fixture();
    try {
      step(5);
      await f.engine.abandon({ id: f.a, reason: 'not needed' });
      step(10);
      await f.engine.annotate({ content: 'late note', id: f.a });
      const events = await feed(f);
      expect(events.filter((e) => e.kind === 'member' && e.task === f.a).map((e) => e.to)).toEqual([
        'joined',
        'abandoned',
      ]);
      expect(
        events
          .filter((e) => e.record === f.a)
          .map((e) => [e.kind, e.to, e.reason, e.id.startsWith(`${f.a}/transition/`)]),
      ).toEqual([['lifecycle', 'abandoned', 'not needed', true]]);
    } finally {
      setSystemTime();
      await f.close();
    }
  });

  test('landing includes the members’ done rows and excludes a later reopen’s annotation', async () => {
    const f = await fixture();
    try {
      step(5);
      await f.engine.update({ delivery: null, id: f.b });
      await f.engine.deliveryStart({ id: f.delivery });
      step(10);
      await f.engine.start({ harness: 'codex', id: f.a, session: 's' });
      await f.engine.submit({ id: f.a });
      await f.engine.stage({ id: f.a });
      await f.engine.deliverySubmit({ id: f.delivery });
      step(20);
      await f.engine.deliveryLand({ id: f.delivery });
      step(30);
      await f.engine.reopen({ id: f.a });
      await f.engine.annotate({ content: 'after the reopen', id: f.a });
      const events = await feed(f);
      expect(events.filter((e) => e.record === f.a && e.to === 'done')).toHaveLength(1);
      expect(events.some((e) => e.kind === 'note')).toBe(false);
      // The landed delivery's own row is last of its lifecycle rows.
      expect(events.findLast((e) => e.record === f.delivery && e.kind === 'lifecycle')?.to).toBe(
        'landed',
      );
      expect(events.some((e) => e.record === f.a && e.to === 'ready')).toBe(false);
    } finally {
      setSystemTime();
      await f.close();
    }
  });

  test('a current member’s later event is included', async () => {
    const f = await fixture();
    try {
      step(5);
      await f.engine.annotate({ content: 'first', id: f.b });
      step(50);
      await f.engine.annotate({ content: 'much later', id: f.b });
      expect((await feed(f, at(10))).map((e) => e.text)).toEqual(['much later']);
    } finally {
      setSystemTime();
      await f.close();
    }
  });

  test('a decision moved to another delivery shows its delivery rows and nothing after', async () => {
    const f = await fixture();
    try {
      const other = await f.engine.deliveryCreate({ phase: f.phase, tasks: [], title: 'Other' });
      step(5);
      const decision = await f.engine.decide({
        class: 'product',
        delivery: f.delivery,
        options: ['x', 'y'],
        project: 'SNC',
        question: 'Q?',
        recommended: 1,
      });
      step(10);
      await f.engine.decisionUpdate({ delivery: other.id, id: decision.id });
      step(15);
      await f.engine.confirm({ id: decision.id });
      const events = (await feed(f)).filter((e) => e.record === decision.id);
      // The decided event is not shown: the decision is not linked here now.
      expect(events.map((e) => [e.kind, e.from, e.to])).toEqual([
        ['delivery', null, f.delivery],
        ['delivery', f.delivery, other.id],
      ]);
      // The other delivery sees it arrive and every event after.
      const there = (await f.engine.deliverySince({ id: other.id, since: EPOCH })).events.filter(
        (e) => e.record === decision.id,
      );
      expect(there.map((e) => e.kind)).toEqual(['decided', 'delivery', 'delivery', 'lifecycle']);
    } finally {
      setSystemTime();
      await f.close();
    }
  });

  test('a delivery id of another kind is validation, a missing delivery is not_found, an archived board hides it', async () => {
    const f = await fixture();
    try {
      expect((await errorOf(f.engine.deliverySince({ id: f.a, since: EPOCH }))).code).toBe(
        'validation',
      );
      expect((await errorOf(f.engine.deliverySince({ id: 'SNC-d99', since: EPOCH }))).code).toBe(
        'not_found',
      );
      await archiveProject(f.store, 'SNC');
      expect((await errorOf(f.engine.deliverySince({ id: f.delivery, since: EPOCH }))).code).toBe(
        'not_found',
      );
    } finally {
      setSystemTime();
      await f.close();
    }
  });
});
