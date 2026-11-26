import type { EngineNode, EngineTree, StatusWord } from '@mimir/contract';

import type { NowTask, ShippedTask, WorkReport } from '../api/view-queries';
import type { NeedsYouCard } from '../components/needs-you-deck-model';
import type { ShippedDay } from '../components/patterns/feed/shipped-summary';
import { subtreeOf } from './ancestry';
import { lastSevenDays, shippedDays } from './home';
import type { MinuteRow } from './home';
import { dayOf } from './work-page';

/*
 * The pure derivations behind a project's, initiative's, or phase's Work tab
 * on Home's pattern (ADR 0013, MMR-727 refinement): the Needs you deck kept to
 * the scope, Now's order, Up next and its one unlocks row, Shipped this week
 * split one level down, the spare-minute rows per scope, the parts and their
 * finished fold, the quiet sentence, and when an initiative or phase has Work.
 */

/** What a Work tab is scoped to, as the work read names it. */
export type WorkScope = WorkReport['scope'];

/**
 * The deck's cards that hold a record in the scope's needs-you set (`ids`,
 * the work read's `needsYou` by record ID), in the set's one order. A bundle
 * shows whole, with its full count, when any of its decisions is in scope.
 */
export function scopeCards(cards: readonly NeedsYouCard[], ids: readonly string[]): NeedsYouCard[] {
  const inScope = new Set(ids);
  return cards.filter((card) => card.members.some((id) => inScope.has(id)));
}

/** A Now row's latest move: a review's or a stage's submit, else the start. */
function lastMove(row: NowTask): number {
  const submitted = row.task.status === 'under_review' || row.task.status === 'staged';
  return (submitted ? (row.submittedAt ?? row.startedAt) : row.startedAt).getTime();
}

/** Now's rows most recent move first, as Home orders them; the work read lists them by rank. */
export function latestMoveFirst<Row extends NowTask>(rows: readonly Row[]): Row[] {
  return rows.toSorted((a, b) => lastMove(b) - lastMove(a));
}

/** How many tasks that can start Up next shows as cards. */
const UP_NEXT_CAP = 3;

type Frontier = WorkReport['frontier'];

/** Up next: the cards that can start, how many can, and the one row for what unlocks next. */
export type UpNext = {
  cards: Frontier['runnable'];
  /** Every task that can start, the head's "N can start". */
  total: number;
  /** The prerequisite whose landing unlocks `count` tasks that wait on it alone. */
  unlocks?: { id: string; count: number };
};

/**
 * Up next from the Frontier: three of the tasks that can start now, and the
 * first next-to-unlock group, in the read's board order, that holds a task
 * waiting on that prerequisite alone, with the count of such tasks.
 */
export function upNext(frontier: Frontier): UpNext {
  const unlocks = frontier.nextToUnlock
    .map(({ prerequisite, tasks }) => ({
      count: tasks.filter(
        (row) => row.awaitingOn.length === 1 && row.awaitingOn[0] === prerequisite.id,
      ).length,
      id: prerequisite.id,
    }))
    .find((group) => group.count > 0);
  return {
    cards: frontier.runnable.slice(0, UP_NEXT_CAP),
    total: frontier.runnable.length,
    ...(unlocks === undefined ? {} : { unlocks }),
  };
}

/** One container's shipped count on a project's or initiative's Shipped split. */
export type ShippedPart = { id: string; name: string; count: number };

/** How many done tasks a phase's Shipped lists. */
const SHIPPED_TASKS_CAP = 3;

/**
 * Shipped one level down: the containers that hold what shipped, most first,
 * or, on a phase, which has nothing below its tasks, the done tasks themselves.
 */
export type ShippedBreakdown =
  | { kind: 'parts'; rows: ShippedPart[] }
  | { kind: 'tasks'; rows: ShippedTask[] };

export type ShippedSplit = { days: ShippedDay[]; total: number; breakdown: ShippedBreakdown };

