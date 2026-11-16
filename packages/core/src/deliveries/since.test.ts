import { describe, expect, test } from 'bun:test';

import { asOf, compareEvents, feedOf, inSpans, memberSpans, SETTLE_WINDOW_MS } from './since';
import type { SinceSources } from './since';

const D = 'MMR-d1';
const at = (second: number, ms = 0): string =>
  new Date(Date.UTC(2026, 10, 16, 9, 0, second, ms)).toISOString();

/** A source set with nothing in it; each test fills only what it exercises. */
const empty = (): SinceSources => ({
  decisionHistory: [],
  decisions: [],
  delivery: D,
  findings: [],
  followUps: [],
  history: [],
  items: [],
  journals: [],
  notes: [],
  transitions: [],
});

const member = (
  id: number,
  second: number,
  task: string,
  to: 'joined' | 'left' | 'released' | 'abandoned',
): SinceSources['history'][number] => ({
  at: at(second),
  from_value: null,
  id,
  kind: 'member',
  reason: null,
  task,
  to_value: to,
});

const lifecycle = (
  id: number,
  second: number,
  to: string,
  from: string | null = null,
): SinceSources['history'][number] => ({
  at: at(second),
  from_value: from,
  id,
  kind: 'lifecycle',
  reason: null,
  task: null,
  to_value: to,
});

describe('settle window', () => {
  test('as_of is the clock minus five seconds', () => {
    const clock = new Date(at(30));
    expect(SETTLE_WINDOW_MS).toBe(5000);
    expect(asOf(clock, new Date(at(0))).toISOString()).toBe(at(25));
  });

  test('as_of is never earlier than since', () => {
    expect(asOf(new Date(at(30)), new Date(at(28))).toISOString()).toBe(at(28));
    expect(asOf(new Date(at(30)), new Date(at(40))).toISOString()).toBe(at(40));
  });
});

