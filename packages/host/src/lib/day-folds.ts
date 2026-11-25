import type { ReactElement } from 'react';

import type { FoldDay } from '../components/patterns/feed/day-fold';
import { dayBefore, dayOf } from './work-page';

/*
 * A list's rows folded by the day they happened (ADR 0019, MMR-719
 * refinement): the Tasks list's finished work and the Artifacts list share
 * one grouping and one way of naming a day.
 */

/** "Today", "Yesterday", or "Sunday, 22 November": a fold's day, named in UTC so no zone moves it. */
export function foldLabel(day: string, today: string): string {
  if (day === today) {
    return 'Today';
  }
  if (day === dayBefore(today)) {
    return 'Yesterday';
  }
  const parts = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
    weekday: 'long',
  }).formatToParts(Date.parse(`${day}T00:00:00.000Z`));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${part('weekday')}, ${part('day')} ${part('month')}`;
}

/**
 * `items` folded by the day `at` falls on in `zone`, newest day first. Rows
 * keep the order `items` gives them within a day; the days sort on their own,
 * so an item out of order never opens an older day first.
 */
export function foldByDay<T>(
  items: readonly T[],
  {
    zone,
    at,
    row,
    now = Date.now(),
  }: {
    zone: string;
    /** When the item happened. */
    at: (item: T) => Date;
    /** The item's row, keyed by its record's ID. */
    row: (item: T) => ReactElement;
    now?: number;
  },
): FoldDay[] {
  const today = dayOf(now, zone);
  const days = new Map<string, T[]>();
  for (const item of items) {
    const day = dayOf(at(item).getTime(), zone);
    const bucket = days.get(day);
    if (bucket === undefined) {
      days.set(day, [item]);
    } else {
      bucket.push(item);
    }
  }
  const newestFirst = [...days.entries()].toSorted(([a], [b]) => b.localeCompare(a));
  return newestFirst.map(([day, dayItems]) => ({
    count: dayItems.length,
    key: day,
    label: foldLabel(day, today),
    rows: dayItems.map(row),
  }));
}