/** The containers of `tree` in tree order (each before what it holds), by ID. */
function containerOrder(
  tree: EngineTree | undefined,
): Map<string, { index: number; title: string }> {
  const order = new Map<string, { index: number; title: string }>();
  const walk = (node: EngineTree) => {
    if (node.type !== 'task') {
      order.set(node.id, { index: order.size, title: node.title });
    }
    for (const child of node.children) {
      walk(child);
    }
  };
  if (tree !== undefined) {
    walk(tree);
  }
  return order;
}

/**
 * What the scope shipped in the seven days ending today in `zone`, split one
 * level down. A task's parent is a phase or an initiative, so on a project the
 * split is by phase, a task directly under an initiative counted under that
 * initiative; on an initiative it is by phase, its direct tasks under its own
 * title. A phase lists its done tasks, most recent first, three at most. As on
 * Home, an abandoned task did not ship. Ties keep tree order.
 */
export function shippedSplit({
  rows,
  scope,
  tree,
  zone,
  now = Date.now(),
}: {
  rows: readonly ShippedTask[];
  scope: WorkScope;
  tree: EngineTree | undefined;
  zone: string;
  now?: number;
}): ShippedSplit {
  const { days: window } = lastSevenDays(zone, now);
  const inWindow = new Set(window);
  const shipped = rows
    .filter(
      (row) => row.task.status === 'done' && inWindow.has(dayOf(row.finishedAt.getTime(), zone)),
    )
    .toSorted((a, b) => b.finishedAt.getTime() - a.finishedAt.getTime());
  const days = shippedDays(
    shipped.map((row) => row.finishedAt),
    zone,
    now,
  );
  if (scope.kind === 'phase') {
    return {
      breakdown: { kind: 'tasks', rows: shipped.slice(0, SHIPPED_TASKS_CAP) },
      days,
      total: shipped.length,
    };
  }
  const order = containerOrder(tree);
  const counts = new Map<string, number>();
  for (const row of shipped) {
    const part = row.task.parent ?? scope.id;
    counts.set(part, (counts.get(part) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .map(([id, count]) => ({
      count,
      id,
      name: id === scope.id ? scope.title : (order.get(id)?.title ?? id),
    }))
    .toSorted(
      (a, b) =>
        b.count - a.count ||
        (order.get(a.id)?.index ?? Infinity) - (order.get(b.id)?.index ?? Infinity) ||
        a.id.localeCompare(b.id),
    );
  return { breakdown: { kind: 'parts', rows: parts }, days, total: shipped.length };
}

/**
 * When you have a minute, per scope: To groom (tasks and the containers to
 * break down alike), Seeds to triage (a project's only, since a seed belongs to
 * a project), Going cold, Waiting on others, and Record health findings (a
 * project's only). A project's Seeds to triage, Going cold, and Record health
 * rows open their lists; every other row is plain until its list exists.
 */
export function scopedMinuteRows({
  work,
  kind,
  project,
  untriaged,
  findings,
}: {
  work: Pick<WorkReport, 'frontier' | 'goingCold'>;
  kind: WorkScope['kind'];
  project: string;
  untriaged: number;
  findings: number;
}): MinuteRow[] {
  const toGroom = { count: work.frontier.toGroom.length, name: 'To groom' };
  const waiting = { count: work.frontier.waitingOnOthers.length, name: 'Waiting on others' };
  const cold = work.goingCold.length;
  if (kind !== 'project') {
    return [toGroom, { count: cold, name: 'Going cold' }, waiting];
  }
  return [
    toGroom,
    {
      count: untriaged,
      door: { list: 'seeds', project, show: 'to-triage' },
      name: 'Seeds to triage',
    },
    { count: cold, door: { list: 'tasks', project, show: 'going-cold' }, name: 'Going cold' },
    waiting,
    { count: findings, door: { list: 'doctor', project }, name: 'Record health findings' },
  ];
}

/** One part of a project or initiative: its status, title, and done over total. */
export type Part = { id: string; title: string; status: StatusWord; done: number; total: number };

/** A scope's parts, the live ones in tree order, the finished ones set apart for their fold. */
export type Parts = { noun: 'initiatives' | 'phases'; open: Part[]; finished: Part[] };

/** A part's rollup is finished when it is done or abandoned. */
const isFinished = (status: StatusWord) => status === 'done' || status === 'abandoned';

/**
 * Done over total across a part's direct children, as the sidebar's outline
 * counts them. An abandoned child is out of the total, so a finished part
 * reads N of N.
 */
function partOf(node: EngineTree): Part {
  const counted = node.children.filter((child) => child.status !== 'abandoned');
  return {
    done: counted.filter((child) => child.status === 'done').length,
    id: node.id,
    status: node.status,
    title: node.title,
    total: counted.length,
  };
}

/**
 * A project's initiatives or an initiative's phases, in tree order. An
 * initiative's direct tasks are not parts: they already appear above, and a
 * task appears once on a page. A phase, an initiative with no phases, and a
 * scope the tree does not hold (or has not read yet) have no parts.
 */
export function partsOf(tree: EngineTree | undefined, scope: string): Parts | undefined {
  const node = tree === undefined ? undefined : subtreeOf(tree, scope);
  if (node === undefined || (node.type !== 'project' && node.type !== 'initiative')) {
    return undefined;
  }
  const children = node.children.filter((child) => child.type !== 'task').map(partOf);
  if (children.length === 0) {
    return undefined;
  }
  return {
    finished: children.filter((part) => isFinished(part.status)),
    noun: node.type === 'project' ? 'initiatives' : 'phases',
    open: children.filter((part) => !isFinished(part.status)),
  };
}

/** The latest finish of a done task in the scope's subtree, or none when no task there was done. */
export function lastFinishedAt(tree: EngineTree | undefined, scope: string): Date | undefined {
  const node = tree === undefined ? undefined : subtreeOf(tree, scope);
  let latest: Date | undefined;
  const walk = (each: EngineTree) => {
    const at = each.completedAt;
    if (each.type === 'task' && each.status === 'done' && at != null) {
      latest = latest === undefined || at > latest ? at : latest;
    }
    for (const child of each.children) {
      walk(child);
    }
  };
  if (node !== undefined) {
    walk(node);
  }
  return latest;
}

/** Whole calendar days in `zone` from `from`'s day to `now`'s. */
function daysBetween(from: Date, now: number, zone: string): number {
  const day = (at: number) => Date.parse(`${dayOf(at, zone)}T00:00:00.000Z`);
  return Math.round((day(now) - day(from.getTime())) / 86_400_000);
}

/**
 * The one sentence that replaces Needs you, Now, Up next, and Shipped when all
 * four are empty, with when the last task in the scope finished, if one ever
 * did.
 */
export function quietSentence({
  lastFinished,
  zone,
  now = Date.now(),
}: {
  lastFinished: Date | undefined;
  zone: string;
  now?: number;
}): string {
  const quiet = 'Nothing is running, ready to start, or waiting on you.';
  if (lastFinished === undefined) {
    return quiet;
  }
  const days = daysBetween(lastFinished, now, zone);
  let when = `${String(days)} days ago`;
  if (days <= 0) {
    when = 'today';
  } else if (days === 1) {
    when = '1 day ago';
  }
  return `${quiet} The last task finished ${when}.`;
}

/**
 * An initiative or phase has Work when a task is under it (its rollup counts
 * one) or it has parts in the tree. Its rollup leaves out an idle open-ended
 * phase, so the parts are read from the tree.
 */
export function containerHasWork(record: EngineNode, tree: EngineTree | undefined): boolean {
  const tasks = Object.values(record.distribution ?? {}).some((count) => count > 0);
  return tasks || partsOf(tree, record.id) !== undefined;
}