describe('member spans', () => {
  test('a span runs from joined to the next left, both ends included', () => {
    const spans = memberSpans([member(1, 1, 'MMR-3', 'joined'), member(2, 5, 'MMR-3', 'left')], {});
    expect(spans.get('MMR-3')).toEqual([{ end: at(5), start: at(1) }]);
    const found = spans.get('MMR-3') ?? [];
    expect([at(0), at(1), at(3), at(5), at(6)].map((t) => inSpans(found, t))).toEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
  });

  test('a task that left and joined again has two spans', () => {
    const spans = memberSpans(
      [
        member(1, 1, 'MMR-3', 'joined'),
        member(2, 3, 'MMR-3', 'left'),
        member(3, 6, 'MMR-3', 'joined'),
        member(4, 8, 'MMR-3', 'released'),
      ],
      {},
    );
    expect(spans.get('MMR-3')).toEqual([
      { end: at(3), start: at(1) },
      { end: at(8), start: at(6) },
    ]);
    const found = spans.get('MMR-3') ?? [];
    expect(inSpans(found, at(4))).toBe(false);
  });

  test('a span still open has no upper bound', () => {
    const spans = memberSpans([member(1, 1, 'MMR-3', 'joined')], {});
    expect(spans.get('MMR-3')).toEqual([{ end: null, start: at(1) }]);
    expect(inSpans(spans.get('MMR-3') ?? [], at(59, 999))).toBe(true);
  });

  test('an abandoned span runs on to that task’s next lifecycle row to abandoned', () => {
    const spans = memberSpans(
      [member(1, 1, 'MMR-3', 'joined'), member(2, 5, 'MMR-3', 'abandoned')],
      {
        'MMR-3': [at(2), at(5, 1)],
      },
    );
    // The first abandon row at or after the member row ends it, not an earlier one.
    expect(spans.get('MMR-3')).toEqual([{ end: at(5, 1), start: at(1) }]);
  });

  test('an abandon row before the member row leaves the span ending at the member row', () => {
    const spans = memberSpans(
      [member(1, 1, 'MMR-3', 'joined'), member(2, 5, 'MMR-3', 'abandoned')],
      {
        'MMR-3': [at(4, 999)],
      },
    );
    expect(spans.get('MMR-3')).toEqual([{ end: at(5), start: at(1) }]);
  });

  test('an abandon at the same millisecond as the member row ends the span there', () => {
    const spans = memberSpans(
      [member(1, 1, 'MMR-3', 'joined'), member(2, 5, 'MMR-3', 'abandoned')],
      { 'MMR-3': [at(5)] },
    );
    expect(spans.get('MMR-3')).toEqual([{ end: at(5), start: at(1) }]);
    // A later abandon row must not be picked over the one at the member row.
    const later = memberSpans(
      [member(1, 1, 'MMR-3', 'joined'), member(2, 5, 'MMR-3', 'abandoned')],
      { 'MMR-3': [at(7), at(5)] },
    );
    expect(later.get('MMR-3')).toEqual([{ end: at(5), start: at(1) }]);
  });

  test('the abandon instants are read in time order whatever order the caller lists them', () => {
    const spans = memberSpans(
      [member(1, 1, 'MMR-3', 'joined'), member(2, 5, 'MMR-3', 'abandoned')],
      { 'MMR-3': [at(9), at(6), at(5, 1)] },
    );
    expect(spans.get('MMR-3')).toEqual([{ end: at(5, 1), start: at(1) }]);
  });

  test('rows given out of id order read as if given in id order', () => {
    const rows = [
      member(1, 1, 'MMR-3', 'joined'),
      member(2, 3, 'MMR-3', 'left'),
      member(3, 5, 'MMR-3', 'joined'),
      member(4, 7, 'MMR-3', 'released'),
      lifecycle(5, 9, 'landed'),
    ];
    const shuffled = [rows[3], rows[0], rows[4], rows[2], rows[1]].filter((r) => r !== undefined);
    expect(memberSpans(shuffled, {})).toEqual(memberSpans(rows, {}));
    expect(memberSpans(shuffled, {}).get('MMR-3')).toEqual([
      { end: at(3), start: at(1) },
      { end: at(7), start: at(5) },
    ]);
  });

  test('landing ends every span still open, and leaves a closed one alone', () => {
    const spans = memberSpans(
      [
        member(1, 1, 'MMR-3', 'joined'),
        member(2, 1, 'MMR-4', 'joined'),
        member(3, 2, 'MMR-4', 'left'),
        lifecycle(4, 9, 'landed', 'milestone'),
      ],
      {},
    );
    expect(spans.get('MMR-3')).toEqual([{ end: at(9), start: at(1) }]);
    expect(spans.get('MMR-4')).toEqual([{ end: at(2), start: at(1) }]);
  });

  test('an abandoned delivery’s lifecycle row does not end an open span', () => {
    const spans = memberSpans(
      [member(1, 1, 'MMR-3', 'joined'), lifecycle(2, 9, 'abandoned', 'running')],
      {},
    );
    expect(spans.get('MMR-3')).toEqual([{ end: null, start: at(1) }]);
  });
});

