import { describe, expect, it } from 'vitest';

import {
  homeDay,
  homeSummary,
  minuteRows,
  nowCount,
  nowShown,
  oneProject,
  shippedWeek,
} from '../lib/home';
import { engineReview, shippedRow, stripRow, tagged } from './views-fixtures';

/*
 * Home's derivations (ADR 0013, MMR-722 refinement): the page title's day, the
 * summary sentence, Now's cap and count, the Shipped week, and the spare-minute
 * rows.
 */

// Monday 23 November 2026, 15:00 in New York.
const NOW = Date.parse('2026-11-23T20:00:00.000Z');
const ZONE = 'America/New_York';
const daysAgo = (d: number, hour = 12) =>
  new Date(
    Date.parse(
      `2026-11-${String(23 - d).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00-05:00`,
    ),
  );

describe('the page title', () => {
  it('names the day in the browser’s zone', () => {
    expect(homeDay(ZONE, NOW)).toBe('Monday, 23 November');
  });

  it('turns the day at the zone’s midnight, not UTC’s', () => {
    // 02:00 UTC on the 24th is still the 23rd in New York.
    expect(homeDay(ZONE, Date.parse('2026-11-24T02:00:00.000Z'))).toBe('Monday, 23 November');
    expect(homeDay('Europe/Berlin', Date.parse('2026-11-24T02:00:00.000Z'))).toBe(
      'Tuesday, 24 November',
    );
  });
});

describe('the summary sentence', () => {
  it('names the cards, their items, what runs, and what shipped on a busy page', () => {
    expect(homeSummary({ cards: 10, items: 26, running: 9, shipped: 104 })).toBe(
      '10 cards need you, holding 26 items. 9 tasks are running, and 104 have shipped this week.',
    );
  });

  it('reads a quiet week when nothing needs you, runs, or shipped', () => {
    expect(homeSummary({ cards: 0, items: 0, running: 0, shipped: 0 })).toBe(
      'A quiet week: nothing is running, and nothing has shipped this week.',
    );
  });

  it('reads one of each in the singular, and drops “holding” when each card is one item', () => {
    expect(homeSummary({ cards: 1, items: 1, running: 1, shipped: 1 })).toBe(
      '1 card needs you. 1 task is running, and 1 has shipped this week.',
    );
  });

  it('writes thousands with a separator', () => {
    expect(homeSummary({ cards: 1234, items: 2345, running: 1234, shipped: 1234 })).toBe(
      '1,234 cards need you, holding 2,345 items. 1,234 tasks are running, and 1,234 have shipped this week.',
    );
  });

  it('says plainly which parts are quiet on a mixed page', () => {
    expect(homeSummary({ cards: 0, items: 0, running: 3, shipped: 0 })).toBe(
      '3 tasks are running, and nothing has shipped this week.',
    );
    expect(homeSummary({ cards: 0, items: 0, running: 0, shipped: 12 })).toBe(
      'Nothing is running, and 12 tasks have shipped this week.',
    );
    expect(homeSummary({ cards: 2, items: 5, running: 0, shipped: 0 })).toBe(
      '2 cards need you, holding 5 items. Nothing is running, and nothing has shipped this week.',
    );
  });
});

describe('Now’s cap', () => {
  it('shows four cards on a phone and six on desktop', () => {
    expect(nowShown(9, { desktop: false })).toBe(4);
    expect(nowShown(9, { desktop: true })).toBe(6);
    expect(nowShown(3, { desktop: true })).toBe(3);
  });

  it('counts “6 of 9” when the cap hides cards, and the plain count when it does not', () => {
    expect(nowCount(9, { desktop: true })).toBe('6 of 9');
    expect(nowCount(9, { desktop: false })).toBe('4 of 9');
    expect(nowCount(6, { desktop: true })).toBe(6);
    expect(nowCount(4, { desktop: false })).toBe(4);
    expect(nowCount(5, { desktop: false })).toBe('4 of 5');
  });
});

/** A finished task, tagged with its project as the review read tags it. */
const row = (id: string, at: Date, status: 'done' | 'abandoned' = 'done') =>
  tagged(shippedRow({ id, status }, at));

