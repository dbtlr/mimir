import type { ReviewReport } from '../api/view-queries';
import type { ShippedDay } from '../components/patterns/feed/shipped-summary';
import { dayBefore, dayOf } from './work-page';

/*
 * The pure derivations behind Home (ADR 0013, MMR-722 refinement): the page
 * title's day, the summary sentence under it, Now's cap and its count, the
 * Shipped week and its counts by project, and the spare-minute rows.
 */

/** How many Now cards Home shows: four on a phone, six from 768 up. */
const NOW_CAP = { desktop: 6, phone: 4 } as const;

/** `1 task` / `2 tasks`: a count with its noun, singular at one. */
function counted(n: number, noun: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? noun : `${noun}s`}`;
}

/** "Monday, 23 November": the day `now` falls on in `zone`. */
export function homeDay(zone: string, now = Date.now()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    timeZone: zone,
    weekday: 'long',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';
  return `${part('weekday')}, ${part('day')} ${part('month')}`;
}

/** What the summary sentence counts. */
export type HomeCounts = {
  /** The Needs you deck's cards. */
  cards: number;
  /** The needs-you records those cards hold, the top-bar alert's count. */
  items: number;
  /** The tasks in Now. */
  running: number;
  /** The tasks shipped in the last seven days. */
  shipped: number;
};

/** The work clause: what runs, and what shipped this week. */
function workClause({ running, shipped }: Pick<HomeCounts, 'running' | 'shipped'>): string {
  const runs =
    running === 0
      ? 'nothing is running'
      : `${counted(running, 'task')} ${running === 1 ? 'is' : 'are'} running`;
  let landed = 'nothing has shipped this week';
  if (shipped > 0) {
    // After a count of running tasks, "tasks" is already said.
    const what = running === 0 ? counted(shipped, 'task') : shipped.toLocaleString('en-US');
    landed = `${what} ${shipped === 1 ? 'has' : 'have'} shipped this week`;
  }
  return `${runs}, and ${landed}`;
}

/** Upper-cases a clause's first letter, for one that opens a sentence. */
function opening(clause: string): string {
  return clause.charAt(0).toUpperCase() + clause.slice(1);
}

/**
 * The one sentence under Home's title: what needs you, then what runs and
 * what shipped this week. Each clause names its own part, so a mixed page
 * says plainly which parts are quiet; a page where nothing needs you, runs,
 * or shipped reads as a quiet week.
 */
export function homeSummary(counts: HomeCounts): string {
  const work = workClause(counts);
  if (counts.cards === 0) {
    return counts.running === 0 && counts.shipped === 0
      ? `A quiet week: ${work}.`
      : `${opening(work)}.`;
  }
  const needs = `${counted(counts.cards, 'card')} ${counts.cards === 1 ? 'needs' : 'need'} you`;
  // Each card one record: "holding" would only repeat the count.
  const holding = counts.items === counts.cards ? '' : `, holding ${counted(counts.items, 'item')}`;
  return `${needs}${holding}. ${opening(work)}.`;
}

/** How many of `total` Now cards Home shows at this width. */
export function nowShown(total: number, { desktop }: { desktop: boolean }): number {
  return Math.min(total, desktop ? NOW_CAP.desktop : NOW_CAP.phone);
}

/** Now's head count: "6 of 9" when the cap hides cards, else the plain count. */
export function nowCount(total: number, width: { desktop: boolean }): number | string {
  const shown = nowShown(total, width);
  return shown < total ? `${String(shown)} of ${String(total)}` : total;
}

/**
 * The seven `YYYY-MM-DD` days ending today in `zone`, oldest first: the window
 * Shipped counts and the Tasks list's finished-in-the-last-7-days preset reads,
 * so the two count the same tasks.
 */
export function lastSevenDays(
  zone: string,
  now = Date.now(),
): { days: string[]; first: string; today: string } {
  const today = dayOf(now, zone);
  const days = [today];
  while (days.length < 7) {
    days.unshift(dayBefore(days[0] ?? today));
  }
  return { days, first: days[0] ?? today, today };
}

/** One project's shipped count. */
export type ShippedProject = { key: string; name: string; count: number };

/** The Shipped week: seven days oldest first, today last, and the counts by project. */
export type ShippedWeek = {
  days: ShippedDay[];
  byProject: ShippedProject[];
  total: number;
};

/** A `YYYY-MM-DD` day's weekday, long and short, named in UTC so no zone moves it. */
function weekday(day: string, style: 'long' | 'short'): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: style }).format(
    Date.parse(`${day}T00:00:00.000Z`),
  );
}

/**
 * What shipped in the seven days ending today in `zone`: a done task. An
 * abandoned task is in the report's finished rows but did not ship. Projects
 * are counted most first, ties in the project list's order, and named as the
 * project list names them.
 */
export function shippedWeek({
  rows,
  projects,
  zone,
  now = Date.now(),
}: {
  rows: ReviewReport['shipped'];
  projects: ReviewReport['projects'];
  zone: string;
  now?: number;
}): ShippedWeek {
  const { days: window, today } = lastSevenDays(zone, now);
  const perDay = new Map(window.map((day) => [day, 0]));
  const perProject = new Map<string, number>();
  let total = 0;
  for (const row of rows) {
    const day = dayOf(row.finishedAt.getTime(), zone);
    const count = perDay.get(day);
    if (row.task.status !== 'done' || count === undefined) {
      continue;
    }
    perDay.set(day, count + 1);
    perProject.set(row.project, (perProject.get(row.project) ?? 0) + 1);
    total += 1;
  }
  const order = new Map(projects.map((project, index) => [project.key, index]));
  const names = new Map(projects.map((project) => [project.key, project.name]));
  const byProject = [...perProject.entries()]
    .map(([key, count]) => ({ count, key, name: names.get(key) ?? key }))
    .toSorted(
      (a, b) =>
        b.count - a.count ||
        (order.get(a.key) ?? Infinity) - (order.get(b.key) ?? Infinity) ||
        a.key.localeCompare(b.key),
    );
  const days = window.map((day) =>
    day === today
      ? { count: perDay.get(day) ?? 0, name: 'today', short: 'Today' }
      : { count: perDay.get(day) ?? 0, name: weekday(day, 'long'), short: weekday(day, 'short') },
  );
  return { byProject, days, total };
}

/** One spare-minute row: what it counts, and how many. */
export type MinuteRow = { name: string; count: number };

/** What can wait for a spare minute, across projects, in Home's order. */
export function minuteRows(report: ReviewReport): MinuteRow[] {
  const sum = (pick: (group: ReviewReport['triage'][number]) => number) =>
    report.triage.reduce((n, group) => n + pick(group), 0);
  return [
    { count: sum((group) => group.seeds.length), name: 'Seeds to triage' },
    { count: report.runnable.length, name: 'Ready to start' },
    { count: report.goingCold.length, name: 'Going cold' },
    { count: sum((group) => group.findings), name: 'Doctor findings' },
  ];
}
