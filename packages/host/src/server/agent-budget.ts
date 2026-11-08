/*
 * The daily token budget's arithmetic (ADR 0041, "The budget is a token count
 * Mimir keeps"). Pure functions: the runner reads the day's usage from the
 * runs table and decides here.
 */

/** One budget day: its first instant and the instant the next one starts. */
export type BudgetDay = { startedAt: Date; resetsAt: Date };

/** A calendar date as one comparable number, such as 20261108. */
type DateKey = number;

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The calendar date `instant` falls on in `timezone`. */
function localDate(instant: number, timezone: string): DateKey {
  let format = formatters.get(timezone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', {
      day: 'numeric',
      month: 'numeric',
      timeZone: timezone,
      year: 'numeric',
    });
    formatters.set(timezone, format);
  }
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(format.formatToParts(instant).find((each) => each.type === type)?.value);
  return part('year') * 10_000 + part('month') * 100 + part('day');
}

/** Every zone's offset lies within this of UTC (the widest are UTC-12 and UTC+14). */
const WIDEST_OFFSET_MS = 15 * 3_600_000;

/**
 * The first instant whose date in `timezone` is `date` or later. Local dates
 * only move forward, so a binary search over the hours around UTC midnight
 * finds it, also on a day whose midnight a daylight-saving change skips.
 */
function startOfDate(year: number, month: number, day: number, timezone: string): Date {
  const utcMidnight = Date.UTC(year, month - 1, day);
  const target = localDate(utcMidnight, 'UTC');
  let low = utcMidnight - WIDEST_OFFSET_MS;
  let high = utcMidnight + WIDEST_OFFSET_MS;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (localDate(middle, timezone) >= target) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return new Date(low);
}

/** The budget day holding `now`: from midnight in `timezone` to the next midnight there. */
export function budgetDay(now: Date, timezone: string): BudgetDay {
  const today = localDate(now.getTime(), timezone);
  const year = Math.floor(today / 10_000);
  const month = Math.floor(today / 100) % 100;
  const day = today % 100;
  return {
    // Date.UTC rolls day 32 into the next month, and month 13 into the next year.
    resetsAt: startOfDate(year, month, day + 1, timezone),
    startedAt: startOfDate(year, month, day, timezone),
  };
}

/** Whether a run's ceiling fits what is left of the day's budget. */
export function budgetFits(input: {
  dailyTokens: number;
  runTokens: number;
  usedTokens: number;
}): boolean {
  return input.usedTokens + input.runTokens <= input.dailyTokens;
}

/** What is left of the day's budget; zero once a run has overrun it. */
export function remainingTokens(input: { dailyTokens: number; usedTokens: number }): number {
  return Math.max(0, input.dailyTokens - input.usedTokens);
}