describe('the Shipped week', () => {
  const projects = [
    stripRow({ key: 'LM', name: 'Loom CLI' }),
    stripRow({ key: 'MMR', name: 'Mimir' }),
  ];

  it('counts seven days, oldest first, with today last and so far', () => {
    const week = shippedWeek({
      now: NOW,
      projects,
      rows: [
        row('MMR-1', daysAgo(0, 9)),
        row('MMR-2', daysAgo(0, 10)),
        row('LM-3', daysAgo(1)),
        row('MMR-4', daysAgo(6)),
      ],
      zone: ZONE,
    });
    expect(week.days).toEqual([
      { count: 1, name: 'Tuesday', short: 'Tue' },
      { count: 0, name: 'Wednesday', short: 'Wed' },
      { count: 0, name: 'Thursday', short: 'Thu' },
      { count: 0, name: 'Friday', short: 'Fri' },
      { count: 0, name: 'Saturday', short: 'Sat' },
      { count: 1, name: 'Sunday', short: 'Sun' },
      { count: 2, name: 'today', short: 'Today' },
    ]);
    expect(week.total).toBe(4);
  });

  it('counts by project, most first, named as the project list names them', () => {
    const week = shippedWeek({
      now: NOW,
      projects,
      rows: [row('LM-3', daysAgo(1)), row('MMR-1', daysAgo(0)), row('MMR-2', daysAgo(2))],
      zone: ZONE,
    });
    expect(week.byProject).toEqual([
      { count: 2, key: 'MMR', name: 'Mimir' },
      { count: 1, key: 'LM', name: 'Loom CLI' },
    ]);
  });

  it('counts only what shipped: an abandoned task is not shipped', () => {
    const week = shippedWeek({
      now: NOW,
      projects,
      rows: [row('MMR-1', daysAgo(0)), row('MMR-2', daysAgo(0), 'abandoned')],
      zone: ZONE,
    });
    expect(week.total).toBe(1);
    expect(week.days.at(-1)?.count).toBe(1);
    expect(week.byProject).toEqual([{ count: 1, key: 'MMR', name: 'Mimir' }]);
  });

  it('puts a row on the day it finished in the zone, not in UTC', () => {
    // 23:50 on Sunday in New York is 04:50 on Monday in UTC.
    const week = shippedWeek({
      now: NOW,
      projects,
      rows: [row('MMR-1', new Date('2026-11-23T04:50:00.000Z'))],
      zone: ZONE,
    });
    expect(week.days.slice(-2).map((day) => day.count)).toEqual([1, 0]);
  });

  it('ends the week on today in the zone, not in UTC', () => {
    // 21:00 on Monday in New York is already Tuesday in UTC.
    const week = shippedWeek({
      now: Date.parse('2026-11-24T02:00:00.000Z'),
      projects,
      rows: [row('MMR-1', daysAgo(0, 20))],
      zone: ZONE,
    });
    expect(week.days[0]?.name).toBe('Tuesday');
    expect(week.days.at(-1)).toEqual({ count: 1, name: 'today', short: 'Today' });
  });

  it('keeps seven calendar days across the end of daylight saving time', () => {
    // New York leaves EDT at 02:00 on 1 November 2026, so one day is 25 hours long.
    const week = shippedWeek({
      now: Date.parse('2026-11-03T23:30:00-05:00'),
      projects,
      rows: [
        row('MMR-1', new Date('2026-10-28T00:10:00-04:00')),
        row('MMR-2', new Date('2026-10-27T23:50:00-04:00')),
        row('MMR-3', new Date('2026-11-01T01:30:00-05:00')),
        row('MMR-4', new Date('2026-11-03T23:20:00-05:00')),
      ],
      zone: ZONE,
    });
    expect(week.days.map((day) => day.count)).toEqual([1, 0, 0, 0, 1, 0, 1]);
    expect(week.days[0]?.name).toBe('Wednesday');
  });

  it('keeps seven calendar days across the start of daylight saving time', () => {
    // Berlin enters CEST at 02:00 on 29 March 2026, so one day is 23 hours long.
    const week = shippedWeek({
      now: Date.parse('2026-03-31T00:05:00+02:00'),
      projects,
      rows: [
        row('MMR-1', new Date('2026-03-25T00:01:00+01:00')),
        row('MMR-2', new Date('2026-03-24T23:59:00+01:00')),
        row('MMR-3', new Date('2026-03-30T23:59:00+02:00')),
        row('MMR-4', new Date('2026-03-31T00:01:00+02:00')),
      ],
      zone: 'Europe/Berlin',
    });
    expect(week.days.map((day) => day.count)).toEqual([1, 0, 0, 0, 0, 1, 1]);
    expect(week.days[0]?.name).toBe('Wednesday');
  });

  it('turns the day at midnight in a zone east of UTC', () => {
    const week = shippedWeek({
      now: Date.parse('2026-11-23T00:30:00+13:00'),
      projects,
      rows: [
        row('MMR-1', new Date('2026-11-23T00:10:00+13:00')),
        row('MMR-2', new Date('2026-11-22T23:50:00+13:00')),
      ],
      zone: 'Pacific/Auckland',
    });
    expect(week.days.slice(-2).map((day) => day.count)).toEqual([1, 1]);
  });

  it('keeps a project’s key as its name when the project list does not hold it', () => {
    const week = shippedWeek({
      now: NOW,
      projects: [],
      rows: [row('NORN-1', daysAgo(0))],
      zone: ZONE,
    });
    expect(week.byProject).toEqual([{ count: 1, key: 'NORN', name: 'NORN' }]);
  });
});