describe('the feed', () => {
  test('the delivery’s own history rows become events with their ids', () => {
    const sources = empty();
    sources.history = [
      lifecycle(7, 10, 'running', 'agreed'),
      { ...member(8, 11, 'MMR-3', 'joined') },
      {
        at: at(12),
        from_value: 'none',
        id: 9,
        kind: 'hold',
        reason: 'wait',
        task: null,
        to_value: 'stopped',
      },
    ];
    expect(feedOf(sources, at(0))).toEqual([
      {
        at: at(10),
        from: 'agreed',
        id: 'MMR-d1/history/7',
        kind: 'lifecycle',
        number: null,
        reason: null,
        record: D,
        task: null,
        text: null,
        to: 'running',
      },
      {
        at: at(11),
        from: null,
        id: 'MMR-d1/history/8',
        kind: 'member',
        number: null,
        reason: null,
        record: D,
        task: 'MMR-3',
        text: null,
        to: 'joined',
      },
      {
        at: at(12),
        from: 'none',
        id: 'MMR-d1/history/9',
        kind: 'hold',
        number: null,
        reason: 'wait',
        record: D,
        task: null,
        text: null,
        to: 'stopped',
      },
    ]);
  });

  test('a limitation carries number and text; a declined finding adds its reason; one numbering', () => {
    const sources = empty();
    sources.findings = [
      { created_at: at(3), delivery: D, kind: 'limitation', number: 1, reason: null, text: 'edge' },
      {
        created_at: at(4),
        delivery: D,
        kind: 'declined',
        number: 2,
        reason: 'later',
        text: 'find',
      },
    ];
    const [limit, declined] = feedOf(sources, at(0));
    expect(limit).toMatchObject({
      from: null,
      id: 'MMR-d1/finding/1',
      kind: 'limitation',
      number: 1,
      reason: null,
      record: D,
      text: 'edge',
      to: null,
    });
    expect(declined).toMatchObject({
      id: 'MMR-d1/finding/2',
      kind: 'declined',
      number: 2,
      reason: 'later',
      text: 'find',
    });
  });

  test('an event exactly at since is excluded, and one a millisecond later is included', () => {
    const sources = empty();
    sources.history = [
      lifecycle(1, 5, 'running'),
      { ...lifecycle(2, 5, 'milestone'), at: at(5, 1) },
    ];
    expect(feedOf(sources, at(5)).map((e) => e.id)).toEqual(['MMR-d1/history/2']);
  });

  test('a cursor past year 9999 compares as an instant, not as text', () => {
    const sources = empty();
    sources.history = [lifecycle(1, 5, 'running')];
    expect(feedOf(sources, '+010000-01-01T03:00:00.000Z')).toEqual([]);
    expect(feedOf(sources, '0099-01-01T00:00:00.000Z')).toHaveLength(1);
  });

  test('an event stamped past year 9999 is after any four-digit cursor', () => {
    const sources = empty();
    sources.history = [{ ...lifecycle(1, 5, 'running'), at: '+010000-01-01T00:00:00.000Z' }];
    expect(feedOf(sources, '9999-12-31T23:59:59.999Z')).toHaveLength(1);
  });

  test('a checklist item settled after its task left is not an event', () => {
    const sources = empty();
    sources.history = [member(1, 1, 'MMR-3', 'joined'), member(2, 4, 'MMR-3', 'left')];
    sources.items = [
      {
        content: 'x',
        created_at: at(2),
        number: 1,
        reason: null,
        settled_at: at(8),
        state: 'checked',
        task: 'MMR-3',
      },
    ];
    expect(feedOf(sources, at(0)).map((e) => e.id)).toEqual([
      'MMR-d1/history/1',
      'MMR-3/item/1/added',
      'MMR-d1/history/2',
    ]);
  });

  test('an event stamped in the future is included', () => {
    const sources = empty();
    sources.findings = [
      {
        created_at: '2099-01-01T00:00:00.000Z',
        delivery: D,
        kind: 'limitation',
        number: 1,
        reason: null,
        text: 'far',
      },
    ];
    expect(feedOf(sources, at(0))).toHaveLength(1);
  });

  test('a member task’s rows are included only inside its spans', () => {
    const sources = empty();
    sources.history = [
      member(1, 10, 'MMR-3', 'joined'),
      member(2, 20, 'MMR-3', 'left'),
      member(3, 30, 'MMR-3', 'joined'),
    ];
    const row = (id: number, second: number) => ({
      at: at(second),
      from_value: 'ready',
      id,
      kind: 'lifecycle' as const,
      node_id: 'MMR-3',
      reason: null,
      to_value: 'active',
    });
    sources.transitions = [row(1, 5), row(2, 15), row(3, 25), row(4, 35)];
    sources.notes = [
      { at: at(5), id: 1, task: 'MMR-3', text: 'before join' },
      { at: at(16), id: 2, task: 'MMR-3', text: 'inside' },
      { at: at(26), id: 3, task: 'MMR-3', text: 'after leave' },
      { at: at(40), id: 4, task: 'MMR-3', text: 'rejoined' },
    ];
    const ids = feedOf(sources, at(0))
      .filter((e) => e.record === 'MMR-3')
      .map((e) => e.id);
    expect(ids).toEqual([
      'MMR-3/transition/2',
      'MMR-3/note/2',
      'MMR-3/transition/4',
      'MMR-3/note/4',
    ]);
  });

  test('a task that never joined contributes nothing', () => {
    const sources = empty();
    sources.notes = [{ at: at(5), id: 1, task: 'MMR-9', text: 'stranger' }];
    expect(feedOf(sources, at(0))).toEqual([]);
  });

  test('a transition carries its kind, from, to, and reason; a note its text', () => {
    const sources = empty();
    sources.history = [member(1, 1, 'MMR-3', 'joined')];
    sources.transitions = [
      {
        at: at(2),
        from_value: 'a',
        id: 11,
        kind: 'dependency',
        node_id: 'MMR-3',
        reason: 'why',
        to_value: 'b',
      },
    ];
    sources.notes = [{ at: at(3), id: 12, task: 'MMR-3', text: 'a note' }];
    const events = feedOf(sources, at(1)).filter((e) => e.record === 'MMR-3');
    expect(events[0]).toMatchObject({
      from: 'a',
      id: 'MMR-3/transition/11',
      kind: 'dependency',
      reason: 'why',
      task: null,
      to: 'b',
    });
    expect(events[1]).toMatchObject({
      from: null,
      id: 'MMR-3/note/12',
      kind: 'note',
      text: 'a note',
      to: null,
    });
  });

  test('a checklist item is an added event, and a settled one adds a second', () => {
    const sources = empty();
    sources.history = [member(1, 1, 'MMR-3', 'joined')];
    sources.items = [
      {
        content: 'open one',
        created_at: at(2),
        number: 1,
        reason: null,
        settled_at: null,
        state: 'open',
        task: 'MMR-3',
      },
      {
        content: 'dropped one',
        created_at: at(3),
        number: 2,
        reason: 'no longer needed',
        settled_at: at(4),
        state: 'dropped',
        task: 'MMR-3',
      },
      {
        content: 'checked one',
        created_at: at(3),
        number: 3,
        reason: null,
        settled_at: at(5),
        state: 'checked',
        task: 'MMR-3',
      },
    ];
    const events = feedOf(sources, at(1));
    expect(events.map((e) => e.id).filter((id) => id.includes('/item/'))).toEqual([
      'MMR-3/item/1/added',
      'MMR-3/item/2/added',
      'MMR-3/item/3/added',
      'MMR-3/item/2/settled',
      'MMR-3/item/3/settled',
    ]);
    expect(events).toHaveLength(5);
    expect(events[0]).toMatchObject({
      from: null,
      kind: 'item',
      number: 1,
      reason: null,
      text: 'open one',
      to: 'open',
    });
    expect(events[3]).toMatchObject({
      from: 'open',
      number: 2,
      reason: 'no longer needed',
      text: 'dropped one',
      to: 'dropped',
    });
    expect(events[4]).toMatchObject({ from: 'open', reason: null, to: 'checked' });
  });

  test('a decision recorded, its history, and a journal artifact', () => {
    const sources = empty();
    sources.decisions = [{ created_at: at(2), id: 'MMR-q1', question: 'Which?' }];
    sources.decisionHistory = [
      {
        at: at(3),
        decision: 'MMR-q1',
        from_value: 'provisional',
        id: 4,
        kind: 'lifecycle',
        reason: 'because',
        task: null,
        to_value: 'confirmed',
      },
      {
        at: at(4),
        decision: 'MMR-q1',
        from_value: null,
        id: 5,
        kind: 'link',
        reason: null,
        task: 'MMR-3',
        to_value: 'MMR-3',
      },
    ];
    sources.journals = [{ created_at: at(6), id: 'MMR-a1', title: 'Run journal' }];
    const events = feedOf(sources, at(0));
    expect(events.map((e) => [e.id, e.kind, e.record])).toEqual([
      ['MMR-q1/decided', 'decided', 'MMR-q1'],
      ['MMR-q1/history/4', 'lifecycle', 'MMR-q1'],
      ['MMR-q1/history/5', 'link', 'MMR-q1'],
      ['MMR-a1/journal', 'journal', 'MMR-a1'],
    ]);
    expect(events[0]).toMatchObject({ number: null, task: null, text: 'Which?' });
    expect(events[1]).toMatchObject({ from: 'provisional', reason: 'because', to: 'confirmed' });
    expect(events[2]).toMatchObject({ task: 'MMR-3' });
    expect(events[3]).toMatchObject({ text: 'Run journal' });
  });

  test('a decision moved away shows its delivery row naming this delivery and nothing else', () => {
    const sources = empty();
    // The decision now links elsewhere: it is not in `decisions`.
    sources.decisionHistory = [
      {
        at: at(3),
        decision: 'MMR-q2',
        from_value: null,
        id: 1,
        kind: 'delivery',
        reason: null,
        task: null,
        to_value: D,
      },
      {
        at: at(4),
        decision: 'MMR-q2',
        from_value: D,
        id: 2,
        kind: 'delivery',
        reason: null,
        task: null,
        to_value: 'MMR-d2',
      },
      {
        at: at(5),
        decision: 'MMR-q2',
        from_value: 'provisional',
        id: 3,
        kind: 'lifecycle',
        reason: null,
        task: null,
        to_value: 'confirmed',
      },
      {
        at: at(6),
        decision: 'MMR-q2',
        from_value: 'MMR-d2',
        id: 4,
        kind: 'delivery',
        reason: null,
        task: null,
        to_value: 'MMR-d3',
      },
    ];
    expect(feedOf(sources, at(0)).map((e) => e.id)).toEqual([
      'MMR-q2/history/1',
      'MMR-q2/history/2',
    ]);
  });
});

