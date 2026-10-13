import type { WireArtifact, WireTreeNode } from '../api/types';
import { ancestorsOf, subtreeOf } from './ancestry';

/*
 * The pure derivations behind the work page (ADR 0013, MMR-467 refinement):
 * Shipped's day groups and per-day cap, whether the frontier has any row, and
 * the outline of initiatives and phases the shell's sidebar shows.
 */

/** Rows a Shipped day shows before its "N more" control. */
export const SHIPPED_DAY_CAP = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The calendar day of an instant in `zone`, `YYYY-MM-DD`. */
function dayOf(at: number, zone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: zone,
    year: 'numeric',
  }).format(at);
}

/** `Mon Oct 12` — the weekday and date of a `YYYY-MM-DD` day. */
function dayName(day: string): string {
  // The day is read as a UTC midnight and named in UTC, so no zone can move it.
  const parts = new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
    weekday: 'short',
  }).formatToParts(Date.parse(`${day}T00:00:00.000Z`));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('weekday')} ${part('month')} ${part('day')}`;
}

/** The day before a `YYYY-MM-DD` day. */
function dayBefore(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - DAY_MS).toISOString().slice(0, 10);
}

/** One Shipped day: its `YYYY-MM-DD` key, its label, and its rows newest first. */
export type ShippedDay<T> = { day: string; label: string; rows: T[] };

/**
 * Shipped rows grouped by the calendar day they finished in `zone`, newest day
 * first. The first two days read "Today · Mon Oct 12" and "Yesterday · Sun Oct
 * 11"; older days carry the date alone. Rows within a day are newest first.
 */
export function groupShippedByDay<T extends { finished_at: string }>(
  rows: readonly T[],
  zone: string,
  now = Date.now(),
): ShippedDay<T>[] {
  const today = dayOf(now, zone);
  const yesterday = dayBefore(today);
  const days = new Map<string, T[]>();
  for (const row of rows.toSorted(
    (a, b) => Date.parse(b.finished_at) - Date.parse(a.finished_at),
  )) {
    const day = dayOf(Date.parse(row.finished_at), zone);
    days.set(day, [...(days.get(day) ?? []), row]);
  }
  return [...days.entries()].map(([day, dayRows]) => {
    const name = dayName(day);
    let label = name;
    if (day === today) {
      label = `Today · ${name}`;
    } else if (day === yesterday) {
      label = `Yesterday · ${name}`;
    }
    return { day, label, rows: dayRows };
  });
}

/** The finish time of a Shipped row, 24-hour `HH:MM` in `zone`. */
export function shippedTime(iso: string, zone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    timeZone: zone,
  }).format(Date.parse(iso));
}

/** A Shipped day's visible rows and how many the cap hides; `expanded` lifts the cap. */
export function capDay<T>(rows: readonly T[], expanded: boolean): { shown: T[]; hidden: number } {
  if (expanded || rows.length <= SHIPPED_DAY_CAP) {
    return { hidden: 0, shown: [...rows] };
  }
  return { hidden: rows.length - SHIPPED_DAY_CAP, shown: rows.slice(0, SHIPPED_DAY_CAP) };
}

/** Does the frontier hold no row at all — not runnable, not one step off, not to groom, not waiting? */
export function frontierIsEmpty(frontier: {
  runnable: readonly unknown[];
  next_to_unlock: readonly { tasks: readonly unknown[] }[];
  to_groom: readonly unknown[];
  waiting_on_others: readonly unknown[];
}): boolean {
  return (
    frontier.runnable.length === 0 &&
    frontier.to_groom.length === 0 &&
    frontier.waiting_on_others.length === 0 &&
    frontier.next_to_unlock.every((g) => g.tasks.length === 0)
  );
}

/** What an outline row shows beside its title. */
export type OutlineTally =
  | { kind: 'counts'; done: number; total: number }
  | { kind: 'open_ended' }
  | { kind: 'parked' }
  | { kind: 'none' };

/**
 * Where an outline row sits against the open record: the record itself, or a
 * container above it.
 */
export type OutlineMark = 'current' | 'path';

/** One initiative or phase in the outline, at its nesting depth; or the open task. */
export type OutlineEntry = {
  id: string;
  title: string;
  status: WireTreeNode['status'];
  depth: number;
  tally: OutlineTally;
  mark?: OutlineMark;
};

export type ProjectOutline = {
  /** Live top-level containers and everything under them, in tree order. */
  entries: OutlineEntry[];
  /** Finished top-level initiatives, folded: how many, and their rows. */
  finished: { count: number; entries: OutlineEntry[] };
};

const isContainer = (node: WireTreeNode): boolean => node.type !== 'task';

/** A finished initiative: done or abandoned. */
const isFinished = (node: WireTreeNode): boolean =>
  node.type === 'initiative' && (node.status === 'done' || node.status === 'abandoned');

/**
 * Done over total across a node's direct children, tasks and containers alike.
 * An abandoned child is out of the total, so a finished container reads N/N.
 */
function childTally(node: WireTreeNode): { done: number; total: number } {
  const counted = node.children.filter((c) => c.status !== 'abandoned');
  return { done: counted.filter((c) => c.status === 'done').length, total: counted.length };
}

function tallyOf(node: WireTreeNode): OutlineTally {
  if (node.open_ended === true) {
    return { kind: 'open_ended' };
  }
  if (node.status === 'parked') {
    return { kind: 'parked' };
  }
  return { kind: 'counts', ...childTally(node) };
}

/** The open record and the containers above it. */
type Place = { currentId: string; pathIds: ReadonlySet<string> };

function markOf(id: string, place: Place | undefined): OutlineMark | undefined {
  if (place === undefined) {
    return undefined;
  }
  if (id === place.currentId) {
    return 'current';
  }
  return place.pathIds.has(id) ? 'path' : undefined;
}

/** A container and the containers under it, flattened in tree order. */
function flatten(node: WireTreeNode, depth: number, place: Place | undefined): OutlineEntry[] {
  return [
    {
      depth,
      id: node.id,
      mark: markOf(node.id, place),
      status: node.status,
      tally: tallyOf(node),
      title: node.title,
    },
    ...node.children.filter(isContainer).flatMap((c) => flatten(c, depth + 1, place)),
  ];
}

/**
 * The open task as a leaf row just under its nearest container, or first when
 * the project itself holds it. Unchanged when the container is not in `entries`.
 */
function withTaskRow(
  entries: OutlineEntry[],
  task: WireTreeNode,
  parentId: string | undefined,
): OutlineEntry[] {
  const at = parentId === undefined ? -1 : entries.findIndex((e) => e.id === parentId);
  if (parentId !== undefined && at === -1) {
    return entries;
  }
  const row: OutlineEntry = {
    depth: at === -1 ? 0 : (entries[at]?.depth ?? 0) + 1,
    id: task.id,
    mark: 'current',
    status: task.status,
    tally: { kind: 'none' },
    title: task.title,
  };
  return entries.toSpliced(at + 1, 0, row);
}

/**
 * The outline of a project tree: its initiatives and phases, never its tasks. A
 * top-level initiative that is finished (done or abandoned) folds apart from the
 * rest; a finished phase deeper down stays in place, so the live work reads in
 * context.
 *
 * With `openId`, the outline marks where that record sits: its own row is
 * `current` and the containers above it are `path`. A task is not an outline
 * row by nature, so the open one is listed under its nearest container.
 */
export function buildOutline(tree: WireTreeNode, openId?: string): ProjectOutline {
  const above = openId === undefined ? undefined : ancestorsOf(tree, openId);
  const open = openId === undefined ? undefined : subtreeOf(tree, openId);
  const place: Place | undefined =
    above === undefined || openId === undefined
      ? undefined
      : { currentId: openId, pathIds: new Set(above.map((a) => a.id)) };
  const top = tree.children.filter(isContainer);
  const finishedTop = top.filter(isFinished);
  let entries = top.filter((n) => !isFinished(n)).flatMap((n) => flatten(n, 0, place));
  let folded = finishedTop.flatMap((n) => flatten(n, 0, place));
  if (open !== undefined && !isContainer(open)) {
    const parentId = above?.at(-1)?.id;
    if (folded.some((e) => e.id === parentId)) {
      folded = withTaskRow(folded, open, parentId);
    } else {
      entries = withTaskRow(entries, open, parentId);
    }
  }
  return { entries, finished: { count: finishedTop.length, entries: folded } };
}

/** How many artifacts the project rail lists before pointing at the full browser. */
export const RAIL_ARTIFACT_CAP = 5;

/** The per-project sequence in an artifact id (`MMR-a12` is 12); 0 when the id has none. */
function artifactSeq(id: string): number {
  const match = /-a(\d+)$/.exec(id);
  return match === null ? 0 : Number(match[1]);
}

/**
 * The `limit` most recently created artifacts, newest first. Equal timestamps
 * break on the higher seq, matching the server list's `created_at desc, seq desc`.
 */
export function newestArtifacts(artifacts: readonly WireArtifact[], limit: number): WireArtifact[] {
  return artifacts
    .toSorted(
      (a, b) => b.created_at.localeCompare(a.created_at) || artifactSeq(b.id) - artifactSeq(a.id),
    )
    .slice(0, limit);
}
