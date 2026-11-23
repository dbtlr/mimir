import { describe, expect, it } from 'vitest';

import { homeDay, homeSummary, minuteRows, nowCount, nowShown, shippedWeek } from '../lib/home';
import { engineReview, shippedRow, stripRow, tagged, triageSeed } from './views-fixtures';

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
        goingCold: [{ project: 'MMR', task: shippedRow({ id: 'MMR-9' }, new Date(NOW)).task }],
        runnable: [],
        triage: [
          {
            findings: 2,
            goingCold: 1,
            project: { key: 'MMR', name: 'Mimir' },
            seeds: [triageSeed({ id: 'MMR-s1' }), triageSeed({ id: 'MMR-s2' })],
          },
          {
            findings: 1,
            goingCold: 0,
            project: { key: 'LM', name: 'Loom CLI' },
            seeds: [triageSeed({ id: 'LM-s1' })],
          },
        ],
      }),
    );
    expect(rows).toEqual([
      { count: 3, name: 'Seeds to triage' },
      { count: 0, name: 'Ready to start' },
      { count: 1, name: 'Going cold' },
      { count: 3, name: 'Doctor findings' },
    ]);
  });
});
