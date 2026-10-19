import { describe, expect } from 'vitest';

import { groupByDay, kindTagLabel, kindTagOptions, kindsOf, splitKindTags } from '../lib/artifacts';

describe('splitKindTags', () => {
  it('lifts the kind: tag out and keeps the rest as tags', () => {
    expect(splitKindTags(['kind:session', 'doctor'])).toStrictEqual({
      kind: 'session',
      rest: ['doctor'],
    });
  });

  it('no kind: tag → kind undefined, all tags kept', () => {
    expect(splitKindTags(['doctor', 'api'])).toStrictEqual({
      kind: undefined,
      rest: ['doctor', 'api'],
    });
  });

  it('only the first kind: tag is KIND; extras stay tags verbatim', () => {
    expect(splitKindTags(['kind:spec', 'kind:session'])).toStrictEqual({
      kind: 'spec',
      rest: ['kind:session'],
    });
  });

  it('a bare "kind:" prefix with no value is a plain tag', () => {
    expect(splitKindTags(['kind:'])).toStrictEqual({ kind: undefined, rest: ['kind:'] });
  });

  it('empty tags → nothing', () => {
    expect(splitKindTags([])).toStrictEqual({ kind: undefined, rest: [] });
  });
});

describe('kindsOf', () => {
  it('reads kind: tags with the prefix stripped, in order', () => {
    expect(kindsOf(['kind:spec', 'doctor', 'kind:session'])).toStrictEqual(['spec', 'session']);
  });

  it('counts the bare session_summary tag as a kind', () => {
    expect(kindsOf(['session_summary', 'mimir'])).toStrictEqual(['session_summary']);
  });

  it('no kind tags → no kinds', () => {
    expect(kindsOf(['doctor'])).toStrictEqual([]);
  });
});

describe('kind tags as filter values', () => {
  it('names a kind tag by its kind, and a plain tag not at all', () => {
    expect(kindTagLabel('kind:spec')).toBe('spec');
    expect(kindTagLabel('session_summary')).toBe('session_summary');
    expect(kindTagLabel('doctor')).toBeUndefined();
  });

  it('offers the well-known kinds plus any seen in rows or chosen, once each', () => {
    const options = kindTagOptions([['kind:spec', 'kind:review'], ['kind:review']], 'kind:other');
    const values = options.map((o) => o.tag);
    expect(values).toContain('session_summary');
    expect(values).toContain('kind:spec');
    expect(values).toContain('kind:review');
    expect(values).toContain('kind:other');
    expect(new Set(values).size).toBe(values.length);
  });

  it('does not offer a plain tag as a kind', () => {
    const values = kindTagOptions([['doctor']], 'doctor').map((o) => o.tag);
    expect(values).not.toContain('doctor');
  });
});

const row = (id: string, created: Date) => ({ createdAt: created, id });

describe('groupByDay', () => {
  // Local-time fixtures throughout: "now" is Fri 2026-10-09 12:00 local.
  const now = new Date(2026, 9, 9, 12, 0, 0).getTime();

  it('labels Today, Yesterday, then "Oct 6" in the current year, newest first', () => {
    const groups = groupByDay(
      [
        row('a', new Date(2026, 9, 9, 8)),
        row('b', new Date(2026, 9, 8, 22)),
        row('c', new Date(2026, 9, 6, 1)),
        row('d', new Date(2026, 2, 3)),
      ],
      now,
    );
    expect(groups.map((g) => g.label)).toStrictEqual(['Today', 'Yesterday', 'Oct 6', 'Mar 3']);
  });

  it('puts rows of one local day together, preserving input order', () => {
    const groups = groupByDay(
      [
        row('a', new Date(2026, 9, 9, 23, 59)),
        row('b', new Date(2026, 9, 9, 0, 0)),
        row('c', new Date(2026, 9, 8, 23, 59)),
      ],
      now,
    );
    expect(groups.map((g) => g.items.map((i) => i.id))).toStrictEqual([['a', 'b'], ['c']]);
  });

  it('breaks the day at local midnight, not UTC', () => {
    const late = new Date(2026, 9, 9, 0, 0, 1);
    const early = new Date(2026, 9, 8, 23, 59, 59);
    const groups = groupByDay([row('a', late), row('b', early)], now);
    expect(groups.map((g) => g.label)).toStrictEqual(['Today', 'Yesterday']);
  });

  it('spells the year for another year, and rolls Yesterday over New Year', () => {
    const newYear = new Date(2027, 0, 1, 9).getTime();
    const groups = groupByDay(
      [
        row('a', new Date(2027, 0, 1, 1)),
        row('b', new Date(2026, 11, 31, 23)),
        row('c', new Date(2026, 11, 30)),
        row('d', new Date(2025, 9, 6)),
      ],
      newYear,
    );
    expect(groups.map((g) => g.label)).toStrictEqual([
      'Today',
      'Yesterday',
      'Dec 30, 2026',
      'Oct 6, 2025',
    ]);
  });

  it('does not call a future-dated row Today', () => {
    const groups = groupByDay([row('a', new Date(2026, 9, 10, 9))], now);
    expect(groups.map((g) => g.label)).toStrictEqual(['Oct 10']);
  });

  it('puts undatable rows under Earlier', () => {
    const groups = groupByDay([{ createdAt: new Date('not-a-date'), id: 'x' }], now);
    expect(groups.map((g) => g.label)).toStrictEqual(['Earlier']);
  });

  it('empty input → no groups', () => {
    expect(groupByDay([], now)).toStrictEqual([]);
  });
});