describe('the spare-minute rows', () => {
  it('counts seeds, runnable tasks, tasks going cold, and doctor findings across projects', () => {
    const rows = minuteRows(
      engineReview({
        projects: [
          stripRow({ key: 'MMR', name: 'Mimir' }, { findings: 2, goingCold: 1, untriaged: 2 }),
          stripRow({ key: 'LM', name: 'Loom CLI' }, { findings: 1, untriaged: 1 }),
        ],
      }),
    );
    expect(rows).toEqual([
      { count: 3, name: 'Seeds to triage' },
      { count: 0, name: 'Ready to start' },
      {
        count: 1,
        door: { list: 'tasks', project: 'MMR', show: 'going-cold' },
        name: 'Going cold',
      },
      { count: 3, name: 'Doctor findings' },
    ]);
  });
});

/** A project in the review report with only the given counts. */
const counted = (key: string, counts: Parameters<typeof stripRow>[1]) =>
  stripRow({ key, name: key }, counts);

describe('the Seeds to triage door (MMR-725)', () => {
  it('opens the one project’s Seeds list on To triage when it holds every seed to triage', () => {
    const [seeds] = minuteRows(
      engineReview({
        projects: [counted('LM', { findings: 4 }), counted('MMR', { untriaged: 2 })],
      }),
    );
    expect(seeds).toEqual({
      count: 2,
      door: { list: 'seeds', project: 'MMR', show: 'to-triage' },
      name: 'Seeds to triage',
    });
  });

  it('has no door when the seeds to triage span projects', () => {
    const [seeds] = minuteRows(
      engineReview({
        projects: [counted('LM', { untriaged: 1 }), counted('MMR', { untriaged: 2 })],
      }),
    );
    expect(seeds).toEqual({ count: 3, name: 'Seeds to triage' });
  });
});

describe('the Ready to start and Going cold doors (MMR-724)', () => {
  it('open the one project’s Tasks preset when it holds the whole count', () => {
    const [, ready, cold] = minuteRows(
      engineReview({
        projects: [
          counted('LM', { goingCold: 1 }),
          counted('MMR', { goingCold: 2, runnable: 3 }),
          counted('NORN', {}),
        ],
      }),
    );
    expect(ready).toEqual({
      count: 3,
      door: { list: 'tasks', project: 'MMR', show: 'ready' },
      name: 'Ready to start',
    });
    expect(cold).toEqual({ count: 3, name: 'Going cold' });
  });

  it('have no door when nothing counts', () => {
    const [, ready, cold] = minuteRows(engineReview({ projects: [counted('MMR', {})] }));
    expect([ready, cold]).toEqual([
      { count: 0, name: 'Ready to start' },
      { count: 0, name: 'Going cold' },
    ]);
  });
});

describe('oneProject (MMR-724)', () => {
  it.each<[string[], string | undefined]>([
    [['MMR', 'MMR'], 'MMR'],
    [['MMR', 'LM'], undefined],
    [[], undefined],
  ])('reads %j as %s', (keys, project) => {
    expect(oneProject(keys)).toBe(project);
  });
});