describe('the tie order', () => {
  const base = {
    at: at(1),
    from: null,
    kind: 'note' as const,
    number: null,
    reason: null,
    task: null,
    text: null,
    to: null,
  };

  const tied = (over: Partial<Parameters<typeof compareEvents>[0]>) => ({
    ...base,
    id: 'k',
    rank: 5,
    record: 'MMR-3',
    row: 1 as number | null,
    ...over,
  });

  test('an earlier time sorts first whatever the source', () => {
    const early = { ...base, at: at(1), id: 'x', record: 'Z' };
    const late = { ...base, at: at(2), id: 'a', record: 'A' };
    expect(
      compareEvents({ ...early, rank: 8, row: null }, { ...late, rank: 1, row: null }),
    ).toBeLessThan(0);
  });

  test('then the source rank, then the record as a string, then the row, then the id', () => {
    const order = [
      tied({ id: 'a', rank: 1 }),
      tied({ id: 'b', rank: 5, record: 'MMR-10' }),
      tied({ id: 'c', record: 'MMR-3', row: null }),
      tied({ id: 'd', record: 'MMR-3', row: 1 }),
      tied({ id: 'e', record: 'MMR-3', row: 2 }),
      tied({ id: 'f', record: 'MMR-9' }),
    ];
    const shuffled = [order[4], order[2], order[5], order[0], order[3], order[1]].filter(
      (x) => x !== undefined,
    );
    expect(shuffled.toSorted(compareEvents).map((x) => x.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
    ]);
  });

  test('the id breaks a tie on everything else', () => {
    const a = { ...base, id: 'MMR-3/item/1/added', rank: 5, record: 'MMR-3', row: 1 };
    const b = { ...a, id: 'MMR-3/item/1/settled' };
    expect(compareEvents(a, b)).toBeLessThan(0);
    expect(compareEvents(b, a)).toBeGreaterThan(0);
  });

  test('two tasks’ item 1 in one millisecond order by the record as a string', () => {
    const sources = empty();
    sources.history = [member(1, 1, 'MMR-10', 'joined'), member(2, 1, 'MMR-9', 'joined')];
    const item = (task: string) => ({
      content: 'x',
      created_at: at(2),
      number: 1,
      reason: null,
      settled_at: null,
      state: 'open' as const,
      task,
    });
    sources.items = [item('MMR-9'), item('MMR-10')];
    expect(
      feedOf(sources, at(1))
        .filter((e) => e.kind === 'item')
        .map((e) => e.record),
    ).toEqual(['MMR-10', 'MMR-9']);
  });

  test('records and ids that case-insensitive locale order would swap order by code unit', () => {
    const lower = tied({ id: 'k', record: 'a' });
    const upper = tied({ id: 'k', record: 'B' });
    expect(compareEvents(upper, lower)).toBeLessThan(0);
    expect(compareEvents(lower, upper)).toBeGreaterThan(0);
    const idLower = tied({ id: 'a' });
    const idUpper = tied({ id: 'B' });
    expect(compareEvents(idUpper, idLower)).toBeLessThan(0);
    expect(compareEvents(idLower, idUpper)).toBeGreaterThan(0);
  });

  test('limitations and declined findings share one rank and order by number', () => {
    const sources = empty();
    sources.findings = [
      { created_at: at(2), delivery: D, kind: 'declined', number: 2, reason: 'r', text: 'b' },
      { created_at: at(2), delivery: D, kind: 'limitation', number: 1, reason: null, text: 'a' },
      { created_at: at(2), delivery: D, kind: 'limitation', number: 3, reason: null, text: 'c' },
    ];
    expect(feedOf(sources, at(0)).map((e) => e.number)).toEqual([1, 2, 3]);
  });

  test('across sources at one instant the ranks run history, findings, transitions, notes, items, decided, decision history, journal', () => {
    const sources = empty();
    const t = 5;
    sources.history = [member(1, 1, 'MMR-3', 'joined'), lifecycle(2, t, 'running')];
    sources.findings = [
      { created_at: at(t), delivery: D, kind: 'limitation', number: 1, reason: null, text: 'l' },
    ];
    sources.transitions = [
      {
        at: at(t),
        from_value: null,
        id: 1,
        kind: 'lifecycle',
        node_id: 'MMR-3',
        reason: null,
        to_value: 'active',
      },
    ];
    sources.notes = [{ at: at(t), id: 1, task: 'MMR-3', text: 'n' }];
    sources.items = [
      {
        content: 'i',
        created_at: at(t),
        number: 1,
        reason: null,
        settled_at: null,
        state: 'open',
        task: 'MMR-3',
      },
    ];
    sources.decisions = [{ created_at: at(t), id: 'MMR-q1', question: 'q' }];
    sources.decisionHistory = [
      {
        at: at(t),
        decision: 'MMR-q1',
        from_value: null,
        id: 1,
        kind: 'lifecycle',
        reason: null,
        task: null,
        to_value: 'confirmed',
      },
    ];
    sources.journals = [{ created_at: at(t), id: 'MMR-a1', title: 't' }];
    expect(feedOf(sources, at(t - 1)).map((e) => e.id)).toEqual([
      'MMR-d1/history/2',
      'MMR-d1/finding/1',
      'MMR-3/transition/1',
      'MMR-3/note/1',
      'MMR-3/item/1/added',
      'MMR-q1/decided',
      'MMR-q1/history/1',
      'MMR-a1/journal',
    ]);
  });
});
